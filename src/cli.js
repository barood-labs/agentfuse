'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Fuse } = require('./fuse');
const { startProxy } = require('./proxy');
const { makePricer, PRICES_CHECKED } = require('./pricing');
const { Ledger, homeDir, findRepo } = require('./ledger');
const meter = require('./meter');
const pkg = require('../package.json');

const HELP = `agentfuse ${pkg.version} — a hard spending cap and kill switch for AI coding agents.

Usage:
  agentfuse [options] -- <command> [args...]   run an agent behind the fuse
  agentfuse serve [options]                    run only the proxy (prints env to export)
  agentfuse status                             live state of running sessions
  agentfuse raise <usd> [--session id]         add budget to a running/paused session
  agentfuse report [--days N] [--json]         spend from the local ledger

Options:
  -c, --cap <usd>        session cap (default: $5, or AGENTFUSE_CAP)
  -d, --daily <usd>      cap across all sessions today
  -r, --repo-cap <usd>   cap for this git repo today
  -w, --warn <0-1>       warn threshold (default 0.8)
  --on-cap <mode>        kill (default) | pause | block
  --no-preflight         don't block a request whose estimated cost would cross the cap
  --no-strict            let an in-flight response finish even if it crosses the cap
  --prices <file.json>   override/extend the price table ({"model-prefix": {"input":..,"output":..}})
  --port <n>             proxy port (default: random)
  --quiet                no meter output (title bar still updates)
  --receipt <file>       also write the receipt JSON here
  -h, --help, -v, --version

Examples:
  npx github:barood-labs/agentfuse --cap 2 -- claude
  npx github:barood-labs/agentfuse --cap 10 --daily 30 --on-cap pause -- codex
  agentfuse --cap 1 -- gemini                   # Gemini CLI (GOOGLE_GEMINI_BASE_URL)
  agentfuse --cap 1 -- python my_agent.py      # any tool that honours *_BASE_URL

Exit codes: child's own code, or 86 when the fuse killed it.
Prices: built-in table checked ${PRICES_CHECKED}; unknown models are billed at a high fallback rate.
Not on npm yet (the "agentfuse" npm name is someone else's). Use npx github:barood-labs/agentfuse.`;

const FUSE_EXIT = 86;

function parseArgs(argv) {
  const o = { cap: Number(process.env.AGENTFUSE_CAP) || 5, daily: Infinity, repoCap: Infinity, warn: 0.8, onCap: 'kill', strict: true, preflight: true, port: 0, quiet: false, cmd: [], sub: null, pos: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]; const next = () => { const v = argv[++i]; if (v === undefined) throw new Error(`${a} needs a value`); return v; };
    const num = (v) => { const n = Number(String(v).replace(/^\$/, '')); if (!(n >= 0)) throw new Error(`${a}: "${v}" is not a number`); return n; };
    if (a === '--') { o.cmd = argv.slice(i + 1); break; }
    else if (a === '-h' || a === '--help') o.help = true;
    else if (a === '-v' || a === '--version') o.version = true;
    else if (a === '-c' || a === '--cap') o.cap = num(next());
    else if (a === '-d' || a === '--daily') o.daily = num(next());
    else if (a === '-r' || a === '--repo-cap') o.repoCap = num(next());
    else if (a === '-w' || a === '--warn') o.warn = num(next());
    else if (a === '--on-cap') { o.onCap = next(); if (!['kill', 'pause', 'block'].includes(o.onCap)) throw new Error('--on-cap must be kill, pause or block'); }
    else if (a === '--no-strict') o.strict = false;
    else if (a === '--no-preflight') o.preflight = false;
    else if (a === '--prices') o.prices = next();
    else if (a === '--port') o.port = num(next());
    else if (a === '--quiet') o.quiet = true;
    else if (a === '--receipt') o.receipt = next();
    else if (a === '--session') o.session = next();
    else if (a === '--days') o.days = num(next());
    else if (a === '--json') o.json = true;
    else if (a.startsWith('-')) throw new Error(`unknown option ${a}`);
    else if (!o.sub && ['serve', 'status', 'raise', 'report'].includes(a)) o.sub = a;
    else o.pos.push(a);
  }
  return o;
}

function sessionsDir() { const d = path.join(homeDir(), 'sessions'); fs.mkdirSync(d, { recursive: true, mode: 0o700 }); return d; }
function liveSessions() {
  const d = sessionsDir();
  return fs.readdirSync(d).filter((f) => f.endsWith('.json')).map((f) => { try { return JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); } catch { return null; } })
    .filter((s) => s && isAlive(s.pid));
}
function isAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function getJSON(url, method = 'GET', body, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request(url, { method, headers: { 'content-type': 'application/json', ...headers } }, (res) => { let s = ''; res.on('data', (c) => (s += c)); res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(e); } }); });
    r.on('error', reject); r.end(body ? JSON.stringify(body) : undefined);
  });
}

