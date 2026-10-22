'use strict';
// Normalised usage: { input, output, cacheWrite, cacheRead } where `input` EXCLUDES cached tokens.

function fromAnthropic(u = {}) {
  return {
    input: u.input_tokens || 0,
    output: u.output_tokens || 0,
    cacheWrite: u.cache_creation_input_tokens || 0,
    cacheRead: u.cache_read_input_tokens || 0,
  };
}
function fromOpenAI(u = {}) {
  // Chat Completions: prompt_tokens/completion_tokens; Responses API: input_tokens/output_tokens.
  const prompt = u.prompt_tokens ?? u.input_tokens ?? 0;
  const completion = u.completion_tokens ?? u.output_tokens ?? 0;
  const cached = (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) ||
    (u.input_tokens_details && u.input_tokens_details.cached_tokens) || 0;
  return { input: Math.max(0, prompt - cached), output: completion, cacheWrite: 0, cacheRead: cached };
}

function add(a, b) {
  return { input: a.input + b.input, output: a.output + b.output, cacheWrite: a.cacheWrite + b.cacheWrite, cacheRead: a.cacheRead + b.cacheRead };
}
const ZERO = () => ({ input: 0, output: 0, cacheWrite: 0, cacheRead: 0 });

/** Extract {model, usage} from a complete (non-stream) JSON body. */
function fromJSON(provider, body) {
  let j; try { j = typeof body === 'string' ? JSON.parse(body) : body; } catch { return null; }
  if (!j || !j.usage) return null;
  return { model: j.model, usage: provider === 'anthropic' ? fromAnthropic(j.usage) : fromOpenAI(j.usage) };
}

/**
 * Incremental SSE tap. Feed raw chunks; it tracks model + usage across events.
 * Anthropic: message_start carries input/cache usage, message_delta carries cumulative output_tokens.
 * OpenAI chat: final chunk carries `usage` (requires stream_options.include_usage, which the proxy injects).
 * OpenAI responses: `response.completed` carries response.usage.
 */
class SSETap {
  constructor(provider) { this.provider = provider; this.buf = ''; this.model = null; this.usage = ZERO(); this.seen = false; this._anth = { start: null, out: 0 }; this.onUpdate = null; }
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
    if (this.provider === 'anthropic') {
      if (ev.type === 'message_start' && ev.message) {
        this.model = ev.message.model || this.model;
        this._anth.start = fromAnthropic(ev.message.usage || {});
        this._anth.out = this._anth.start.output; this.seen = true;
      } else if (ev.type === 'message_delta' && ev.usage) {
        // message_delta usage is cumulative
        if (ev.usage.output_tokens != null) this._anth.out = ev.usage.output_tokens;
        if (ev.usage.input_tokens != null && this._anth.start) this._anth.start.input = ev.usage.input_tokens;
        this.seen = true;
      } else return;
      const s = this._anth.start || ZERO();
      this.usage = { ...s, output: this._anth.out };
    } else {
      if (ev.model) this.model = ev.model;
      if (ev.type === 'response.completed' && ev.response) {
        this.model = ev.response.model || this.model;
        if (ev.response.usage) { this.usage = fromOpenAI(ev.response.usage); this.seen = true; }
      } else if (ev.usage) { this.usage = fromOpenAI(ev.usage); this.seen = true; }
      else return;
    }
    if (this.onUpdate) this.onUpdate(this);
  }
}

module.exports = { fromAnthropic, fromOpenAI, fromJSON, SSETap, add, ZERO };
