import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const { executeRun, createRun } = await import('../forge/dist/orchestrator.js');
const { startForge } = await import('../forge/dist/server.js');
const { createTools, parseTap, safePath } = await import('../forge/dist/tools.js');
const { evaluate } = await import('../forge/dist/score.js');
const { unifiedDiff } = await import('../forge/dist/diff.js');
const { EVENT_TYPES, TOOL_NAMES, LLM } = await import('../forge/dist/index.js');

const EVENT_SET = new Set(EVENT_TYPES);

test('proxy package is still the v0.1.0 spend-cap fuse', () => {
  const pkg = require('../package.json');
  assert.equal(pkg.version, '0.1.0');
  assert.equal(pkg.dependencies, undefined);
  const { Fuse } = require('../src/fuse.js');
  const fuse = new Fuse({ cap: 5 });
  assert.equal(fuse.state, 'ok');
  fuse.commit(1);
  assert.equal(fuse.spent, 1);
  assert.equal(fuse.state, 'ok');
});

test('rubric: tests pass is 60, task complete is 40, both is 100', () => {
  assert.equal(evaluate({ testsOk: false, exportOk: false }).score, 0);
  assert.equal(evaluate({ testsOk: false, exportOk: true }).score, 40);
  assert.equal(evaluate({ testsOk: true, exportOk: false }).score, 60);
  const full = evaluate({ testsOk: true, exportOk: true });
  assert.equal(full.score, 100);
  assert.equal(full.max, 100);
  assert.equal(full.passed, true);
  assert.deepEqual(full.rubric.map((row) => row.id), ['tests_pass', 'task_complete']);
});

test('unified diff shows the added clamp', () => {
  const patch = unifiedDiff('solution.js', '', 'function clampSpend() {}\n');
  assert.match(patch, /^--- a\/solution\.js/m);
  assert.match(patch, /^\+function clampSpend/m);
});

test('tap parser reads node --test summaries', () => {
  const tap = [
    'TAP version 13',
    '# Subtest: under cap returns spent',
    'not ok 1 - under cap returns spent',
    '# Subtest: equal to cap stays',
    'ok 2 - equal to cap stays',
    '# tests 2',
    '# pass 1',
    '# fail 1',
  ].join('\n');
  const parsed = parseTap(tap, 1);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.failed, 1);
  assert.equal(parsed.checks[0].ok, false);
  assert.equal(parsed.checks[1].name, 'equal to cap stays');
});