/** If the user already points an SDK at a gateway (e.g. OPENAI_BASE_URL=https://openrouter.ai/api/v1), chain to it. */
function inheritedUpstreams(env = process.env) {
  const ups = {};
  const own = (u) => /^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/(anthropic|openai|gemini|openrouter)/.test(u || '');
  const take = (k, envName, stripV1) => { const u = env[envName]; if (u && !own(u)) ups[k] = stripV1 ? u.replace(/\/+$/, '').replace(/\/v1$/, '') : u.replace(/\/+$/, ''); };
  take('anthropic', 'ANTHROPIC_BASE_URL'); take('openai', 'OPENAI_BASE_URL', true); take('gemini', 'GOOGLE_GEMINI_BASE_URL'); take('openrouter', 'OPENROUTER_BASE_URL', true);
  // explicit AGENTFUSE_*_UPSTREAM always wins
  for (const k of ['anthropic', 'openai', 'gemini', 'openrouter']) { const e = env[`AGENTFUSE_${k.toUpperCase()}_UPSTREAM`]; if (e) ups[k] = e; }
  return ups;
}

async function setup(o, { log }) {
  const ledger = new Ledger();
  const repo = findRepo();
  const pricer = makePricer(o.prices ? JSON.parse(fs.readFileSync(o.prices, 'utf8')) : {});
  const fuse = new Fuse({ cap: o.cap || Infinity, daily: o.daily, repoCap: o.repoCap, warnAt: o.warn, baseDaily: ledger.spentToday(), baseRepo: ledger.spentToday({ repo }) });
  const session = o.session || `${new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${crypto.randomBytes(2).toString('hex')}`;
  const token = crypto.randomBytes(16).toString('hex');
  const ups = inheritedUpstreams();
  for (const [k, v] of Object.entries(ups)) log(`${k} upstream: ${v} (from your environment)`);
  const proxy = await startProxy({ token, fuse, pricer, ledger, onCap: o.onCap, port: o.port, session, repo, strict: o.strict, preflight: o.preflight, upstreams: ups, log });
  const sfile = path.join(sessionsDir(), `${session}.json`);
  fs.writeFileSync(sfile, JSON.stringify({ session, pid: process.pid, url: proxy.url, token, repo, startedAt: new Date().toISOString() }), { mode: 0o600 });
  const env = {
    ANTHROPIC_BASE_URL: `${proxy.url}/anthropic`,
    OPENAI_BASE_URL: `${proxy.url}/openai/v1`,
    OPENAI_API_BASE: `${proxy.url}/openai/v1`,
    GOOGLE_GEMINI_BASE_URL: `${proxy.url}/gemini`,
    OPENROUTER_BASE_URL: `${proxy.url}/openrouter/v1`,
    AGENTFUSE_URL: proxy.url,
    AGENTFUSE_SESSION: session,
  };
  return { ledger, repo, pricer, fuse, session, proxy, sfile, env };
}

