'use strict';
// USD per 1M tokens. input / output / cacheWrite (5m) / cacheRead.
// Prices are public list prices; override or extend with --prices <file.json>.
// Matching is longest-prefix on the model id, so dated snapshots (e.g. claude-sonnet-4-5-20250929) resolve.
const DEFAULT_PRICES = {
  // Anthropic
  'claude-opus-4-5': { input: 5, output: 25, cacheWrite: 6.25, cacheRead: 0.5 },
  'claude-opus-4-1': { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  'claude-opus-4': { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 },
  'claude-sonnet-4': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-3-7-sonnet': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-3-5-sonnet': { input: 3, output: 15, cacheWrite: 3.75, cacheRead: 0.3 },
  'claude-haiku-4': { input: 1, output: 5, cacheWrite: 1.25, cacheRead: 0.1 },
  'claude-3-5-haiku': { input: 0.8, output: 4, cacheWrite: 1, cacheRead: 0.08 },
  'claude-3-haiku': { input: 0.25, output: 1.25, cacheWrite: 0.3, cacheRead: 0.03 },
  // OpenAI
  'gpt-5-nano': { input: 0.05, output: 0.4, cacheRead: 0.005 },
  'gpt-5-mini': { input: 0.25, output: 2, cacheRead: 0.025 },
  'gpt-5': { input: 1.25, output: 10, cacheRead: 0.125 },
  'gpt-4.1-nano': { input: 0.1, output: 0.4, cacheRead: 0.025 },
  'gpt-4.1-mini': { input: 0.4, output: 1.6, cacheRead: 0.1 },
  'gpt-4.1': { input: 2, output: 8, cacheRead: 0.5 },
  'gpt-4o-mini': { input: 0.15, output: 0.6, cacheRead: 0.075 },
  'gpt-4o': { input: 2.5, output: 10, cacheRead: 1.25 },
  'o4-mini': { input: 1.1, output: 4.4, cacheRead: 0.275 },
  'o3-mini': { input: 1.1, output: 4.4, cacheRead: 0.55 },
  'o3': { input: 2, output: 8, cacheRead: 0.5 },
  'o1': { input: 15, output: 60, cacheRead: 7.5 },
};
// Unknown models are billed at this (deliberately pessimistic) rate so a cap never under-counts.
const FALLBACK = { input: 15, output: 75, cacheWrite: 18.75, cacheRead: 1.5 };

function makePricer(overrides = {}) {
  const table = { ...DEFAULT_PRICES, ...overrides };
  const keys = Object.keys(table).sort((a, b) => b.length - a.length);
  function lookup(model) {
    const m = String(model || '').toLowerCase().replace(/^.*\//, ''); // strip "anthropic/" style prefixes
    for (const k of keys) if (m.startsWith(k.toLowerCase())) return { key: k, price: table[k], known: true };
    return { key: null, price: FALLBACK, known: false };
  }
  function cost(model, u) {
    const { price, known, key } = lookup(model);
    const p = (n, rate) => ((n || 0) * (rate ?? price.input)) / 1e6;
    const usd = p(u.input, price.input) + p(u.output, price.output) +
      p(u.cacheWrite, price.cacheWrite ?? price.input * 1.25) + p(u.cacheRead, price.cacheRead ?? price.input * 0.1);
    return { usd, known, priceKey: key };
  }
  return { lookup, cost, table };
}

module.exports = { makePricer, DEFAULT_PRICES, FALLBACK };
