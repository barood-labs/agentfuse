'use strict';
const usd = (n) => (n < 10 ? `$${n.toFixed(3)}` : `$${n.toFixed(2)}`);

function bar(ratio, width = 20) {
  const r = Math.max(0, Math.min(1, ratio));
  const full = Math.round(r * width);
  return '█'.repeat(full) + '░'.repeat(width - full);
}
function color(state, s, enabled = true) {
  if (!enabled) return s;
  const c = state === 'blown' ? '31;1' : state === 'warn' ? '33' : '32';
  return `\x1b[${c}m${s}\x1b[0m`;
}
function line(fuse, { colors = true } = {}) {
  const t = fuse.tightest();
  const icon = fuse.state === 'blown' ? '💥 FUSE BLOWN' : fuse.state === 'warn' ? '⚠️  agentfuse' : '⚡ agentfuse';
  if (!t) return `${icon} ${usd(fuse.spent)} spent · ${fuse.requests} req · no cap`;
  const ratio = t.used / t.cap;
  return `${color(fuse.state, `${icon} ${bar(ratio)} ${usd(t.used)} / ${usd(t.cap)}`, colors)} ${t.name} · ${fuse.requests} req`;
}
function title(fuse) {
  const t = fuse.tightest();
  const pct = t ? Math.round((t.used / t.cap) * 100) : 0;
  return `${fuse.state === 'blown' ? '💥' : fuse.state === 'warn' ? '⚠️' : '⚡'} ${usd(fuse.spent)}${t ? ` / ${usd(t.cap)} (${pct}%)` : ''}`;
}
module.exports = { line, title, bar, usd };
