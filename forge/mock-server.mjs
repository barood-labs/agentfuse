#!/usr/bin/env node
/**
 * AgentFuse Forge — mock HTTP + WS so the cinematic UI demos before Money's branch lands.
 * Contract (locked):
 *   WS: agent.spawn | agent.status | agent.log | plan.step | code.diff | verify.result | score.update | run.complete
 *   HTTP: GET /api/health · GET /api/run/:id · POST /api/run {goal}
 * UI: /  (public/)
 */
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachWebSocketServer } from './ws-lite.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const publicDir = path.join(root, 'public');
const port = Number(process.env.PORT || process.env.FORGE_PORT || 8787);

const runs = new Map();
let seq = 0;

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
  });
  res.end(data);
}

function mime(file) {
  if (file.endsWith('.html')) return 'text/html; charset=utf-8';
  if (file.endsWith('.js')) return 'text/javascript; charset=utf-8';
  if (file.endsWith('.css')) return 'text/css; charset=utf-8';
  if (file.endsWith('.svg')) return 'image/svg+xml';
  if (file.endsWith('.png')) return 'image/png';
  if (file.endsWith('.gif')) return 'image/gif';
  return 'application/octet-stream';
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function emit(wss, run, type, payload = {}) {
  const evt = {
    type,
    runId: run.id,
    ts: Date.now(),
    ...payload,
  };
  run.events.push(evt);
  wss.broadcast(evt);
  return evt;
}

async function simulateRun(wss, run) {
  const agents = [
    { id: 'planner', role: 'planner', name: 'Plan' },
    { id: 'coder', role: 'coder', name: 'Code' },
    { id: 'verifier', role: 'verifier', name: 'Verify' },
  ];

  for (const a of agents) {
    run.agents[a.id] = { ...a, status: 'spawning' };
    emit(wss, run, 'agent.spawn', { agent: run.agents[a.id] });
    await sleep(180);
    run.agents[a.id].status = 'ready';
    emit(wss, run, 'agent.status', { agentId: a.id, status: 'ready' });
  }

  const steps = [
    'Parse goal & constraints',
    'Sketch approach + file touch list',
    'Draft implementation plan',
    'Identify verify checks',
  ];
  run.agents.planner.status = 'running';
  emit(wss, run, 'agent.status', { agentId: 'planner', status: 'running' });
  for (let i = 0; i < steps.length; i++) {
    emit(wss, run, 'plan.step', {
      agentId: 'planner',
      index: i,
      total: steps.length,
      step: steps[i],
      status: 'done',
    });
    emit(wss, run, 'agent.log', {
      agentId: 'planner',
      level: 'info',
      message: steps[i],
    });
    emit(wss, run, 'score.update', { score: 10 + i * 8, max: 100, label: 'plan' });
    await sleep(320);
  }
  run.agents.planner.status = 'done';
  emit(wss, run, 'agent.status', { agentId: 'planner', status: 'done' });

  run.agents.coder.status = 'running';
  emit(wss, run, 'agent.status', { agentId: 'coder', status: 'running' });
  const diffs = [
    {
      path: 'src/fuse.js',
      patch: `@@\n+export function guardCap(spent, cap) {\n+  if (spent >= cap) throw new Error('fuse blown');\n+  return cap - spent;\n+}\n`,
    },
    {
      path: 'test/fuse.test.js',
      patch: `@@\n+import test from 'node:test';\n+import assert from 'node:assert/strict';\n+import { guardCap } from '../src/fuse.js';\n+test('blocks at cap', () => {\n+  assert.throws(() => guardCap(5, 5));\n+});\n`,
    },
  ];
  for (const d of diffs) {
    emit(wss, run, 'agent.log', {
      agentId: 'coder',
      level: 'info',
      message: `Writing ${d.path}`,
    });
    emit(wss, run, 'code.diff', { agentId: 'coder', ...d });
    emit(wss, run, 'score.update', {
      score: 42 + diffs.indexOf(d) * 18,
      max: 100,
      label: 'code',
    });
    await sleep(400);
  }
  run.agents.coder.status = 'done';
  emit(wss, run, 'agent.status', { agentId: 'coder', status: 'done' });

  run.agents.verifier.status = 'running';
  emit(wss, run, 'agent.status', { agentId: 'verifier', status: 'running' });
  emit(wss, run, 'agent.log', {
    agentId: 'verifier',
    level: 'info',
    message: 'Running checks…',
  });
  await sleep(350);
  const pass = !/fail|broken/i.test(run.goal);
  emit(wss, run, 'verify.result', {
    agentId: 'verifier',
    ok: pass,
    checks: [
      { name: 'unit', ok: true },
      { name: 'cap-invariant', ok: pass },
      { name: 'no-secrets', ok: true },
    ],
    summary: pass ? 'All checks green' : 'cap-invariant failed (goal requested failure)',
  });
  emit(wss, run, 'score.update', { score: pass ? 96 : 61, max: 100, label: 'verify' });
  run.agents.verifier.status = pass ? 'done' : 'error';
  emit(wss, run, 'agent.status', {
    agentId: 'verifier',
    status: run.agents.verifier.status,
  });

  run.status = pass ? 'complete' : 'failed';
  run.score = pass ? 96 : 61;
  run.finishedAt = Date.now();
  emit(wss, run, 'run.complete', {
    status: run.status,
    score: run.score,
    summary: pass
      ? `Forge run complete for “${run.goal.slice(0, 80)}”`
      : `Forge run finished with failures for “${run.goal.slice(0, 80)}”`,
  });
}

function createRun(goal) {
  const id = `run_${Date.now().toString(36)}_${(++seq).toString(36)}`;
  const run = {
    id,
    goal: String(goal || 'Demo forge run').slice(0, 500),
    status: 'queued',
    score: 0,
    agents: {},
    events: [],
    createdAt: Date.now(),
    finishedAt: null,
  };
  runs.set(id, run);
  return run;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'GET,POST,OPTIONS',
      'access-control-allow-headers': 'content-type',
    });
    return res.end();
  }

  if (req.method === 'GET' && url.pathname === '/api/health') {
    return json(res, 200, {
      ok: true,
      service: 'agentfuse-forge',
      mode: 'mock',
      version: '0.1.0-forge-ui',
      wsPath: '/ws',
      clients: wss.size,
    });
  }

  if (req.method === 'GET' && url.pathname.startsWith('/api/run/')) {
    const id = url.pathname.slice('/api/run/'.length);
    const run = runs.get(id);
    if (!run) return json(res, 404, { ok: false, error: 'not_found' });
    return json(res, 200, {
      ok: true,
      run: {
        id: run.id,
        goal: run.goal,
        status: run.status,
        score: run.score,
        agents: run.agents,
        createdAt: run.createdAt,
        finishedAt: run.finishedAt,
        events: run.events,
      },
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/run') {
    let body = '';
    for await (const chunk of req) body += chunk;
    let parsed = {};
    try {
      parsed = body ? JSON.parse(body) : {};
    } catch {
      return json(res, 400, { ok: false, error: 'invalid_json' });
    }
    const run = createRun(parsed.goal || parsed.prompt || 'Ship a hard cap demo');
    run.status = 'running';
    json(res, 202, { ok: true, runId: run.id, run: { id: run.id, goal: run.goal, status: run.status } });
    simulateRun(wss, run).catch((e) => {
      run.status = 'failed';
      emit(wss, run, 'agent.log', {
        agentId: 'system',
        level: 'error',
        message: e?.message || String(e),
      });
      emit(wss, run, 'run.complete', { status: 'failed', score: run.score, summary: 'mock crashed' });
    });
    return;
  }

  // Static UI
  let rel = url.pathname === '/' ? '/index.html' : url.pathname;
  if (rel === '/ui' || rel === '/ui/') rel = '/index.html';
  const file = path.normalize(path.join(publicDir, rel));
  if (!file.startsWith(publicDir)) {
    res.writeHead(403);
    return res.end('forbidden');
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    res.writeHead(200, { 'content-type': mime(file) });
    res.end(data);
  });
});

const wss = attachWebSocketServer(server, { path: '/ws' });

server.listen(port, () => {
  console.log(`[forge-mock] UI     http://localhost:${port}/`);
  console.log(`[forge-mock] health http://localhost:${port}/api/health`);
  console.log(`[forge-mock] ws     ws://localhost:${port}/ws`);
  console.log(`[forge-mock] POST   http://localhost:${port}/api/run  {"goal":"…"}`);
});
