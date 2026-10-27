const $ = (id) => document.getElementById(id);

const state = {
  runId: null,
  score: 0,
  max: 100,
  label: 'idle',
  agents: {},
  connected: false,
};

function setHealth(mode) {
  const el = $('health');
  el.className = 'pill ' + (mode === 'live' ? 'live' : mode === 'mock' ? 'mock' : 'down');
  el.textContent = mode === 'live' ? 'ws live' : mode === 'mock' ? 'mock ready' : 'offline';
}

function renderAgents() {
  const box = $('agents');
  const order = ['planner', 'coder', 'verifier'];
  const items = order
    .map((id) => state.agents[id])
    .filter(Boolean);
  if (!items.length) {
    box.innerHTML = '<div class="agent-card"><div class="name">No agents yet</div><div class="role">POST a goal to spawn the forge crew</div></div>';
    return;
  }
  box.innerHTML = items
    .map((a) => {
      const active = a.status === 'running' || a.status === 'spawning' ? 'active' : '';
      const err = a.status === 'error' ? 'error' : '';
      return `<div class="agent-card ${active} ${err}">
        <div class="name"><span>${a.name || a.id}</span><span class="status ${a.status}">${a.status}</span></div>
        <div class="role">${a.role || a.id}</div>
      </div>`;
    })
    .join('');
}

function renderScore() {
  const num = $('score');
  const prev = Number(num.textContent) || 0;
  num.textContent = String(state.score);
  $('scoreLabel').textContent = state.label || 'score';
  const pct = Math.max(0, Math.min(100, (100 * state.score) / Math.max(1, state.max)));
  $('meter').style.width = pct + '%';
  const box = num.closest('.scorebox');
  if (state.score >= state.max && state.max > 0) {
    box?.classList.add('perfect');
    if (prev < state.score) {
      num.classList.remove('flourish');
      void num.offsetWidth;
      num.classList.add('flourish');
    }
  } else {
    box?.classList.remove('perfect');
    num.classList.remove('flourish');
  }
}

function addTimeline(kind, title, body, meta = '') {
  const el = document.createElement('div');
  el.className = `step ${kind}`;
  const icon = kind === 'plan' ? '◆' : kind === 'code' ? '</>' : kind === 'verify' ? '✓' : '•';
  el.innerHTML = `<div class="dot">${icon}</div>
    <div class="card">
      <h3>${title}</h3>
      ${meta ? `<div class="meta">${meta}</div>` : ''}
      ${body ? `<pre>${body}</pre>` : ''}
    </div>`;
  const tl = $('timeline');
  tl.prepend(el);
}

function addLog(agentId, level, message, ts) {
  const line = document.createElement('div');
  line.className = `line ${level || 'info'}`;
  const t = new Date(ts || Date.now()).toLocaleTimeString();
  line.innerHTML = `<span class="ts">${t}</span><span class="agent">${agentId || 'sys'}</span><span class="${level || 'info'}">${escapeHtml(message || '')}</span>`;
  const box = $('log');
  box.prepend(line);
}