test('tools stay inside the workspace', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forge-tools-'));
  try {
    assert.throws(() => safePath(dir, '../outside.js'), /escapes/);
    assert.throws(() => safePath(dir, '/etc/passwd'), /absolute/);
    const tools = createTools();
    assert.deepEqual(Object.keys(tools), [...TOOL_NAMES]);
    const wrote = await tools.write_file.run({ path: 'note.js', content: 'module.exports = { clampSpend() { return 1; } };\n' }, { workspace: dir });
    assert.equal(wrote.ok, true);
    const read = await tools.read_file.run({ path: 'note.js' }, { workspace: dir });
    assert.equal(read.ok, true);
    assert.match(String(read.result.content), /clampSpend/);
    const escaped = await tools.write_file.run({ path: '../nope.js', content: 'x' }, { workspace: dir });
    assert.equal(escaped.ok, false);
    assert.equal(fs.existsSync(path.join(dir, '..', 'nope.js')), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('eval loop: first verify fails, second passes, score ends at 100', async () => {
  const run = createRun('Ship a hard spending cap with pre-flight blocking');
  await executeRun(run, { tickMs: 0 });
  assert.equal(LLM.id, 'mock-llm');
  assert.equal(LLM.callsNetwork, false);
  assert.equal(run.status, 'complete');
  assert.equal(run.score, 100);
  assert.equal(run.label, 'MOCK');
  for (const event of run.events) assert.ok(EVENT_SET.has(event.type), event.type);
  assert.deepEqual(
    run.events.filter((event) => event.type === 'agent.spawn').map((event) => event.agent.id),
    ['planner', 'coder', 'verifier'],
  );
  const verifies = run.events.filter((event) => event.type === 'verify.result');
  assert.equal(verifies.length, 2);
  assert.equal(verifies[0].ok, false);
  assert.equal(verifies[1].ok, true);
  assert.ok(verifies[0].checks.some((check) => check.name === 'over cap clamps to the cap' && check.ok === false));
  assert.ok(verifies[1].checks.every((check) => check.ok));
  const scores = run.events.filter((event) => event.type === 'score.update');
  assert.equal(scores.at(-1).score, 100);
  assert.equal(scores.at(-1).max, 100);
  assert.equal(scores.at(-1).label, 'verify');
  const toolLogs = run.events
    .filter((event) => event.type === 'agent.log' && String(event.message).startsWith('tool '))
    .map((event) => event.message);
  for (const name of ['read_file', 'write_file', 'run_tests', 'score']) {
    assert.ok(toolLogs.some((line) => line.includes(name)), name);
  }
  assert.ok(run.events.some((event) => event.type === 'agent.log' && String(event.message).includes('MOCK LLM')));
  assert.ok(run.events.some((event) => event.type === 'code.diff' && event.path === 'solution.js' && String(event.patch).includes('+++ b/solution.js')));
  assert.equal(run.events.at(-1).type, 'run.complete');
  assert.equal(run.events.at(-1).status, 'complete');
  assert.equal(run.events.at(-1).llm, 'mock-llm');
});

test('a goal that asks to fail stays failed', async () => {
  const run = createRun('Please fail this cap check');
  await executeRun(run, { tickMs: 0 });
  assert.equal(run.status, 'failed');
  assert.equal(run.score, 40);
  const verifies = run.events.filter((event) => event.type === 'verify.result');
  assert.equal(verifies.at(-1).ok, false);
  assert.equal(run.events.at(-1).type, 'run.complete');
  assert.equal(run.events.at(-1).status, 'failed');
});

test('HTTP + WS speak the dashboard contract and serve public/', async () => {
  const forge = await startForge({ port: 0, host: '127.0.0.1', tickMs: 0 });
  try {
    const healthRes = await fetch(`${forge.url}/api/health`);
    const health = await healthRes.json();
    assert.equal(healthRes.status, 200);
    assert.equal(health.ok, true);
    assert.equal(health.mode, 'mock');
    assert.equal(health.llm, 'mock-llm');
    assert.equal(health.label, 'MOCK');
    assert.equal(health.engine, 'planner-coder-verifier');
    assert.deepEqual(health.events, [...EVENT_TYPES]);

    const page = await fetch(`${forge.url}/`);
    const html = await page.text();
    assert.equal(page.status, 200);
    assert.match(html, /AgentFuse Forge/);
    assert.match(html, /agent\.spawn/);
    const css = await fetch(`${forge.url}/styles.css`);
    assert.match(await css.text(), /--neon/);
    const ui = await fetch(`${forge.url}/ui`);
    assert.match(await ui.text(), /Run forge/);

    const escaped = await fetch(`${forge.url}/..%2fpackage.json`);
    assert.notEqual(escaped.status, 200);

    const missing = await fetch(`${forge.url}/api/run/run_nope`);
    assert.equal(missing.status, 404);
    assert.equal((await missing.json()).error, 'not_found');

    const bad = await fetch(`${forge.url}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{',
    });
    assert.equal(bad.status, 400);
    assert.equal((await bad.json()).error, 'invalid_json');

    const ws = await connectWs(forge.port);
    const posted = await fetch(`${forge.url}/api/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal: 'Ship a hard spending cap with pre-flight blocking' }),
    });
    const body = await posted.json();
    assert.equal(posted.status, 202);
    assert.equal(body.ok, true);
    assert.match(body.runId, /^run_/);

    const live = await ws.until((event) => event.type === 'run.complete');
    assert.equal(live.at(-1).status, 'complete');
    assert.equal(live.at(-1).score, 100);
    assert.ok(live.some((event) => event.type === 'agent.spawn' && event.agent?.id === 'planner'));
    assert.ok(live.some((event) => event.type === 'plan.step' && typeof event.step === 'string' && typeof event.index === 'number'));
    assert.ok(live.some((event) => event.type === 'code.diff' && typeof event.patch === 'string'));
    assert.ok(live.some((event) => event.type === 'verify.result' && event.ok === false));
    assert.ok(live.some((event) => event.type === 'score.update' && event.max === 100));

    const saved = await fetch(`${forge.url}/api/run/${body.runId}`);
    const savedBody = await saved.json();
    assert.equal(saved.status, 200);
    assert.equal(savedBody.ok, true);
    assert.equal(savedBody.run.status, 'complete');
    assert.equal(savedBody.run.score, 100);
    assert.equal(savedBody.run.events.at(-1).type, 'run.complete');
    assert.equal(savedBody.run.workspace, undefined);
    ws.close();
  } finally {
    await forge.close();
  }
});

