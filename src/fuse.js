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
    this.spent = 0; this._inflight = new Map(); this.tripped = null; this.requests = 0; this.state = 'ok'; this.reason = null;
  }
  get inflight() { let t = 0; for (const v of this._inflight.values()) t += v; return t; }
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
  isBlown() { return !!this.tripped || this.limits().some((l) => l.used >= l.cap); }
  /** Would spending `usd` more (on top of committed + in-flight) break a cap? Returns the limit or null. */
  wouldExceed(usd) { return this.limits().find((l) => l.used + usd > l.cap) || null; }
  /** Blow the fuse pre-emptively (e.g. the next request would cross the cap). */
  trip(reason) { this.tripped = reason; this._eval(); }
  setInflight(id, usd) { if (usd === undefined) { usd = id; id = 'default'; } this._inflight.set(id, usd); this._eval(); }
  release(id = 'default') { this._inflight.delete(id); this._eval(); }
  commit(id, usd) { if (usd === undefined) { usd = id; id = 'default'; } this._inflight.delete(id); this.spent += usd; this.requests++; this._eval(); this.emit('commit', usd); }
  raise(usd) {
    for (const k of ['cap', 'daily', 'repoCap']) if (Number.isFinite(this[k])) this[k] += usd;
    this.tripped = null;
    this._eval(true); this.emit('raise', usd);
  }
  _eval(force) {
    const prev = this.state;
    const r = this.ratio();
    this.state = this.isBlown() ? 'blown' : r >= this.warnAt ? 'warn' : 'ok';
    if (this.state === 'blown' && this.tripped) this.reason = this.tripped;
    else if (this.state === 'blown') { const t = this.tightest(); this.reason = t ? `${t.name} cap $${t.cap.toFixed(2)} reached` : 'cap reached'; }
    if (prev !== this.state || force) this.emit('state', this.state, prev);
    this.emit('tick');
  }
}

module.exports = { Fuse };