function escapeHtml(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

function handleEvent(evt) {
  switch (evt.type) {
    case 'agent.spawn':
      if (evt.agent?.id) state.agents[evt.agent.id] = { ...evt.agent };
      renderAgents();
      addLog(evt.agent?.id, 'info', `spawned (${evt.agent?.role || ''})`, evt.ts);
      break;
    case 'agent.status':
      if (evt.agentId) {
        state.agents[evt.agentId] = {
          ...(state.agents[evt.agentId] || { id: evt.agentId, name: evt.agentId }),
          status: evt.status,
        };
      }
      renderAgents();
      addLog(evt.agentId, 'info', `status → ${evt.status}`, evt.ts);
      break;
    case 'agent.log':
      addLog(evt.agentId, evt.level || 'info', evt.message, evt.ts);
      break;
    case 'plan.step':
      addTimeline(
        'plan',
        evt.step || 'Plan step',
        '',
        `step ${((evt.index ?? 0) + 1)}/${evt.total ?? '?'} · ${evt.status || ''}`,
      );
      break;
    case 'code.diff':
      addTimeline('code', evt.path || 'diff', evt.patch || '', evt.agentId || 'coder');
      break;
    case 'verify.result': {
      const checks = (evt.checks || [])
        .map((c) => `${c.ok ? '✓' : '✗'} ${c.name}`)
        .join('\n');
      addTimeline(
        'verify',
        evt.ok ? 'Verify passed' : 'Verify failed',
        checks || evt.summary || '',
        evt.summary || '',
      );
      addLog('verifier', evt.ok ? 'info' : 'error', evt.summary || (evt.ok ? 'ok' : 'failed'), evt.ts);
      break;
    }
    case 'score.update':
      state.score = evt.score ?? state.score;
      state.max = evt.max ?? state.max;
      state.label = evt.label || state.label;
      renderScore();
      break;
    case 'run.complete':
      state.score = evt.score ?? state.score;
      state.label = evt.status || 'complete';
      renderScore();
      addLog('system', evt.status === 'failed' ? 'error' : 'info', evt.summary || 'run complete', evt.ts);
      resetRunBtn();
      $('runMeta').textContent = `${evt.status || 'complete'} · ${state.runId || ''}`;
      break;
    default:
      addLog('system', 'info', `event ${evt.type}`, evt.ts);
  }
}

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => {
    state.connected = true;
    setHealth('live');
  };
  ws.onclose = () => {
    state.connected = false;
    setHealth('down');
    setTimeout(connectWs, 1500);
  };
  ws.onerror = () => {};
  ws.onmessage = (e) => {
    try {
      handleEvent(JSON.parse(e.data));
    } catch {
      /* ignore */
    }
  };
}

async function refreshHealth() {
  try {
    const r = await fetch('/api/health');
    const j = await r.json();
    $('modePill').textContent = j.mode || 'unknown';
    $('modePill').className = 'pill mock';
    if (!state.connected) setHealth(j.ok ? 'mock' : 'down');
  } catch {
    setHealth('down');
  }
}

async function startRun() {
  const goal = $('goal').value.trim() || 'Add a hard spending cap demo path';
  const btn = $('runBtn');
  btn.disabled = true;
  btn.classList.add('busy');
  btn.dataset.label = btn.dataset.label || btn.textContent;
  btn.textContent = 'Forging…';
  document.querySelector('.shell')?.classList.add('running');
  $('timeline').innerHTML = '';
  $('log').innerHTML = '';
  state.agents = {};
  state.score = 0;
  state.label = 'starting';
  renderAgents();
  // Placeholder crew while spawn events arrive
  $('agents').innerHTML = ['Planner', 'Coder', 'Verifier']
    .map((n) => `<div class="agent-card loading"><div class="name"><span>${n}</span><span class="status queued">queued</span></div><div class="role">warming up</div></div>`)
    .join('');
  renderScore();
  $('runMeta').textContent = 'starting…';
  addTimeline('plan', 'Ignition', '', 'POST /api/run · waiting for Planner');
  addLog('system', 'info', 'forge run requested');
  try {
    const r = await fetch('/api/run', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ goal }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || 'run failed');
    state.runId = j.runId;
    $('runMeta').textContent = `run ${j.runId}`;
  } catch (e) {
    addLog('system', 'error', e.message || String(e));
    resetRunBtn();
  }
}

function resetRunBtn() {
  const btn = $('runBtn');
  btn.disabled = false;
  btn.classList.remove('busy');
  btn.textContent = btn.dataset.label || 'Run forge';
  document.querySelector('.shell')?.classList.remove('running');
}

$('runBtn').onclick = startRun;
$('goal').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') startRun();
});

renderAgents();
renderScore();
refreshHealth();
connectWs();
setInterval(refreshHealth, 5000);