function receipt(ctx, extra) {
  const rows = ctx.ledger.read().filter((r) => r.session === ctx.session);
  const byModel = {};
  for (const r of rows) { const m = (byModel[r.model] ||= { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, usd: 0 }); m.requests++; for (const k of ['input', 'output', 'cacheRead', 'cacheWrite', 'usd']) m[k] += r[k] || 0; }
  const rec = { session: ctx.session, repo: ctx.repo, spent: +ctx.fuse.spent.toFixed(6), requests: ctx.fuse.requests, state: ctx.fuse.state, reason: ctx.fuse.reason, limits: ctx.fuse.limits(), byModel, unknownModels: [...new Set(rows.filter((r) => !r.priceKnown).map((r) => r.model))], ...extra };
  const dir = path.join(homeDir(), 'receipts'); fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${ctx.session}.json`);
  fs.writeFileSync(file, JSON.stringify(rec, null, 2));
  return { rec, file };
}

async function run(argv) {
  let o;
  try { o = parseArgs(argv); } catch (e) { console.error(`agentfuse: ${e.message}\n\n${HELP}`); return 2; }
  if (o.version) { console.log(pkg.version); return 0; }
  if (o.help || (!o.sub && !o.cmd.length)) { console.log(HELP); return o.help ? 0 : 2; }

  if (o.sub === 'status') {
    const live = liveSessions();
    if (!live.length) { console.log('no running agentfuse sessions'); return 0; }
    for (const s of live) { try { const st = await getJSON(`${s.url}/_agentfuse/status`); console.log(JSON.stringify(st, null, o.json ? 2 : 0)); } catch { console.log(`${s.session}: unreachable`); } }
    return 0;
  }
  if (o.sub === 'raise') {
    const amt = Number(String(o.pos[0] || '').replace(/^\$/, ''));
    if (!(amt > 0)) { console.error('usage: agentfuse raise <usd>'); return 2; }
    const live = liveSessions().filter((s) => !o.session || s.session === o.session);
    if (!live.length) { console.error('no running agentfuse session found'); return 1; }
    const s = live.sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
    const st = await getJSON(`${s.url}/_agentfuse/raise`, 'POST', { usd: amt }, { 'x-agentfuse-token': s.token });
    if (st.error) { console.error(`agentfuse: ${st.error}`); return 1; }
    console.log(`raised ${s.session} by $${amt} → state ${st.state}`); return 0;
  }
  if (o.sub === 'report') {
    const sum = new Ledger().summary({ days: o.days || 1 });
    if (o.json) { console.log(JSON.stringify(sum, null, 2)); return 0; }
    console.log(`last ${o.days || 1} day(s): ${meter.usd(sum.total)} over ${sum.requests} requests`);
    for (const [title, g] of [['by model', sum.byModel], ['by repo', sum.byRepo]]) {
      console.log(`\n${title}:`);
      for (const [k, v] of Object.entries(g).sort((a, b) => b[1].usd - a[1].usd)) console.log(`  ${meter.usd(v.usd).padStart(9)}  ${String(v.requests).padStart(5)} req  ${k}`);
    }
    return 0;
  }

  const tty = !!process.stderr.isTTY && !process.env.NO_COLOR;
  const say = (s) => { if (!o.quiet) process.stderr.write(`${s}\n`); };
  const setTitle = () => { if (tty) process.stderr.write(`\x1b]2;${meter.title(ctx.fuse)}\x07`); };
  let ctx;
  const log = (rec) => { if (typeof rec === 'string') say(`[agentfuse] ${rec}`); else if (process.env.AGENTFUSE_DEBUG) say(JSON.stringify(rec)); };
  ctx = await setup(o, { log });
  const { fuse } = ctx;
  let lastPrinted = -1;
  fuse.on('commit', () => {
    setTitle();
    // print a meter line on every 10% step, and always in warn/blown
    const step = Math.floor(fuse.ratio() * 10);
    if (step !== lastPrinted || fuse.state !== 'ok') { lastPrinted = step; say(meter.line(fuse, { colors: tty })); }
  });

  if (o.sub === 'serve') {
    say(`agentfuse proxy on ${ctx.proxy.url} (session ${ctx.session}, cap ${meter.usd(o.cap)}). Export:`);
    for (const [k, v] of Object.entries(ctx.env)) console.log(`export ${k}=${v}`);
    await new Promise((r) => { process.on('SIGINT', r); process.on('SIGTERM', r); });
    await ctx.proxy.close(); fs.rmSync(ctx.sfile, { force: true });
    const { file } = receipt(ctx, { mode: 'serve' }); say(`receipt: ${file}`); return 0;
  }

  say(meter.line(fuse, { colors: tty }) + `  · on-cap: ${o.onCap}`);
  setTitle();
  const child = spawn(o.cmd[0], o.cmd.slice(1), { stdio: 'inherit', env: { ...process.env, ...ctx.env } });
  let killedByFuse = false;
  fuse.on('state', (s, prev) => {
    if (s === 'warn' && prev === 'ok') say(`[agentfuse] ⚠ ${Math.round(o.warn * 100)}% of budget used`);
    if (s === 'blown') {
      say(meter.line(fuse, { colors: tty }) + `  — ${fuse.reason}`);
      if (o.onCap === 'kill' && !killedByFuse) {
        killedByFuse = true;
        say('[agentfuse] stopping agent (SIGTERM)…');
        child.kill('SIGTERM');
        setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 3000).unref();
      } else if (o.onCap === 'pause') say(`[agentfuse] agent paused. Run \`agentfuse raise 5\` in another terminal to add $5, or Ctrl-C to stop.`);
      else if (o.onCap === 'block') say('[agentfuse] blocking further model calls (HTTP 402).');
    }
  });
  const fwd = (sig) => () => child.kill(sig);
  process.on('SIGINT', fwd('SIGINT')); process.on('SIGTERM', fwd('SIGTERM'));

  const code = await new Promise((resolve) => {
    child.on('error', (e) => { say(`agentfuse: could not start "${o.cmd[0]}": ${e.message}`); resolve(127); });
    child.on('exit', (c, sig) => resolve(c ?? (sig ? 128 : 1)));
  });
  await ctx.proxy.close(); fs.rmSync(ctx.sfile, { force: true });
  const { rec, file } = receipt(ctx, { command: o.cmd.join(' '), killedByFuse, exitCode: killedByFuse ? FUSE_EXIT : code });
  if (o.receipt) fs.writeFileSync(o.receipt, JSON.stringify(rec, null, 2));
  say(`\n▤ agentfuse receipt — ${meter.usd(rec.spent)} across ${rec.requests} request(s)${killedByFuse ? ' — agent stopped by fuse' : ''}`);
  for (const [m, v] of Object.entries(rec.byModel)) say(`   ${meter.usd(v.usd).padStart(9)}  ${m}  (in ${v.input}, out ${v.output}, cache r/w ${v.cacheRead}/${v.cacheWrite})`);
  if (rec.unknownModels.length) say(`   ⚠ unknown price for ${rec.unknownModels.join(', ')} — billed at fallback (pessimistic) rate; add them with --prices`);
  say(`   ${file}`);
  if (tty) process.stderr.write('\x1b]2;\x07');
  return killedByFuse ? FUSE_EXIT : code;
}

module.exports = { run, parseArgs, inheritedUpstreams, FUSE_EXIT, HELP };
