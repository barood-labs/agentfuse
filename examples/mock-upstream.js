'use strict';
// A fake Anthropic + OpenAI API that returns realistic usage. Costs $0. Used by tests and the demo.
const http = require('http');

function start({ port = 0, inputTokens = 20000, outputTokens = 1500, cacheRead = 0, model } = {}) {
  const server = http.createServer((req, res) => {
    let raw = ''; req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body = {}; try { body = JSON.parse(raw || '{}'); } catch {}
      server.lastRequest = { url: req.url, headers: req.headers, body };
      const m = model || body.model || 'claude-sonnet-4-5';
      if (req.url.startsWith('/v1/messages')) {
        const usage = { input_tokens: inputTokens, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: 0 };
        if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ id: 'msg_mock', type: 'message', model: m, content: [{ type: 'text', text: 'ok' }], usage: { ...usage, output_tokens: outputTokens } })); }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const ev = (t, d) => res.write(`event: ${t}\ndata: ${JSON.stringify({ type: t, ...d })}\n\n`);
        ev('message_start', { message: { id: 'msg_mock', model: m, usage: { ...usage, output_tokens: 1 } } });
        ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: 'working…' } });
        ev('message_delta', { delta: { stop_reason: 'end_turn' }, usage: { output_tokens: outputTokens } });
        ev('message_stop', {});
        return res.end();
      }
      if (req.url.startsWith('/v1/chat/completions')) {
        const usage = { prompt_tokens: inputTokens + cacheRead, completion_tokens: outputTokens, prompt_tokens_details: { cached_tokens: cacheRead } };
        if (!body.stream) { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ id: 'cc', model: m, choices: [{ message: { role: 'assistant', content: 'ok' } }], usage })); }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write(`data: ${JSON.stringify({ model: m, choices: [{ delta: { content: 'ok' } }] })}\n\n`);
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
      res.writeHead(404); res.end('{}');
    });
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r({ server, url: `http://127.0.0.1:${server.address().port}`, close: () => new Promise((c) => server.close(c)) })));
}
module.exports = { start };
if (require.main === module) start({ port: Number(process.argv[2]) || 8787 }).then((s) => console.log(`mock upstream on ${s.url}`));
