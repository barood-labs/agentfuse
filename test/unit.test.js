'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { makePricer } = require('../src/pricing');
const { fromAnthropic, fromOpenAI, fromGemini, fromJSON, SSETap } = require('../src/usage');
const { Fuse } = require('../src/fuse');
const { parseArgs, inheritedUpstreams } = require('../src/cli');

test('pricing: exact versions, dated snapshots, OpenRouter ids', () => {
  const p = makePricer();
  assert.equal(p.lookup('claude-sonnet-4-5-20250929').key, 'claude-sonnet-4-5');
  assert.equal(p.lookup('claude-sonnet-4-20250514').key, 'claude-sonnet-4');
  assert.equal(p.lookup('claude-opus-4-6').key, 'claude-opus-4-6');
  assert.equal(p.lookup('anthropic/claude-opus-4.5').key, 'claude-opus-4-5');
  assert.equal(p.lookup('gpt-4o-mini-2024-07-18').key, 'gpt-4o-mini');
  assert.equal(p.lookup('gpt-4.1-mini').key, 'gpt-4.1-mini');
  assert.equal(p.lookup('models/gemini-2.5-pro').key, 'gemini-2.5-pro');
});

test('pricing: a NEWER version never silently inherits an older row', () => {
  const p = makePricer();
  for (const id of ['claude-opus-4-9', 'claude-opus-4-9-20270101', 'claude-sonnet-6', 'gpt-5.1', 'gpt-5-1', 'gemini-3-pro', 'totally-new-model']) {
    assert.equal(p.lookup(id).known, false, id);
  }
});

test('pricing: 5m vs 1h cache writes and cache reads', () => {
  const p = makePricer();
  const c = p.cost('claude-sonnet-4-5', { input: 1e4, output: 1e4, cacheWrite: 1e4, cacheWrite1h: 1e4, cacheRead: 1e4 });
  assert.ok(Math.abs(c.usd - (3 + 15 + 3.75 + 6 + 0.3) / 100) < 1e-9, c.usd);
  assert.deepEqual(fromAnthropic({ input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 300, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 } }),
    { input: 1, output: 1, cacheWrite: 100, cacheWrite1h: 200, cacheRead: 0 });
});

test('pricing: long-context tier applies to the whole request', () => {
  const p = makePricer();
  const small = p.cost('claude-sonnet-4-5', { input: 150000, output: 1000, cacheWrite: 0, cacheRead: 50000 });
  assert.equal(small.long, false);
  const big = p.cost('claude-sonnet-4-5', { input: 150000, output: 1000, cacheWrite: 0, cacheRead: 60000 });
  assert.equal(big.long, true);
  assert.ok(Math.abs(big.usd - (150000 * 6 + 1000 * 22.5 + 60000 * 0.6) / 1e6) < 1e-9);
  assert.equal(p.cost('claude-sonnet-4-6', { input: 900000, output: 0, cacheWrite: 0, cacheRead: 0 }).long, false); // 4.6+: flat 1M window
  assert.equal(p.cost('gemini-2.5-pro', { input: 300000, output: 0, cacheWrite: 0, cacheRead: 0 }).usd, 0.75);
});

test('pricing: unknown models are billed pessimistically, overrides and provider cost apply', () => {
  const p = makePricer({ 'my-local': { input: 0, output: 0 } });
  assert.equal(p.cost('my-local-7b', { input: 1e6, output: 1e6, cacheWrite: 0, cacheRead: 0 }).usd, 0);
  assert.ok(p.cost('mystery', { input: 1e6, output: 0, cacheWrite: 0, cacheRead: 0 }).usd >= 15);
  assert.equal(p.cost('anything', { input: 1e9, output: 0, cacheWrite: 0, cacheRead: 0, usd: 0.42 }).usd, 0.42);
});

test('usage: Gemini usageMetadata (thinking billed as output, cache split out)', () => {
  assert.deepEqual(fromGemini({ promptTokenCount: 1000, cachedContentTokenCount: 600, candidatesTokenCount: 50, thoughtsTokenCount: 25 }), { input: 400, output: 75, cacheWrite: 0, cacheRead: 600 });
  const tap = new SSETap('gemini');
  tap.write('data: {"candidates":[{"content":{"parts":[{"text":"abcdefgh"}]}}],"modelVersion":"gemini-2.5-flash"}\r\n\r\n');
  assert.equal(tap.live(0).output, 2); assert.equal(tap.seen, false);
  tap.write('data: {"candidates":[],"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":3},"modelVersion":"gemini-2.5-flash"}\r\n\r\n');
  assert.equal(tap.usage.output, 3); assert.equal(tap.model, 'gemini-2.5-flash');
});

