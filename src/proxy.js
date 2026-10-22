'use strict';
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { fromJSON, SSETap, family } = require('./usage');
let reqSeq = 0;

const DEFAULT_UPSTREAMS = {
  anthropic: process.env.AGENTFUSE_ANTHROPIC_UPSTREAM || 'https://api.anthropic.com',
  openai: process.env.AGENTFUSE_OPENAI_UPSTREAM || 'https://api.openai.com',
  gemini: process.env.AGENTFUSE_GEMINI_UPSTREAM || 'https://generativelanguage.googleapis.com',
  openrouter: process.env.AGENTFUSE_OPENROUTER_UPSTREAM || 'https://openrouter.ai/api',
};
const HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host', 'content-length', 'accept-encoding']);

function blockedBody(provider, msg) {
  if (provider === 'gemini') return { error: { code: 402, message: `agentfuse: ${msg}`, status: 'RESOURCE_EXHAUSTED' } };
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
function startProxy({ fuse, pricer, ledger, onCap = 'kill', upstreams = {}, port = 0, host = '127.0.0.1', session, repo, strict = true, preflight = true, token = null, log = () => {} }) {
  const lastCost = new Map(); // model -> cost of the most recent completed request
  const warnedUnknown = new Set();
  const lastInputCost = new Map(); // model -> input-side cost of the most recent request
  const ups = { ...DEFAULT_UPSTREAMS, ...upstreams };
  const waiters = [];
  fuse.on('state', (s) => { if (s !== 'blown') while (waiters.length) waiters.shift()(); });

  const server = http.createServer(async (req, res) => {
    try {
      if (req.url.startsWith('/_agentfuse/')) return control(req, res);
      const m = /^\/(anthropic|openai|gemini|openrouter)(\/.*)?$/.exec(req.url);
      if (!m) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: 'agentfuse: use /anthropic/*, /openai/*, /gemini/* or /openrouter/*' })); }
      const provider = m[1]; const rest = m[2] || '/';
      let body = await readBody(req);

      if (fuse.isBlown()) {
        if (onCap === 'pause') {
          log(`paused request ${rest} — run \`agentfuse raise <usd>\` to continue`);
          await new Promise((r) => waiters.push(r));
        } else return deny(res, provider, fuse.reason);
      }

      // Make OpenAI chat streams report usage so we can meter them.
      let streamReq = /:streamGenerateContent/.test(rest);
      let reqModel = (/\/models\/([^/:?]+)/.exec(rest) || [])[1] || null; // Gemini puts the model in the URL
      let maxOut = null;
      if (body.length && /json/.test(req.headers['content-type'] || '')) {
        try {
          const j = JSON.parse(body.toString('utf8'));
          streamReq = streamReq || !!j.stream;
          reqModel = j.model || reqModel;
          maxOut = j.max_tokens ?? j.max_completion_tokens ?? j.max_output_tokens ?? (j.generationConfig && j.generationConfig.maxOutputTokens) ?? null;
          let changed = false;
          if (family(provider) === 'openai' && j.stream && /chat\/completions|\/completions$/.test(rest)) {
            j.stream_options = { ...(j.stream_options || {}), include_usage: true }; changed = true;
          }
          if ((provider === 'openrouter' || (provider === 'openai' && /openrouter\.ai/.test(ups.openai))) && !(j.usage && j.usage.include)) { j.usage = { ...(j.usage || {}), include: true }; changed = true; }
          if (changed) body = Buffer.from(JSON.stringify(j));
        } catch { /* pass through untouched */ }
      }

      // Pre-flight: refuse a request that would most likely push spend past a cap.
      // Estimate = cost of the last request to this model (agent turns are similar and grow),
      // or, with no history, the prompt bytes priced as uncached input.
      const rid = ++reqSeq;
      const isModelCall = req.method === 'POST' && body.length > 0;
      if (preflight && isModelCall) {
        const est = estimate(reqModel, body.length);
        const over = fuse.wouldExceed(est);
        if (!over) fuse.setInflight(rid, est);
        else {
          const reason = `next request (~$${est.toFixed(3)}) would exceed the $${over.cap.toFixed(2)} ${over.name} cap`;
          fuse.trip(reason);
          if (onCap === 'pause') {
            await new Promise((r) => waiters.push(r));
            fuse.setInflight(rid, estimate(reqModel, body.length));
          } else return deny(res, provider, reason);
        }
      }

      const target = new URL(ups[provider].replace(/\/$/, '') + rest);
      req.on('close', () => { if (!res.writableEnded) fuse.release(rid); });
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
        let finished = false;
        const finish = (model, usage, cut) => {
          if (finished) return; finished = true;
          model = model || reqModel;
          if (!usage) { fuse.release(rid); return; }
          const c = pricer.cost(model, usage);
          lastCost.set(model, c.usd);
          lastInputCost.set(model, pricer.cost(model, { ...usage, output: 0, usd: undefined }).usd);
          fuse.commit(rid, c.usd);
          const rec = { ts: new Date().toISOString(), session, repo, provider, model: model || 'unknown', priceKnown: c.known, ...usage, usd: +c.usd.toFixed(6), path: rest, status: ur.statusCode, cut: !!cut };
          if (ledger) ledger.append(rec);
          if (!c.known && !warnedUnknown.has(rec.model)) { warnedUnknown.add(rec.model); log(`unknown price for "${rec.model}": billing at the high fallback rate (add it with --prices)`); }
          log(rec);
        };
        if (isSSE) {
          const tap = new SSETap(provider);
          let cut = false; let liveUsd = 0;
          const promptBytes = body.length;
          tap.onUpdate = () => {
            // Live estimate: real usage where reported, plus streamed-chars/4 for output that the
            // provider hasn't reported yet, plus (if input isn't reported yet) the last turn's input cost.
            const m = tap.model || reqModel;
            const u = tap.live(0);
            const outCost = pricer.cost(m, { input: 0, output: u.output, cacheWrite: 0, cacheRead: 0 }).usd;
            let inCost;
            if (tap.inputSeen) inCost = pricer.cost(m, { ...u, output: 0 }).usd;
            else inCost = lastInputCost.has(m) ? lastInputCost.get(m) : (promptBytes / 4) * pricer.lookup(m).price.input / 1e6;
            fuse.setInflight(rid, inCost + outCost);
            liveUsd = inCost + outCost;
            if (strict && !cut && fuse.isBlown()) {
              cut = true;
              res.write(`event: error\ndata: ${JSON.stringify(blockedBody(provider, fuse.reason + ' (stream cut)'))}\n\n`);
              ur.destroy(); res.end();
              // Bill the estimate: the provider never sent final usage for a stream we cut.
              finish(tap.model, { ...tap.live(0), usd: liveUsd }, true);
            }
          };
          ur.on('data', (c) => { if (cut) return; tap.write(c); if (!cut) res.write(c); });
          // If the stream ends without final usage (aborted, upstream error), bill the live estimate so we never under-count.
          const settle = () => finish(tap.model, tap.seen && tap.inputSeen && !tap.partial ? tap.usage : (liveUsd > 0 ? { ...tap.live(0), usd: liveUsd } : null));
          ur.on('end', () => { if (cut) return; res.end(); tap.partial = !tap.completed(); settle(); });
          ur.on('error', () => { if (cut) return; res.end(); tap.partial = true; settle(); });
          res.on('close', () => { if (!finished) { tap.partial = true; ur.destroy(); settle(); } });
        } else {
          const chunks = [];
          ur.on('data', (c) => { chunks.push(c); res.write(c); });
          ur.on('end', () => { res.end(); const u = fromJSON(provider, Buffer.concat(chunks).toString('utf8')); finish(u && u.model, u && u.usage); });
        }
      });
      up.on('error', (e) => { fuse.release(rid); if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: { message: `agentfuse upstream error: ${e.message}` } })); });
      up.end(body);
    } catch (e) {
      if (!res.headersSent) res.writeHead(500); res.end(String(e && e.message));
    }
  });

  function estimate(model, bytes) {
    for (const [m, c] of lastCost) if (m === model || (model && m.startsWith(model))) return c;
    const p = pricer.lookup(model).price;
    return (bytes / 4) * p.input / 1e6;
  }
  function deny(res, provider, reason) {
    res.writeHead(402, { 'content-type': 'application/json', 'x-agentfuse': 'blown' });
    res.end(JSON.stringify(blockedBody(provider, `budget exceeded — ${reason}`)));
  }
  async function control(req, res) {
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    if (req.url === '/_agentfuse/status') return send(200, status());
    if (req.url === '/_agentfuse/raise' && req.method === 'POST') {
      // Raising the budget needs the per-session token (stored 0600 in ~/.agentfuse/sessions), so another
      // local process or a web page can't silently lift your cap.
      if (token && req.headers['x-agentfuse-token'] !== token) return send(401, { error: 'missing or wrong x-agentfuse-token' });
      if (req.headers.origin) return send(403, { error: 'browser requests are not allowed' });
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
