import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { unifiedDiff } from "./diff.js";
import { acceptanceTestSource, LLM, planSteps, solutionSource, wantsFailure } from "./mock-llm.js";
import { createTools } from "./tools.js";
import type { AgentCard, EventType, ForgeEvent, RunState } from "./types.js";

const CREW: AgentCard[] = [
  { id: "planner", role: "planner", name: "Plan", status: "queued" },
  { id: "coder", role: "coder", name: "Code", status: "queued" },
  { id: "verifier", role: "verifier", name: "Verify", status: "queued" },
];

let seq = 0;

export function createRun(goal: string): RunState {
  const clean = String(goal || "Ship a hard cap demo").slice(0, 500);
  const id = `run_${Date.now().toString(36)}_${(++seq).toString(36)}`;
  return {
    id,
    goal: clean,
    status: "queued",
    score: 0,
    agents: {},
    events: [],
    createdAt: Date.now(),
    finishedAt: null,
    llm: LLM.id,
    label: LLM.label,
  };
}

export interface ExecuteOptions {
  tickMs?: number;
  onEvent?: (event: ForgeEvent) => void;
  maxIterations?: number;
}

function sleep(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Planner → Coder → Verifier.
 * The coder's first patch fails the pinned node:test file; the verifier scores it;
 * the coder fixes it. The model is the MOCK LLM (no network).
 */
export async function executeRun(run: RunState, options: ExecuteOptions = {}): Promise<void> {
  const tickMs = options.tickMs ?? 0;
  const maxIterations = options.maxIterations ?? 2;
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), "agentfuse-forge-"));
  const tools = createTools();
  const ctx = { workspace };
  const forceFail = wantsFailure(run.goal);

  const emit = (type: EventType, payload: Record<string, unknown> = {}) => {
    const event: ForgeEvent = { type, runId: run.id, ts: Date.now(), ...payload };
    run.events.push(event);
    if (type === "score.update" && typeof event.score === "number") run.score = event.score as number;
    options.onEvent?.(event);
  };

  const setStatus = (id: string, status: string) => {
    const agent = run.agents[id];
    if (!agent) return;
    agent.status = status;
    emit("agent.status", { agentId: id, status });
  };

  try {
    run.status = "running";
    for (const seed of CREW) {
      const agent: AgentCard = { ...seed, status: "spawning" };
      run.agents[agent.id] = agent;
      emit("agent.spawn", { agent: { ...agent } });
      await sleep(tickMs);
      agent.status = "ready";
      emit("agent.status", { agentId: agent.id, status: "ready" });
    }

    setStatus("planner", "running");
    emit("agent.log", {
      agentId: "planner",
      level: "info",
      mock: true,
      message: `MOCK LLM reading goal (${LLM.id}): ${run.goal}`,
    });

    const steps = planSteps(run.goal);
    for (let i = 0; i < steps.length; i++) {
      emit("plan.step", {
        agentId: "planner",
        index: i,
        total: steps.length,
        step: steps[i],
        status: "done",
      });
      emit("agent.log", { agentId: "planner", level: "info", mock: true, message: steps[i] });
      emit("score.update", { score: 8 * (i + 1), max: 100, label: "plan", provisional: true });
      await sleep(tickMs);
    }

    const testSource = acceptanceTestSource();
    const wroteTest = await tools.write_file.run({ path: "task.test.js", content: testSource }, ctx);
    emit("agent.log", {
      agentId: "planner",
      level: wroteTest.ok ? "info" : "error",
      mock: true,
      message: `tool write_file task.test.js · ${wroteTest.ok ? `${wroteTest.result.bytes} bytes` : wroteTest.error}`,
      tool: { name: "write_file", args: { path: "task.test.js" }, ok: wroteTest.ok },
    });
    if (!wroteTest.ok) throw new Error(wroteTest.error || "planner could not pin the acceptance test");
    emit("code.diff", {
      agentId: "planner",
      path: "task.test.js",
      patch: unifiedDiff("task.test.js", "", testSource),
    });
    setStatus("planner", "done");

    let lastScore = run.score;
    let lastOk = false;
    const iterations = Math.max(1, maxIterations);

    for (let iteration = 1; iteration <= iterations; iteration++) {
      setStatus("coder", "running");
      const passNote = forceFail && iteration >= 2
        ? `MOCK LLM pass ${iteration}/${iterations} — goal asked for failure, leaving the bug in`
        : iteration === 1
          ? `MOCK LLM pass ${iteration}/${iterations} — drafting a clamp that misses the cap on purpose`
          : `MOCK LLM pass ${iteration}/${iterations} — fixing the inverted clamp`;
      emit("agent.log", { agentId: "coder", level: "info", mock: true, message: passNote });

      const readPath = iteration === 1 ? "task.test.js" : "solution.js";
      const read = await tools.read_file.run({ path: readPath }, ctx);
      emit("agent.log", {
        agentId: "coder",
        level: read.ok ? "info" : "error",
        mock: true,
        message: `tool read_file ${readPath}${read.ok ? ` · ${read.result.bytes} bytes` : ` · ${read.error}`}`,
        tool: { name: "read_file", args: { path: readPath }, ok: read.ok },
      });

      const before = fs.existsSync(path.join(workspace, "solution.js"))
        ? fs.readFileSync(path.join(workspace, "solution.js"), "utf8")
        : "";
      const after = solutionSource(run.goal, iteration, forceFail);
      const wrote = await tools.write_file.run({ path: "solution.js", content: after }, ctx);
      emit("agent.log", {
        agentId: "coder",
        level: wrote.ok ? "info" : "error",
        mock: true,
        message: `tool write_file solution.js · ${wrote.ok ? `${wrote.result.bytes} bytes` : wrote.error}`,
        tool: { name: "write_file", args: { path: "solution.js" }, ok: wrote.ok },
      });
      if (!wrote.ok) throw new Error(wrote.error || "coder could not write solution.js");
      emit("code.diff", {
        agentId: "coder",
        path: "solution.js",
        patch: unifiedDiff("solution.js", before, after),
        iteration,
      });
      emit("score.update", {
        score: iteration === 1 ? 40 : 70,
        max: 100,
        label: "code",
        provisional: true,
      });
      setStatus("coder", "done");
      await sleep(tickMs);

      setStatus("verifier", "running");
      emit("agent.log", { agentId: "verifier", level: "info", mock: true, message: "Running checks…" });
      const tests = await tools.run_tests.run({}, ctx);
      const testsOk = tests.result.ok === true;
      const checks = Array.isArray(tests.result.checks) ? tests.result.checks : [];
      const summary = String(tests.result.summary || (testsOk ? "All checks green" : "checks failed"));
      emit("agent.log", {
        agentId: "verifier",
        level: testsOk ? "info" : "error",
        mock: true,
        message: `tool run_tests · ${tests.result.passed ?? 0} pass / ${tests.result.failed ?? 0} fail`,
        tool: { name: "run_tests", ok: testsOk },
      });
      emit("verify.result", {
        agentId: "verifier",
        ok: testsOk,
        checks,
        summary,
        iteration,
      });

      const scored = await tools.score.run({ testsOk }, ctx);
      const score = Number(scored.result.score ?? 0);
      const exportOk = scored.result.exportOk === true;
      lastScore = score;
      lastOk = scored.result.passed === true;
      emit("agent.log", {
        agentId: "verifier",
        level: "info",
        mock: true,
        message: `tool score · ${score}/100 · tests_pass ${testsOk ? "pass" : "fail"} · task_complete ${exportOk ? "pass" : "fail"}`,
        tool: { name: "score", ok: true, result: { score, exportOk, testsOk } },
      });
      emit("score.update", {
        score,
        max: 100,
        label: "verify",
        provisional: false,
        rubric: scored.result.rubric,
      });
      await sleep(tickMs);

      if (lastOk || iteration === iterations) {
        setStatus("verifier", lastOk ? "done" : "error");
        break;
      }
      emit("agent.log", {
        agentId: "verifier",
        level: "info",
        mock: true,
        message: "MOCK eval: below the bar — returning the patch to coder",
      });
      setStatus("verifier", "ready");
    }

    run.status = lastOk ? "complete" : "failed";
    run.score = lastScore;
    run.finishedAt = Date.now();
    emit("run.complete", {
      status: run.status,
      score: run.score,
      summary: lastOk
        ? `Forge run complete for “${run.goal.slice(0, 80)}”`
        : `Forge run finished with failures for “${run.goal.slice(0, 80)}”`,
      llm: LLM.id,
      label: LLM.label,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    run.status = "failed";
    run.finishedAt = Date.now();
    emit("agent.log", { agentId: "system", level: "error", mock: true, message });
    emit("run.complete", {
      status: "failed",
      score: run.score,
      summary: message,
      llm: LLM.id,
      label: LLM.label,
    });
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}
