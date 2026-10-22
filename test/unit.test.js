'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { makePricer } = require('../src/pricing');
const { fromAnthropic, fromOpenAI, fromJSON, SSETap } = require('../src/usage');
const { Fuse } = require('../src/fuse');
const { parseArgs } = require('../src/cli');

test('pricing: longest prefix wins and dated snapshots resolve', () => {
  const p = makePricer();
  assert.equal(p.lookup('claude-sonnet-4-5-20250929').key, 'claude-sonnet-4');
  assert.equal(p.lookup('gpt-4o-mini-2024-07-18').key, 'gpt-4o-mini');
  assert.equal(p.lookup('anthropic/claude-opus-4-5').key, 'claude-opus-4-5');
  assert.equal(p.lookup('totally-new-model').known, false);
});

test('pricing: cost includes cache read/write at their own rates', () => {
  const p = makePricer();
  const c = p.cost('claude-sonnet-4-5', { input: 1e6, output: 1e6, cacheWrite: 1e6, cacheRead: 1e6 });
  assert.ok(Math.abs(c.usd - (3 + 15 + 3.75 + 0.3)) < 1e-9);
});

test('pricing: unknown models are billed pessimistically, overrides apply', () => {
  const p = makePricer({ 'my-local': { input: 0, output: 0 } });
  assert.equal(p.cost('my-local-7b', { input: 1e6, output: 1e6, cacheWrite: 0, cacheRead: 0 }).usd, 0);
  assert.ok(p.cost('mystery', { input: 1e6, output: 0, cacheWrite: 0, cacheRead: 0 }).usd >= 15);
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
  const o = parseArgs(['--cap', '$2.5', '--on-cap', 'pause', '-d', '10', '--', 'claude', '--model', 'x']);
  assert.equal(o.cap, 2.5); assert.equal(o.onCap, 'pause'); assert.equal(o.daily, 10);
  assert.deepEqual(o.cmd, ['claude', '--model', 'x']);
  assert.throws(() => parseArgs(['--on-cap', 'explode']));
  assert.throws(() => parseArgs(['--cap', 'lots']));
});