function connectWs(port) {
  return new Promise((resolve, reject) => {
    const key = crypto.randomBytes(16).toString('base64');
    const expected = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    const socket = net.connect({ host: '127.0.0.1', port }, () => {
      socket.write([
        `GET /ws HTTP/1.1`,
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        `Sec-WebSocket-Key: ${key}`,
        'Sec-WebSocket-Version: 13',
        '',
        '',
      ].join('\r\n'));
    });
    const events = [];
    const waiters = [];
    let buf = Buffer.alloc(0);
    let open = false;
    const failTimer = setTimeout(() => reject(new Error('ws handshake timeout')), 5000);

    function push(event) {
      if (waiters.length) waiters.shift()(event);
      else events.push(event);
    }
    function take() {
      if (events.length) return Promise.resolve(events.shift());
      return new Promise((res) => waiters.push(res));
    }
    function decode() {
      while (buf.length >= 2) {
        const b0 = buf[0];
        const b1 = buf[1];
        let len = b1 & 0x7f;
        let pos = 2;
        if (len === 126) {
          if (buf.length < 4) return;
          len = buf.readUInt16BE(2);
          pos = 4;
        } else if (len === 127) {
          if (buf.length < 10) return;
          len = Number(buf.readBigUInt64BE(2));
          pos = 10;
        }
        if ((b1 & 0x80) !== 0) return;
        if (buf.length < pos + len) return;
        const payload = buf.subarray(pos, pos + len).toString('utf8');
        buf = buf.subarray(pos + len);
        if ((b0 & 0x0f) === 0x1) push(JSON.parse(payload));
      }
    }

    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      if (!open) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const header = buf.subarray(0, idx).toString('utf8');
        buf = buf.subarray(idx + 4);
        if (!header.includes(' 101 ') || !header.includes(expected)) {
          clearTimeout(failTimer);
          socket.destroy();
          reject(new Error(`bad upgrade:\n${header}`));
          return;
        }
        open = true;
        clearTimeout(failTimer);
        resolve({
          async until(pred) {
            const deadline = Date.now() + 15000;
            const seen = [];
            while (Date.now() < deadline) {
              let timer;
              const event = await Promise.race([
                take(),
                new Promise((_, rej) => {
                  timer = setTimeout(() => rej(new Error('ws event timeout')), Math.max(1, deadline - Date.now()));
                }),
              ]).finally(() => clearTimeout(timer));
              seen.push(event);
              if (pred(event)) return seen;
            }
            throw new Error('ws until timeout');
          },
          close() { socket.end(); },
        });
      }
      if (open) decode();
    });
    socket.on('error', (err) => {
      clearTimeout(failTimer);
      reject(err);
    });
  });
}

test('mock llm source does not call a provider', () => {
  const src = fs.readFileSync(path.join(root, 'forge/src/mock-llm.ts'), 'utf8');
  assert.match(src, /MOCK LLM/);
  assert.doesNotMatch(src, /api\.openai|anthropic\.com|generativelanguage|sk-ant-/);
});
