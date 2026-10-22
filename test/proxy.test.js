'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs'); const os = require('os'); const path = require('path');
const { execFile } = require('child_process');
const mock = require('../examples/mock-upstream');
const { startProxy } = require('../src/proxy');
const { Fuse } = require('../src/fuse');
const { makePricer } = require('../src/pricing');
const { Ledger } = require('../src/ledger');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'agentfuse-test-'));
async function rig(opts = {}, mockOpts = {}) {
  const up = await mock.start(mockOpts);
  const fuse = new Fuse({ cap: opts.cap ?? 1 });
  const ledger = new Ledger(tmp());
  const px = await startProxy({ fuse, pricer: makePricer(), ledger, onCap: opts.onCap || 'block', upstreams: { anthropic: up.url, openai: up.url, gemini: up.url, openrouter: up.url }, session: 's1', repo: '/r', strict: opts.strict ?? true, preflight: opts.preflight ?? true, token: opts.token });
  return { up, fuse, ledger, px, close: async () => { await px.close(); await up.close(); } };
}
const post = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('anthropic JSON: passthrough, headers forwarded, cost metered + ledgered', async () => {
  const r = await rig({}, { inputTokens: 1000, outputTokens: 100 });
  const res = await post(`${r.px.url}/anthropic/v1/messages`, { model: 'claude-sonnet-4-5', messages: [] }, { 'x-api-key': 'k' });
  const j = await res.json();
  assert.equal(res.status, 200); assert.equal(j.id, 'msg_mock');
  assert.equal(r.up.server.lastRequest.headers['x-api-key'], 'k');
  await new Promise((s) => setTimeout(s, 20));
  assert.ok(Math.abs(r.fuse.spent - (1000 * 3 + 100 * 15) / 1e6) < 1e-12);
  assert.equal(r.ledger.read().length, 1);
  await r.close();
});

test('anthropic stream: bytes pass through unchanged and usage is metered', async () => {
  const r = await rig({}, { inputTokens: 2000, outputTokens: 500 });
  const res = await post(`${r.px.url}/anthropic/v1/messages`, { model: 'claude-haiku-4-5', stream: true, messages: [] });
  const text = await res.text();
  assert.match(text, /message_stop/);
  await new Promise((s) => setTimeout(s, 20));
  assert.ok(Math.abs(r.fuse.spent - (2000 * 1 + 500 * 5) / 1e6) < 1e-12);
  await r.close();
});

test('openai chat stream: proxy injects include_usage so streams are metered', async () => {
  const r = await rig({}, { inputTokens: 1000, outputTokens: 1000, cacheRead: 1000 });
  const res = await post(`${r.px.url}/openai/v1/chat/completions`, { model: 'gpt-4o', stream: true, messages: [] });
  await res.text();
  assert.equal(r.up.server.lastRequest.body.stream_options.include_usage, true);
  await new Promise((s) => setTimeout(s, 20));
  assert.ok(Math.abs(r.fuse.spent - (1000 * 2.5 + 1000 * 10 + 1000 * 1.25) / 1e6) < 1e-12);
  await r.close();
});

test('openai responses API stream is metered', async () => {
  const r = await rig({}, { inputTokens: 1e6, outputTokens: 0 });
  await (await post(`${r.px.url}/openai/v1/responses`, { model: 'gpt-5', stream: true, input: 'hi' })).text();
  await new Promise((s) => setTimeout(s, 20));
  assert.ok(Math.abs(r.fuse.spent - 1.25) < 1e-9);
  await r.close();
});

test('blown fuse returns provider-shaped 402 and never reaches upstream', async () => {
  const r = await rig({ cap: 0.01 }, { inputTokens: 100000, outputTokens: 0 });
  await (await post(`${r.px.url}/anthropic/v1/messages`, { model: 'claude-sonnet-4-5', messages: [] })).text();
  await new Promise((s) => setTimeout(s, 20));
  assert.equal(r.fuse.state, 'blown');
  r.up.server.lastRequest = null;
  const res = await post(`${r.px.url}/anthropic/v1/messages`, { model: 'claude-sonnet-4-5', messages: [] });
  assert.equal(res.status, 402);
  assert.equal((await res.json()).error.type, 'budget_exceeded');
  assert.equal(r.up.server.lastRequest, null);
  const o = await post(`${r.px.url}/openai/v1/chat/completions`, { model: 'gpt-4o', messages: [] });
  assert.equal((await o.json()).error.code, 'budget_exceeded');
  await r.close();
});

test('strict mode cuts a stream that crosses the cap', async () => {
  const r = await rig({ cap: 0.05 }, { inputTokens: 100000, outputTokens: 10 });
  const text = await (await post(`${r.px.url}/anthropic/v1/messages`, { model: 'claude-sonnet-4-5', stream: true, messages: [] })).text();
  assert.match(text, /stream cut/);
  assert.doesNotMatch(text, /message_stop/);
  await new Promise((s) => setTimeout(s, 20));
  assert.equal(r.ledger.read()[0].cut, true);
  await r.close();
});

