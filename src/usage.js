'use strict';
// Normalised usage: { input, output, cacheWrite, cacheRead } where `input` EXCLUDES cached tokens.

function fromAnthropic(u = {}) {
  const total = u.cache_creation_input_tokens || 0;
  const cc = u.cache_creation || {};
  const w1h = cc.ephemeral_1h_input_tokens || 0;
  const out = {
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    cacheWrite: Math.max(0, total - w1h), // 5-minute writes (1.25x)
    cacheRead: u.cache_read_input_tokens || 0,
  };
  if (w1h) out.cacheWrite1h = w1h; // 1-hour writes (2x)
  return out;
}
function fromOpenAI(u = {}) {
  // Chat Completions: prompt_tokens/completion_tokens; Responses API: input_tokens/output_tokens.
  const prompt = u.prompt_tokens ?? u.input_tokens ?? 0;
  const completion = u.completion_tokens ?? u.output_tokens ?? 0;
  const cached = (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) ||
    (u.input_tokens_details && u.input_tokens_details.cached_tokens) || 0;
  const out = { input: Math.max(0, prompt - cached), output: completion, cacheWrite: 0, cacheRead: cached };
  if (typeof u.cost === 'number') out.usd = u.cost; // OpenRouter reports the exact billed cost
  return out;
}
function fromGemini(m = {}) {
  const cached = m.cachedContentTokenCount || 0;
  return {
    input: Math.max(0, (m.promptTokenCount || 0) - cached),
    output: (m.candidatesTokenCount || 0) + (m.thoughtsTokenCount || 0), // thinking tokens bill as output
    cacheWrite: 0,
    cacheRead: cached,
  };
}
/** Wire format family for a route. OpenRouter speaks OpenAI. */
function family(provider) { return provider === 'openrouter' ? 'openai' : provider; }
function parseUsage(provider, u) {
  const f = family(provider);
  return f === 'anthropic' ? fromAnthropic(u) : f === 'gemini' ? fromGemini(u) : fromOpenAI(u);
}

function add(a, b) {
  return { input: a.input + b.input, output: a.output + b.output, cacheWrite: a.cacheWrite + b.cacheWrite, cacheRead: a.cacheRead + b.cacheRead };
}
const ZERO = () => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });

/** Extract {model, usage} from a complete (non-stream) JSON body. */
function fromJSON(provider, body) {
  let j; try { j = typeof body === 'string' ? JSON.parse(body) : body; } catch { return null; }
  if (Array.isArray(j)) j = j[j.length - 1]; // Gemini non-SSE streamGenerateContent returns an array
  if (!j) return null;
  if (family(provider) === 'gemini') return j.usageMetadata ? { model: j.modelVersion, usage: fromGemini(j.usageMetadata) } : null;
  if (!j.usage) return null;
  return { model: j.model, usage: parseUsage(provider, j.usage) };
}

/**
 * Incremental SSE tap. Feed raw chunks; it tracks model + usage across events.
 * Anthropic: message_start carries input/cache usage, message_delta carries cumulative output_tokens.
 * OpenAI chat: final chunk carries `usage` (requires stream_options.include_usage, which the proxy injects).
 * OpenAI responses: `response.completed` carries response.usage.
 */
class SSETap {
  constructor(provider) { this.provider = family(provider); this.buf = ''; this.model = null; this.usage = ZERO(); this.seen = false; this._anth = { start: null, out: 0 }; this.onUpdate = null; this.chars = 0; this.inputSeen = false; }
  /**
   * Usage for live metering. Providers usually report output tokens only at the END of a stream
   * (OpenAI/Gemini report everything at the end), so we also count streamed text/tool-call/thinking
   * characters (~4 chars per token) and take the larger. `promptTokens` stands in for input until reported.
   */
  live(promptTokens = 0) {
    const u = { ...this.usage };
    u.output = Math.max(u.output, Math.ceil(this.chars / 4));
    if (!this.inputSeen) u.input = Math.max(u.input, promptTokens);
    return u;
  }
  /** Did the provider send its final usage? */
  completed() {
    if (this.provider === 'anthropic') return this._anth.final === true;
    return this.seen;
  }
  _count(ev) {
    let n = 0;
    const add = (x) => { if (typeof x === 'string') n += x.length; };
    if (this.provider === 'anthropic') {
      if (ev.type === 'content_block_delta' && ev.delta) { add(ev.delta.text); add(ev.delta.partial_json); add(ev.delta.thinking); }
    } else if (this.provider === 'gemini') {
      for (const c of ev.candidates || []) for (const p of (c.content && c.content.parts) || []) { add(p.text); if (p.functionCall) n += JSON.stringify(p.functionCall).length; }
    } else {
      for (const ch of ev.choices || []) { const d = ch.delta || {}; add(d.content); add(d.reasoning_content); add(d.reasoning); for (const t of d.tool_calls || []) if (t.function) { add(t.function.arguments); add(t.function.name); } }
      if (typeof ev.type === 'string' && ev.type.endsWith('.delta')) add(ev.delta);
    }
    this.chars += n;
    return n;
  }
  write(chunk) {
    this.buf += chunk.toString('utf8');
    let idx;
    while ((idx = this.buf.search(/\r?\n\r?\n/)) !== -1) {
      const raw = this.buf.slice(0, idx); this.buf = this.buf.slice(idx).replace(/^\r?\n\r?\n/, '');
      const data = raw.split(/\r?\n/).filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
      if (!data || data === '[DONE]') continue;
      let ev; try { ev = JSON.parse(data); } catch { continue; }
      this._event(ev);
    }
  }
  _event(ev) {
    const counted = this._count(ev);
    const before = this.seen;
    this._usage(ev);
    if (this.onUpdate && (counted || this.seen !== before || this._changed)) this.onUpdate(this);
    this._changed = false;
  }
  _usage(ev) {
    if (this.provider === 'anthropic') {
      if (ev.type === 'message_start' && ev.message) {
        this.model = ev.message.model || this.model;
        this._anth.start = fromAnthropic(ev.message.usage || {});
        this._anth.out = this._anth.start.output; this.seen = true; this.inputSeen = true;
      } else if (ev.type === 'message_delta' && ev.usage) {
        // message_delta usage is cumulative
        if (ev.usage.output_tokens != null) { this._anth.out = ev.usage.output_tokens; this._anth.final = true; }
        if (ev.usage.input_tokens != null && this._anth.start) this._anth.start.input = ev.usage.input_tokens;
        this.seen = true;
      } else return;
      const s = this._anth.start || ZERO();
      this.usage = { ...s, output: this._anth.out }; this._changed = true;
    } else if (this.provider === 'gemini') {
      if (ev.modelVersion) this.model = ev.modelVersion;
      if (!ev.usageMetadata) return;
      this.usage = fromGemini(ev.usageMetadata); this.seen = true; this._changed = true; // cumulative per chunk
      if (ev.usageMetadata.promptTokenCount) this.inputSeen = true;
    } else {
      if (ev.model) this.model = ev.model;
      if (ev.type === 'response.completed' && ev.response) {
        this.model = ev.response.model || this.model;
        if (ev.response.usage) { this.usage = fromOpenAI(ev.response.usage); this.seen = true; this.inputSeen = true; this._changed = true; }
      } else if (ev.usage) { this.usage = fromOpenAI(ev.usage); this.seen = true; this.inputSeen = true; this._changed = true; }
    }
  }
}

module.exports = { fromAnthropic, fromOpenAI, fromGemini, parseUsage, family, fromJSON, SSETap, add, ZERO };