test('usage: live output estimate from streamed text before usage arrives', () => {
  const tap = new SSETap('openai');
  tap.write('data: {"model":"gpt-4o","choices":[{"delta":{"content":"' + 'x'.repeat(400) + '"}}]}\n\n');
  tap.write('data: {"model":"gpt-4o","choices":[{"delta":{"tool_calls":[{"function":{"arguments":"' + 'y'.repeat(400) + '"}}]}}]}\n\n');
  assert.equal(tap.seen, false);
  assert.equal(tap.live(0).output, 200);
  const a = new SSETap('anthropic');
  a.write('data: {"type":"message_start","message":{"model":"claude-haiku-4-5","usage":{"input_tokens":5,"output_tokens":1}}}\n\n');
  a.write('data: {"type":"content_block_delta","delta":{"type":"thinking_delta","thinking":"' + 'z'.repeat(80) + '"}}\n\n');
  assert.equal(a.live(0).output, 20); assert.equal(a.completed(), false);
  a.write('data: {"type":"message_delta","usage":{"output_tokens":21}}\n\n');
  assert.equal(a.completed(), true); assert.equal(a.live(0).output, 21);
});

test('cli: inherits an existing gateway as upstream, ignores its own proxy URLs', () => {
  const u = inheritedUpstreams({ OPENAI_BASE_URL: 'https://openrouter.ai/api/v1', ANTHROPIC_BASE_URL: 'http://127.0.0.1:5555/anthropic', AGENTFUSE_GEMINI_UPSTREAM: 'http://g' });
  assert.deepEqual(u, { openai: 'https://openrouter.ai/api', gemini: 'http://g' });
});

test('usage: OpenAI cached tokens are not double counted', () => {
  assert.deepEqual(fromOpenAI({ prompt_tokens: 1000, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 800 } }), { input: 200, output: 50, cacheWrite: 0, cacheRead: 800 });
  assert.deepEqual(fromOpenAI({ input_tokens: 10, output_tokens: 5 }), { input: 10, output: 5, cacheWrite: 0, cacheRead: 0 });
  assert.deepEqual(fromAnthropic({ input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 5, cache_creation_input_tokens: 6 }), { input: 3, output: 4, cacheWrite: 6, cacheRead: 5 });
  assert.equal(fromJSON('anthropic', '{"model":"x","usage":{"input_tokens":1,"output_tokens":2}}').usage.output, 2);
  assert.equal(fromJSON('openai', 'not json'), null);
});

test('usage: Anthropic SSE across arbitrary chunk boundaries', () => {
  const s = 'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-haiku-4-5","usage":{"input_tokens":100,"cache_read_input_tokens":40,"output_tokens":1}}}\n\n' +
    'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":77}}\n\n';
  for (const size of [1, 7, 64, s.length]) {
    const tap = new SSETap('anthropic');
    for (let i = 0; i < s.length; i += size) tap.write(Buffer.from(s.slice(i, i + size)));
    assert.equal(tap.model, 'claude-haiku-4-5');
    assert.deepEqual(tap.usage, { input: 100, output: 77, cacheWrite: 0, cacheRead: 40 });
  }
});

test('usage: OpenAI chat + responses SSE with CRLF', () => {
  const tap = new SSETap('openai');
  tap.write('data: {"model":"gpt-5","choices":[]}\r\n\r\ndata: {"model":"gpt-5","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":3}}\r\n\r\ndata: [DONE]\r\n\r\n');
  assert.deepEqual(tap.usage, { input: 10, output: 3, cacheWrite: 0, cacheRead: 0 });
  const t2 = new SSETap('openai');
  t2.write('event: response.completed\ndata: {"type":"response.completed","response":{"model":"o3","usage":{"input_tokens":9,"output_tokens":1}}}\n\n');
  assert.equal(t2.model, 'o3'); assert.equal(t2.usage.input, 9);
});

test('fuse: ok -> warn -> blown, raise re-arms; daily includes prior spend', () => {
  const f = new Fuse({ cap: 1, warnAt: 0.8 });
  const states = []; f.on('state', (s) => states.push(s));
  f.commit(0.5); assert.equal(f.state, 'ok');
  f.commit(0.35); assert.equal(f.state, 'warn');
  f.commit(0.2); assert.equal(f.state, 'blown'); assert.match(f.reason, /session cap/);
  f.raise(1); assert.equal(f.state, 'ok');
  assert.deepEqual(states, ['warn', 'blown', 'ok']);
  const d = new Fuse({ cap: Infinity, daily: 10, baseDaily: 9.9 });
  d.commit(0.2); assert.equal(d.state, 'blown'); assert.match(d.reason, /daily/);
});

test('cli: arg parsing', () => {
  const o = parseArgs(['--cap', '$2.5', '--on-cap', 'pause', '-d', '10', '--no-preflight', '--', 'claude', '--model', 'x']);
  assert.equal(o.preflight, false);
  assert.equal(o.cap, 2.5); assert.equal(o.onCap, 'pause'); assert.equal(o.daily, 10);
  assert.deepEqual(o.cmd, ['claude', '--model', 'x']);
  assert.throws(() => parseArgs(['--on-cap', 'explode']));
  assert.throws(() => parseArgs(['--cap', 'lots']));
});

test('fuse: parallel in-flight requests are summed, not overwritten', () => {
  const f = new Fuse({ cap: 1 });
  f.setInflight(1, 0.4); f.setInflight(2, 0.4);
  assert.ok(Math.abs(f.inflight - 0.8) < 1e-12);
  f.commit(1, 0.45); // one finishes; the other is still counted
  assert.ok(Math.abs(f.spent + f.inflight - 0.85) < 1e-12);
  f.setInflight(2, 0.6); assert.equal(f.state, 'blown');
});
