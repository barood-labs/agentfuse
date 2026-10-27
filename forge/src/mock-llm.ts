/**
 * MOCK LLM.
 * Deterministic stub. It does not call a network, read an API key, or spend money.
 * Every draft it returns is labeled MOCK. Provider id: mock-llm.
 */
export const LLM = {
  id: "mock-llm" as const,
  label: "MOCK" as const,
  callsNetwork: false,
};

export function wantsFailure(goal: string): boolean {
  return /\b(fail|broken)\b/i.test(goal);
}

export function planSteps(goal: string): string[] {
  const short = goal.trim().replace(/\s+/g, " ").slice(0, 72) || "untitled goal";
  return [
    `Parse goal: ${short}`,
    "Sketch approach: clampSpend helper + node:test acceptance",
    "Draft implementation plan (MOCK LLM — pass 1 is allowed to miss)",
    "Identify verify checks: under cap, over cap, equal cap",
  ];
}

/** Acceptance test the planner pins. The coder is not allowed to edit it. */
export function acceptanceTestSource(): string {
  return `'use strict';
// Pinned by Planner. MOCK harness — no API key, no network.
// The coder may only write solution.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const { clampSpend } = require('./solution.js');

test('under cap returns spent', () => {
  assert.equal(clampSpend(0.4, 1), 0.4);
});

test('over cap clamps to the cap', () => {
  assert.equal(clampSpend(1.5, 1), 1);
});

test('equal to cap stays', () => {
  assert.equal(clampSpend(1, 1), 1);
});
`;
}

/**
 * Iteration 1 writes an inverted clamp so the verifier fails for real.
 * Iteration 2 fixes it, unless the goal asked the run to fail.
 */
export function solutionSource(goal: string, iteration: number, forceFail: boolean): string {
  const note = JSON.stringify(goal.slice(0, 240));
  const broken = iteration < 2 || forceFail;
  const body = broken
    ? `function clampSpend(spent, cap) {
  // MOCK draft (pass ${iteration}) — inverted on purpose so the eval loop has a miss to score.
  return spent > cap ? spent : cap;
}`
    : `function clampSpend(spent, cap) {
  // MOCK fix (pass ${iteration}) — stop at the cap. Still not a network model.
  const spentN = Number(spent);
  const capN = Number(cap);
  return spentN > capN ? capN : spentN;
}`;
  return `'use strict';
// MOCK LLM output. model=${LLM.id} label=${LLM.label} callsNetwork=false
// goal: ${note}
${body}
module.exports = { clampSpend };
`;
}
