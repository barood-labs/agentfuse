'use strict';
const { EventEmitter } = require('events');

/**
 * Budget state machine. Tracks committed spend for this session plus the
 * pre-existing daily / per-repo spend, and decides ok | warn | blown.
 */
class Fuse extends EventEmitter {
  constructor({ cap = Infinity, daily = Infinity, repoCap = Infinity, warnAt = 0.8, baseDaily = 0, baseRepo = 0 } = {}) {
    super();
    Object.assign(this, { cap, daily, repoCap, warnAt, baseDaily, baseRepo });
    this.spent = 0; this.inflight = 0; this.requests = 0; this.state = 'ok'; this.reason = null;
  }
  limits() {
    return [
      { name: 'session', used: this.spent + this.inflight, cap: this.cap },
      { name: 'daily', used: this.baseDaily + this.spent + this.inflight, cap: this.daily },
      { name: 'repo', used: this.baseRepo + this.spent + this.inflight, cap: this.repoCap },
    ].filter((l) => Number.isFinite(l.cap));
  }
  /** Highest fraction used across all limits. */
  ratio() { return this.limits().reduce((m, l) => Math.max(m, l.cap > 0 ? l.used / l.cap : 1), 0); }
  tightest() { return this.limits().sort((a, b) => b.used / b.cap - a.used / a.cap)[0] || null; }
  remaining() { return this.limits().reduce((m, l) => Math.min(m, l.cap - l.used), Infinity); }
  isBlown() { return this.limits().some((l) => l.used >= l.cap); }
  setInflight(usd) { this.inflight = usd; this._eval(); }
  commit(usd) { this.inflight = 0; this.spent += usd; this.requests++; this._eval(); this.emit('commit', usd); }
  raise(usd) {
    for (const k of ['cap', 'daily', 'repoCap']) if (Number.isFinite(this[k])) this[k] += usd;
    this._eval(true); this.emit('raise', usd);
  }
  _eval(force) {
    const prev = this.state;
    const r = this.ratio();
    this.state = this.isBlown() ? 'blown' : r >= this.warnAt ? 'warn' : 'ok';
    if (this.state === 'blown') { const t = this.tightest(); this.reason = t ? `${t.name} cap $${t.cap.toFixed(2)} reached` : 'cap reached'; }
    if (prev !== this.state || force) this.emit('state', this.state, prev);
    this.emit('tick');
  }
}

module.exports = { Fuse };
