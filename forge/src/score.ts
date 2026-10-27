import type { RubricRow } from "./types.js";

/** Tests-pass / task-complete rubric. Scores are 0–100 so the dashboard meter fills. */
export function evaluate(input: { testsOk: boolean; exportOk: boolean }): {
  score: number;
  max: 100;
  label: "verify";
  passed: boolean;
  rubric: RubricRow[];
} {
  const tests = input.testsOk ? 60 : 0;
  const task = input.exportOk ? 40 : 0;
  const score = tests + task;
  return {
    score,
    max: 100,
    label: "verify",
    passed: score === 100,
    rubric: [
      { id: "tests_pass", label: "Tests pass", weight: 60, passed: input.testsOk, points: tests },
      { id: "task_complete", label: "Task complete", weight: 40, passed: input.exportOk, points: task },
    ],
  };
}
