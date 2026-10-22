'use strict';
// USD per 1M tokens: input / output / cacheWrite (5-minute) / cacheWrite1h / cacheRead.
// `long` = higher tier applied to the WHOLE request when its prompt (input + cache read + cache write)
// exceeds `over` tokens, matching how the providers bill it.
// Anthropic rows checked against docs.claude.com/en/docs/about-claude/pricing on 2026-10-22.
// OpenAI / Gemini rows are list prices from their pricing pages; verify before relying on them,
// and override anything with --prices <file.json>.
const PRICES_CHECKED = '2026-10-22';

const A = (input, output, readMult = 0.1, extra = {}) => ({ input, output, cacheWrite: input * 1.25, cacheWrite1h: input * 2, cacheRead: input * readMult, ...extra });
const DEFAULT_PRICES = {
  // Anthropic
  'claude-fable-5-1': A(10, 50, 0.025),
  'claude-mythos-5-1': A(10, 50, 0.025),
  'claude-fable-5': A(10, 50),
  'claude-mythos-5': A(10, 50),
  'claude-opus-5-5': A(4, 20, 0.05),
  'claude-opus-5': A(5, 25),
  'claude-opus-4-8': A(5, 25),
  'claude-opus-4-7': A(5, 25),
  'claude-opus-4-6': A(5, 25),
  'claude-opus-4-5': A(5, 25),
  'claude-opus-4-1': A(15, 75),
  'claude-opus-4': A(15, 75),
  'claude-sonnet-5-5': A(2, 10, 0.05),
  'claude-sonnet-5': A(2, 10),
  'claude-sonnet-4-6': A(3, 15),
  'claude-sonnet-4-5': A(3, 15, 0.1, { long: { over: 200000, ...A(6, 22.5) } }),
  'claude-sonnet-4': A(3, 15, 0.1, { long: { over: 200000, ...A(6, 22.5) } }),
  'claude-3-7-sonnet': A(3, 15),
  'claude-3-5-sonnet': A(3, 15),
  'claude-haiku-5-5': A(0.1, 0.5, 0.1, { long: { over: 100000, ...A(0.5, 2.5) } }),
  'claude-haiku-4-5': A(1, 5),
  'claude-3-5-haiku': A(0.8, 4),
  'claude-3-haiku': A(0.25, 1.25),
  // Google Gemini (paid tier)
  'gemini-2.5-pro': { input: 1.25, output: 10, cacheRead: 0.31, long: { over: 200000, input: 2.5, output: 15, cacheRead: 0.625 } },
  'gemini-2.5-flash-lite': { input: 0.1, output: 0.4, cacheRead: 0.025 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5, cacheRead: 0.075 },
  'gemini-2.0-flash-lite': { input: 0.075, output: 0.3 },
  'gemini-2.0-flash': { input: 0.1, output: 0.4, cacheRead: 0.025 },
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
// Unknown models are billed at this deliberately high rate so a cap is never under-counted.
const FALLBACK = A(15, 75);

function normalise(model) {
  // strip "anthropic/" / "models/" prefixes and ":free"/"@date" suffixes; OpenRouter writes claude-sonnet-4.5 for claude-sonnet-4-5
  return String(model || '').toLowerCase().replace(/^.*\//, '').replace(/[:@].*$/, '');
}

function makePricer(overrides = {}) {
  const table = { ...DEFAULT_PRICES, ...overrides };
  const keys = Object.keys(table).sort((a, b) => b.length - a.length);
  // A key matches if the id equals it or continues with a non-version suffix.
  // "claude-sonnet-4-5-20250929" -> claude-sonnet-4-5 (date), but "claude-opus-4-9" must NOT
  // fall back to the older/cheaper-or-pricier "claude-opus-4" row: it's unknown -> fallback.
  const matches = (id, k) => {
    if (!id.startsWith(k)) return false;
    const rest = id.slice(k.length);
    return rest === '' || !/^[-.]\d{1,2}($|[-.])/.test(rest);
  };
  function lookup(model) {
    const m = normalise(model);
    for (const cand of [m, m.replace(/(\d)\.(\d)/g, '$1-$2')]) {
      for (const k of keys) if (matches(cand, k.toLowerCase())) return { key: k, price: table[k], known: true };
    }
    return { key: null, price: FALLBACK, known: false };
  }
  function cost(model, u) {
    const { price: base, known, key } = lookup(model);
    if (typeof u.usd === 'number') return { usd: u.usd, known: true, priceKey: key || 'provider-reported', long: false };
    const prompt = (u.input || 0) + (u.cacheRead || 0) + (u.cacheWrite || 0) + (u.cacheWrite1h || 0);
    const long = !!(base.long && prompt > base.long.over);
    const price = long ? { ...base, ...base.long } : base;
    const r = (n, rate) => ((n || 0) * rate) / 1e6;
    const usd = r(u.input, price.input) + r(u.output, price.output) +
      r(u.cacheWrite, price.cacheWrite ?? price.input * 1.25) +
      r(u.cacheWrite1h, price.cacheWrite1h ?? price.input * 2) +
      r(u.cacheRead, price.cacheRead ?? price.input * 0.1);
    return { usd, known, priceKey: key, long };
  }
  return { lookup, cost, table };
}

module.exports = { makePricer, DEFAULT_PRICES, FALLBACK, PRICES_CHECKED };
