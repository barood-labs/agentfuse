'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');

function homeDir() { return process.env.AGENTFUSE_HOME || path.join(os.homedir(), '.agentfuse'); }
function dayKey(d = new Date()) { // local calendar day
  const z = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}`;
}

class Ledger {
  constructor(dir = homeDir()) {
    this.dir = dir; this.file = path.join(dir, 'ledger.jsonl');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  append(rec) { fs.appendFileSync(this.file, JSON.stringify(rec) + '\n', { mode: 0o600 }); }
  read() {
    if (!fs.existsSync(this.file)) return [];
    return fs.readFileSync(this.file, 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }
  spentToday({ repo, day = dayKey() } = {}) {
    let s = 0;
    for (const r of this.read()) if (dayKey(new Date(r.ts)) === day && (!repo || r.repo === repo)) s += r.usd;
    return s;
  }
  summary({ days = 1 } = {}) {
    const since = Date.now() - days * 864e5;
    const rows = this.read().filter((r) => Date.parse(r.ts) >= since);
    const group = (k) => { const m = {}; for (const r of rows) { const key = r[k] || '?'; m[key] = m[key] || { usd: 0, requests: 0 }; m[key].usd += r.usd; m[key].requests++; } return m; };
    return { total: rows.reduce((a, r) => a + r.usd, 0), requests: rows.length, byModel: group('model'), byRepo: group('repo'), bySession: group('session') };
  }
}

function findRepo(cwd = process.cwd()) {
  let d = path.resolve(cwd);
  for (;;) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    const up = path.dirname(d); if (up === d) return path.resolve(cwd); d = up;
  }
}

module.exports = { Ledger, homeDir, dayKey, findRepo };
