'use strict';
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { fromJSON, SSETap } = require('./usage');

const DEFAULT_UPSTREAMS = {
  anthropic: process.env.AGENTFUSE_ANTHROPIC_UPSTREAM || 'https://api.anthropic.com',
  openai: process.env.AGENTFUSE_OPENAI_UPSTREAM || 'https://api.openai.com',
};
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length', 'accept-encoding']);

function blockedBody(provider, msg) {
  return provider === 'anthropic'
    ? { type: 'error', error: { type: 'budget_exceeded', message: `agentfuse: ${msg}` } }
    : { error: { message: `agentfuse: ${msg}`, type: 'budget_exceeded', code: 'budget_exceeded' } };
}

/**
 * Start the metering proxy.
 *   /anthropic/*  -> Anthropic Messages API
 *   /openai/*     -> OpenAI-compatible API (chat/completions, responses, completions)
 *   /_agentfuse/status (GET), /_agentfuse/raise (POST {"usd":5})
 * onCap: 'block' -> 402 every request once blown; 'pause' -> hold requests until raised;
 *        'kill' -> same as block for the proxy (the CLI kills the child).
 * Mid-stream: if a single response pushes spend past the cap, the stream is cut (strict).
 */
function startProxy({ fuse, pricer, ledger, onCap = 'kill', upstreams = {}, port = 0, host = '127.0.0.1', session, repo, strict = true, log = () => {} }) {
  const ups = { ...DEFAULT_UPSTREAMS, ...upstreams };
  const waiters = [];
  fuse.on('state', (s) => { if (s !== 'blown') while (waiters.length) waiters.shift()(); });

  const server = http.createServer(async (req, res) => {
    try {
      if (req.url.startsWith('/_agentfuse/')) return control(req, res);
      const m = /^\/(anthropic|openai)(\/.*)?$/.exec(req.url);
      if (!m) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'agentfuse: use /anthropic/* or /openai/*' })); }
      const provider = m[1]; const rest = m[2] || '/';
      let body = await readBody(req);

      if (fuse.isBlown()) {
        if (onCap === 'pause') {
          log(`paused request ${rest} — run \`agentfuse raise <usd>\` to continue`);
          await new Promise((r) => waiters.push(r));
        } else return deny(res, provider, fuse.reason);
      }

      // Make OpenAI chat streams report usage so we can meter them.
      let streamReq = false;
      if (body.length && /json/.test(req.headers['content-type'] || '')) {
        try {
          const j = JSON.parse(body.toString('utf8'));
          streamReq = !!j.stream;
          if (provider === 'openai' && j.stream && /chat\/completions|\/completions$/.test(rest)) {
            j.stream_options = { ...(j.stream_options || {}), include_usage: true };
            body = Buffer.from(JSON.stringify(j));
          }
        } catch { /* pass through untouched */ }
      }

      const target = new URL(ups[provider].replace(/\/$/, '') + rest);
      const headers = {};
      for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k.toLowerCase())) headers[k] = v;
      headers['accept-encoding'] = 'identity';
      if (body.length) headers['content-length'] = body.length;
      const lib = target.protocol === 'https:' ? https : http;

      const up = lib.request(target, { method: req.method, headers }, (ur) => {
        const isSSE = /text\/event-stream/.test(ur.headers['content-type'] || '') || streamReq;
        const outHeaders = {};
        for (const [k, v] of Object.entries(ur.headers)) if (!HOP.has(k.toLowerCase()) || k === 'content-length') outHeaders[k] = v;
        res.writeHead(ur.statusCode, outHeaders);
        const finish = (model, usage, cut) => {
          if (!usage) { fuse.setInflight(0); return; }
          const c = pricer.cost(model, usage);
          fuse.commit(c.usd);
          const rec = { ts: new Date().toISOString(), session, repo, provider, model: model || 'unknown', priceKnown: c.known, ...usage, usd: +c.usd.toFixed(6), path: rest, status: ur.statusCode, cut: !!cut };
          if (ledger) ledger.append(rec);
          log(rec);
        };
        if (isSSE) {
          const tap = new SSETap(provider);
          let cut = false;
          tap.onUpdate = () => {
            const live = pricer.cost(tap.model, tap.usage).usd;
            fuse.setInflight(live);
            if (strict && !cut && fuse.isBlown()) {
              cut = true;
              res.write(`event: error\ndata: ${JSON.stringify(blockedBody(provider, fuse.reason + ' (stream cut)'))}\n\n`);
              ur.destroy(); res.end();
              finish(tap.model, tap.usage, true);
            }
          };
          ur.on('data', (c) => { if (cut) return; tap.write(c); if (!cut) res.write(c); });
          ur.on('end', () => { if (cut) return; res.end(); finish(tap.model, tap.seen ? tap.usage : null); });
          ur.on('error', () => { if (!cut) { res.end(); finish(tap.model, tap.seen ? tap.usage : null); } });
        } else {
          const chunks = [];
          ur.on('data', (c) => { chunks.push(c); res.write(c); });
          ur.on('end', () => { res.end(); const u = fromJSON(provider, Buffer.concat(chunks).toString('utf8')); finish(u && u.model, u && u.usage); });
        }
      });
      up.on('error', (e) => { if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: `agentfuse upstream error: ${e.message}` } })); });
      up.end(body);
    } catch (e) {
      if (!res.headersSent) res.writeHead(500); res.end(String(e && e.message));
    }
  });

  function deny(res, provider, reason) {
    res.writeHead(402, { 'content-type': 'application/json', 'x-agentfuse': 'blown' });
    res.end(JSON.stringify(blockedBody(provider, `budget exceeded — ${reason}`)));
  }
  async function control(req, res) {
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url === '/_agentfuse/status') return send(200, status());
    if (req.url === '/_agentfuse/raise' && req.method === 'POST') {
      let usd = NaN; try { usd = Number(JSON.parse((await readBody(req)).toString()).usd); } catch {}
      if (!(usd > 0)) return send(400, { error: 'body must be {"usd": <positive number>}' });
      fuse.raise(usd); return send(200, status());
    }
    send(404, { error: 'unknown control endpoint' });
  }
  function status() {
    return { session, repo, state: fuse.state, reason: fuse.reason, spent: fuse.spent, requests: fuse.requests, limits: fuse.limits(), paused: waiters.length };
  }

  return new Promise((resolve) => server.listen(port, host, () => {
    const a = server.address();
    resolve({ server, port: a.port, url: `http://${host}:${a.port}`, status, close: () => new Promise((r) => { while (waiters.length) waiters.shift()(); server.closeAllConnections && server.closeAllConnections(); server.close(() => r()); }) });
  }));
}

function readBody(req) {
  return new Promise((resolve, reject) => { const c = []; req.on('data', (d) => c.push(d)); req.on('end', () => resolve(Buffer.concat(c))); req.on('error', reject); });
}

module.exports = { startProxy, blockedBody };
