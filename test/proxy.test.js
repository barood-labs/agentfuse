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
  const px = await startProxy({ fuse, pricer: makePricer(), ledger, onCap: opts.onCap || 'block', upstreams: { anthropic: up.url, openai: up.url }, session: 's1', repo: '/r', strict: opts.strict ?? true });
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
  const r = await rig({ cap: 0.01, onCap: 'pause' }, { inputTokens: 100000, outputTokens: 0 });
  await (await post(`${r.px.url}/anthropic/v1/messages`, { model: 'claude-sonnet-4-5', messages: [] })).text();
  await new Promise((s) => setTimeout(s, 20));
  let done = false;
  const p = post(`${r.px.url}/anthropic/v1/messages`, { model: 'claude-sonnet-4-5', messages: [] }).then((x) => { done = true; return x; });
  await new Promise((s) => setTimeout(s, 150));
  assert.equal(done, false);
  assert.equal((await (await fetch(`${r.px.url}/_agentfuse/status`)).json()).paused, 1);
  const raised = await (await post(`${r.px.url}/_agentfuse/raise`, { usd: 5 })).json();
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
  assert.ok(rec.spent >= 0.5 && rec.spent < 0.75, `spent ${rec.spent}`);
});

test('CLI passes through the child exit code when under budget', async () => {
  const home = tmp();
  const bin = path.join(__dirname, '..', 'bin', 'agentfuse.js');
  const code = await new Promise((resolve) => execFile(process.execPath, [bin, '--quiet', '--', process.execPath, '-e', 'process.exit(process.env.ANTHROPIC_BASE_URL.endsWith("/anthropic") ? 7 : 1)'], { env: { ...process.env, AGENTFUSE_HOME: home } }, (err) => resolve(err ? err.code : 0)));
  assert.equal(code, 7);
});
