'use strict';
// A fake Anthropic + OpenAI API that returns realistic usage. Costs $0. Used by tests and the demo.
const http = require('http');

// Like the real APIs, output usage is reported only at the END of a stream; text arrives in `chunks` deltas.
function start({ port = 0, inputTokens = 20000, outputTokens = 1500, cacheRead = 0, model, chunks = 1, chunkChars = 8, delayMs = 0, cost, usageExtra = {} } = {}) {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const text = (i) => ('lorem ipsum dolor sit amet '.repeat(Math.ceil(chunkChars / 27) + 1)).slice(0, chunkChars);
  const server = http.createServer((req, res) => {
    res.on('close', () => { server.clientClosed = (server.clientClosed || 0) + (res.writableFinished ? 0 : 1); });
    let raw = ''; req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      let body = {}; try { body = JSON.parse(raw || '{}'); } catch {}
      server.lastRequest = { url: req.url, headers: req.headers, body };
      const m = model || body.model || 'claude-sonnet-4-5';
      if (req.url.startsWith('/v1/messages')) {
        const usage = { input_tokens: inputTokens, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0, ...usageExtra };
        if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ id: 'msg_mock', type: 'message', model: m, content: [{ type: 'text', text: 'ok' }], usage: { ...usage, output_tokens: outputTokens } })); }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const ev = (t, d) => res.write(`event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`);
        ev('message_start', { message: { id: 'msg_mock', model: m, usage: { ...usage, output_tokens: 1 } } });
        for (let i = 0; i < chunks; i++) { if (res.destroyed) return; ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: text(i) } }); if (delayMs) await wait(delayMs); }
        ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: outputTokens } });
        ev('message_stop', {});
        return res.end();
      }
      if (req.url.startsWith('/v1/chat/completions')) {
        const usage = { prompt_tokens: inputTokens + cacheRead, completion_tokens: outputTokens, prompt_tokens_details: { cached_tokens: cacheRead }, ...(cost != null ? { cost } : {}) };
        if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ id: 'cc', model: m, choices: [{ message: { role: 'assistant', content: 'ok' } }], usage })); }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (let i = 0; i < chunks; i++) { if (res.destroyed) return; res.write(`data: ${JSON.stringify({ model: m, choices: [{ delta: { content: text(i) } }] })}\n\n`); if (delayMs) await wait(delayMs); }
        if (body.stream_options && body.stream_options.include_usage) res.write(`data: ${JSON.stringify({ model: m, choices: [], usage })}\n\n`);
        res.write('data: [DONE]\n\n'); return res.end();
      }
      if (req.url.startsWith('/v1/responses')) {
        const usage = { input_tokens: inputTokens + cacheRead, output_tokens: outputTokens, input_tokens_details: { cached_tokens: cacheRead } };
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`event: response.created\ndata: ${JSON.stringify({ type: 'response.created', response: { model: m } })}\n\n`);
        res.write(`event: response.completed\ndata: ${JSON.stringify({ type: 'response.completed', response: { model: m, usage } })}\n\n`);
        return res.end();
      }
      const gm = /\/models\/([^/:]+):(generateContent|streamGenerateContent)/.exec(req.url);
      if (gm) {
        const um = { promptTokenCount: inputTokens + cacheRead, cachedContentTokenCount: cacheRead, candidatesTokenCount: outputTokens, thoughtsTokenCount: 0 };
        if (gm[2] === 'generateContent') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] } }], usageMetadata: um, modelVersion: gm[1] })); }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        for (let i = 0; i < chunks; i++) { if (res.destroyed) return; res.write(`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: text(i) }] } }], modelVersion: gm[1] })}\n\n`); if (delayMs) await wait(delayMs); }
        res.write(`data: ${JSON.stringify({ candidates: [], usageMetadata: um, modelVersion: gm[1] })}\n\n`);
        return res.end();
      }
      res.writeHead(404); res.end('{}');
    });
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r({ server, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((c) => server.close(c)) })));
}
module.exports = { start };
if (require.main === module) start({ port: Number(process.argv[2]) || 8787 }).then((s) => console.log(`mock upstream on ${s.url}`));
