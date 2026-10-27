import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { evaluate } from "./score.js";
import type { Check, ToolName } from "./types.js";

const require = createRequire(import.meta.url);

export interface ToolContext {
  workspace: string;
}

export interface ToolResult {
  ok: boolean;
  result: Record<string, unknown>;
  error?: string;
}

export interface Tool {
  name: ToolName;
  description: string;
  run(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
}

const MAX_FILE = 100_000;

export function safePath(workspace: string, rel: string): string {
  if (typeof rel !== "string" || !rel.trim()) throw new Error("path required");
  if (rel.includes("\0")) throw new Error("path refused");
  if (path.isAbsolute(rel)) throw new Error("absolute paths are refused");
  const root = path.resolve(workspace);
  const full = path.resolve(root, rel);
  if (full !== root && !full.startsWith(root + path.sep)) throw new Error("path escapes workspace");
  return full;
}

export function parseTap(text: string, exitCode: number | null): {
  ok: boolean;
  passed: number;
  failed: number;
  total: number;
  checks: Check[];
  summary: string;
} {
  const checks: Check[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = /^(not )?ok \d+ - (.+?)(?:\s+#.*)?$/.exec(line);
    if (!match) continue;
    const name = match[2].trim();
    checks.push({ name, ok: !match[1] });
  }
  const tests = /# tests (\d+)/.exec(text);
  const pass = /# pass (\d+)/.exec(text);
  const fail = /# fail (\d+)/.exec(text);
  let total = tests ? Number(tests[1]) : 0;
  let passed = pass ? Number(pass[1]) : 0;
  let failed = fail ? Number(fail[1]) : 0;
  if (!total && checks.length) {
    total = checks.length;
    passed = checks.filter((c) => c.ok).length;
    failed = total - passed;
  }
  const ok = exitCode === 0 && failed === 0 && total > 0;
  const summary = ok
    ? `All checks green (${passed}/${total})`
    : `${failed} failed, ${passed} passed (${total || checks.length} total)`;
  return { ok, passed, failed, total, checks, summary };
}

function taskComplete(workspace: string): boolean {
  const file = path.join(workspace, "solution.js");
  if (!fs.existsSync(file)) return false;
  try {
    const resolved = require.resolve(file);
    delete require.cache[resolved];
    const mod = require(file) as { clampSpend?: unknown };
    return typeof mod.clampSpend === "function";
  } catch {
    return false;
  }
}

async function runNodeTests(workspace: string): Promise<ToolResult> {
  const spec = path.join(workspace, "task.test.js");
  if (!fs.existsSync(spec)) {
    return {
      ok: false,
      error: "task.test.js missing",
      result: { ok: false, passed: 0, failed: 0, total: 0, checks: [], summary: "task.test.js missing", output: "" },
    };
  }
  const { code, output } = await spawnNodeTest(workspace);
  const parsed = parseTap(output, code);
  return {
    ok: parsed.ok,
    result: { ...parsed, output: output.slice(0, 4000) },
  };
}

function spawnNodeTest(workspace: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve) => {
    const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: "1" };
    // A forge run is often launched from `node --test`. Drop the parent's
    // test-runner IPC and context so this child is a normal TAP process.
    for (const key of Object.keys(env)) {
      if (key.startsWith("NODE_CHANNEL") || key.startsWith("NODE_TEST")) delete env[key];
    }
    env.NODE_TEST_REPORTER = "tap";
    const child = spawn(process.execPath, ["--test", "task.test.js"], {
      cwd: workspace,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const chunks: Buffer[] = [];
    let size = 0;
    const take = (buf: Buffer) => {
      if (size >= 100_000) return;
      chunks.push(buf);
      size += buf.length;
    };
    child.stdout?.on("data", take);
    child.stderr?.on("data", take);
    const timer = setTimeout(() => child.kill(), 15_000);
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 1, output: String(err.message || err) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, output: Buffer.concat(chunks).toString("utf8") });
    });
  });
}

export function createTools(): Record<ToolName, Tool> {
  return {
    read_file: {
      name: "read_file",
      description: "Read a UTF-8 file inside the run workspace.",
      async run(args, ctx) {
        try {
          const full = safePath(ctx.workspace, String(args.path ?? ""));
          if (!fs.existsSync(full)) return { ok: false, error: "not found", result: { path: args.path, found: false } };
          const content = fs.readFileSync(full, "utf8");
          return { ok: true, result: { path: args.path, bytes: Buffer.byteLength(content), content: content.slice(0, 8000) } };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err), result: {} };
        }
      },
    },
    write_file: {
      name: "write_file",
      description: "Write a UTF-8 file inside the run workspace.",
      async run(args, ctx) {
        try {
          const rel = String(args.path ?? "");
          const content = String(args.content ?? "");
          if (Buffer.byteLength(content) > MAX_FILE) return { ok: false, error: "file too large", result: {} };
          const full = safePath(ctx.workspace, rel);
          fs.mkdirSync(path.dirname(full), { recursive: true });
          fs.writeFileSync(full, content);
          return { ok: true, result: { path: rel, bytes: Buffer.byteLength(content) } };
        } catch (err) {
          return { ok: false, error: err instanceof Error ? err.message : String(err), result: {} };
        }
      },
    },
    run_tests: {
      name: "run_tests",
      description: "Run task.test.js with node --test inside the workspace.",
      async run(_args, ctx) {
        return runNodeTests(ctx.workspace);
      },
    },
    score: {
      name: "score",
      description: "Score the attempt: tests pass (60) and task complete (40).",
      async run(args, ctx) {
        const exportOk = taskComplete(ctx.workspace);
        const testsOk = args.testsOk === true;
        const scored = evaluate({ testsOk, exportOk });
        return { ok: true, result: { ...scored, exportOk } };
      },
    },
  };
}
