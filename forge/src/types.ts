/** Wire names the neon dashboard in public/ already renders. Do not rename. */
export const EVENT_TYPES = [
  "agent.spawn",
  "agent.status",
  "agent.log",
  "plan.step",
  "code.diff",
  "verify.result",
  "score.update",
  "run.complete",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const TOOL_NAMES = ["read_file", "write_file", "run_tests", "score"] as const;
export type ToolName = (typeof TOOL_NAMES)[number];

export interface AgentCard {
  id: string;
  role: "planner" | "coder" | "verifier";
  name: string;
  status: string;
}

export interface ForgeEvent {
  type: EventType;
  runId: string;
  ts: number;
  [key: string]: unknown;
}

export interface RunState {
  id: string;
  goal: string;
  status: "queued" | "running" | "complete" | "failed";
  score: number;
  agents: Record<string, AgentCard>;
  events: ForgeEvent[];
  createdAt: number;
  finishedAt: number | null;
  llm: "mock-llm";
  label: "MOCK";
}

export interface Check {
  name: string;
  ok: boolean;
}

export interface RubricRow {
  id: "tests_pass" | "task_complete";
  label: string;
  weight: number;
  passed: boolean;
  points: number;
}