test('pause mode holds requests until raise', async () => {
  const r = await rig({ cap: 0.01, onCap: 'pause', token: 't0k' }, { inputTokens: 100000, outputTokens: 0 });
  await (await post(`${r.px.url}/anthropic/v1/messages`, { model: 'claude-sonnet-4-5', messages: [] })).text();
  await new Promise((s) => setTimeout(s, 20));
  let done = false;
  const p = post(`${r.px.url}/anthropic/v1/messages`, { model: 'claude-sonnet-4-5', messages: [] }).then((x) => { done = true; return x; });
  await new Promise((s) => setTimeout(s, 150));
  assert.equal(done, false);
  assert.equal((await (await fetch(`${r.px.url}/_agentfuse/status`)).json()).paused, 1);
  const raised = await (await post(`${r.px.url}/_agentfuse/raise`, { usd: 5 }, { 'x-agentfuse-token': 't0k' })).json();
  assert.equal(raised.state, 'ok');
  assert.equal((await p).status, 200);
  await r.close();
});

test('end-to-end CLI: kills a runaway agent and exits 86 with a receipt', async () => {
  const up = await mock.start({ inputTokens: 30000, outputTokens: 2500 });
  const home = tmp();
  const bin = path.join(__dirname, '..', 'bin', 'agentfuse.js');
  const agent = path.join(__dirname, '..', 'examples', 'runaway-agent.js');
  const { code, stderr } = await new Promise((resolve) => {
    execFile(process.execPath, [bin, '--cap', '0.5', '--receipt', path.join(home, 'r.json'), '--', process.execPath, agent], { env: { ...process.env, NO_COLOR: '1', DELAY_MS: '5', AGENTFUSE_HOME: home, AGENTFUSE_ANTHROPIC_UPSTREAM: up.url }, timeout: 20000 }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stderr }));
  });
  await up.close();
  assert.equal(code, 86, stderr);
  assert.match(stderr, /FUSE BLOWN/);
  const rec = JSON.parse(fs.readFileSync(path.join(home, 'r.json'), 'utf8'));
  assert.equal(rec.killedByFuse, true);
  assert.ok(rec.spent <= 0.5 && rec.spent > 0.3, `spent ${rec.spent}`); // pre-flight: never over the cap
  assert.match(stderr, /would exceed/);
});

test('CLI passes through the child exit code when under budget', async () => {
  const home = tmp();
  const bin = path.join(__dirname, '..', 'bin', 'agentfuse.js');
  const code = await new Promise((resolve) => execFile(process.execPath, [bin, '--quiet', '--', process.execPath, '-e', 'process.exit(process.env.ANTHROPIC_BASE_URL.endsWith("/anthropic") ? 7 : 1)'], { env: { ...process.env, AGENTFUSE_HOME: home } }, (err) => resolve(err ? err.code : 0)));
  assert.equal(code, 7);
});

const settle = () => new Promise((s) => setTimeout(s, 30));

test('realistic stream (usage only at the end): Anthropic output is cut on the live estimate', async () => {
  // 200 deltas x 400 chars = ~20k output tokens = $0.30 on Sonnet; cap $0.10. Usage would only say so at the end.
  const r = await rig({ cap: 0.1, preflight: false }, { inputTokens: 1000, outputTokens: 20000, chunks: 200, chunkChars: 400, delayMs: 1 });
  const text = await (await post(`${r.px.url}/anthropic/v1/messages`, { model: 'claude-sonnet-4-5', stream: true, messages: [] })).text();
  assert.match(text, /stream cut/); assert.doesNotMatch(text, /message_delta/);
  await settle();
  const rec = r.ledger.read()[0];
  assert.equal(rec.cut, true);
  assert.ok(rec.usd >= 0.1 && rec.usd < 0.12, `billed ${rec.usd}`); // stopped right at the cap, billed the estimate
  await r.close();
});

test('realistic stream: OpenAI chat with usage only in the last chunk is cut on the estimate', async () => {
  const r = await rig({ cap: 0.05, preflight: false }, { inputTokens: 100, outputTokens: 30000, chunks: 300, chunkChars: 400, delayMs: 1 });
  const text = await (await post(`${r.px.url}/openai/v1/chat/completions`, { model: 'gpt-4o', stream: true, messages: [] })).text();
  assert.match(text, /stream cut/); assert.doesNotMatch(text, /\[DONE\]/);
  await settle();
  assert.ok(r.fuse.spent >= 0.05 && r.fuse.spent < 0.06, `spent ${r.fuse.spent}`);
  await r.close();
});

