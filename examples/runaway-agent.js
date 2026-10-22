'use strict';
// Simulates a coding agent stuck in a loop, calling Claude via ANTHROPIC_BASE_URL forever.
const base = process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com';
const model = process.env.MODEL || 'claude-sonnet-4-5';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  for (let turn = 1; ; turn++) {
    const res = await fetch(`${base}/v1/messages`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY || 'mock', 'anthropic-version': '2023-06-01' }, body: JSON.stringify({ model, max_tokens: 4096, stream: true, messages: [{ role: 'user', content: 'fix the flaky test (attempt ' + turn + ')' }] }) });
    await res.text();
    if (res.status === 402) { console.log(`agent: turn ${turn} refused — out of budget`); process.exit(3); }
    console.log(`agent: turn ${turn} — "fixing the flaky test…"`);
    await sleep(Number(process.env.DELAY_MS || 350));
  }
})();