test('gemini: generateContent + streamGenerateContent are metered, model taken from the URL', async () => {
  const r = await rig({}, { inputTokens: 1e5, outputTokens: 1e4 });
  const res = await post(`${r.px.url}/gemini/v1beta/models/gemini-2.5-flash:generateContent`, { contents: [] }, { 'x-goog-api-key': 'k' });
  assert.equal(res.status, 200); await res.text(); await settle();
  assert.ok(Math.abs(r.fuse.spent - (1e5 * 0.3 + 1e4 * 2.5) / 1e6) < 1e-9);
  assert.equal(r.up.server.lastRequest.headers['x-goog-api-key'], 'k');
  await (await post(`${r.px.url}/gemini/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse`, { contents: [] })).text(); await settle();
  assert.equal(r.ledger.read()[1].model, 'gemini-2.5-pro');
  await r.close();
});

test('gemini: blocked responses use the Google error shape', async () => {
  const r = await rig({ cap: 0.000001 }, { inputTokens: 1e5 });
  await (await post(`${r.px.url}/gemini/v1beta/models/gemini-2.5-flash:generateContent`, { contents: [] })).text(); await settle();
  const res = await post(`${r.px.url}/gemini/v1beta/models/gemini-2.5-flash:generateContent`, { contents: [] });
  assert.equal(res.status, 402); assert.equal((await res.json()).error.status, 'RESOURCE_EXHAUSTED');
  await r.close();
});

test('openrouter: asks for usage accounting and bills the provider-reported cost', async () => {
  const r = await rig({}, { inputTokens: 1e6, outputTokens: 0, cost: 0.0123 });
  await (await post(`${r.px.url}/openrouter/v1/chat/completions`, { model: 'anthropic/claude-sonnet-4.5', messages: [] })).text(); await settle();
  assert.equal(r.up.server.lastRequest.body.usage.include, true);
  assert.equal(r.fuse.spent, 0.0123);
  await r.close();
});

test('pre-flight: refuses the request that would cross the cap, so spend never exceeds it', async () => {
  const r = await rig({ cap: 0.25 }, { inputTokens: 30000, outputTokens: 0 }); // $0.09 per request on Sonnet
  const statuses = [];
  for (let i = 0; i < 5; i++) { const res = await post(`${r.px.url}/anthropic/v1/messages`, { model: 'claude-sonnet-4-5', messages: [] }); statuses.push(res.status); await res.text(); await settle(); }
  assert.deepEqual(statuses, [200, 200, 402, 402, 402]);
  assert.ok(r.fuse.spent <= 0.25, `spent ${r.fuse.spent}`);
  assert.match(r.fuse.reason, /would exceed/);
  await r.close();
});

test('parallel streams: each in-flight request is tracked separately', async () => {
  const r = await rig({ cap: 100, preflight: false }, { inputTokens: 10, outputTokens: 10, chunks: 40, chunkChars: 400, delayMs: 5 });
  let peak = 0; r.fuse.on('tick', () => { peak = Math.max(peak, r.fuse.inflight); });
  await Promise.all([1, 2, 3].map(() => post(`${r.px.url}/openai/v1/chat/completions`, { model: 'gpt-4o', stream: true, messages: [] }).then((x) => x.text())));
  await settle();
  const single = (40 * 400 / 4) * 10 / 1e6; // one stream's full live output estimate
  assert.ok(peak > single * 1.5, `peak in-flight ${peak} should reflect >1 concurrent stream (${single})`);
  assert.equal(r.fuse.inflight, 0);
  await r.close();
});

test('client abort mid-stream is still billed (estimate), never dropped', async () => {
  const r = await rig({ cap: 100, preflight: false }, { inputTokens: 10, outputTokens: 10, chunks: 200, chunkChars: 400, delayMs: 3 });
  const ac = new AbortController();
  const res = await fetch(`${r.px.url}/openai/v1/chat/completions`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: 'gpt-4o', stream: true }), signal: ac.signal });
  const reader = res.body.getReader(); await reader.read(); await reader.read();
  await new Promise((s) => setTimeout(s, 60)); ac.abort();
  await new Promise((s) => setTimeout(s, 100));
  assert.ok(r.fuse.spent > 0, 'aborted stream must be billed');
  assert.equal(r.fuse.inflight, 0);
  await r.close();
});

test('raise endpoint requires the session token and rejects browser origins', async () => {
  const r = await rig({ token: 'secret-t' });
  assert.equal((await post(`${r.px.url}/_agentfuse/raise`, { usd: 5 })).status, 401);
  assert.equal((await post(`${r.px.url}/_agentfuse/raise`, { usd: 5 }, { 'x-agentfuse-token': 'nope' })).status, 401);
  assert.equal((await post(`${r.px.url}/_agentfuse/raise`, { usd: 5 }, { 'x-agentfuse-token': 'secret-t', origin: 'https://evil.example' })).status, 403);
  assert.equal((await post(`${r.px.url}/_agentfuse/raise`, { usd: 5 }, { 'x-agentfuse-token': 'secret-t' })).status, 200);
  await r.close();
});
