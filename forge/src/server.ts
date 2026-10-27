import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRun, executeRun } from "./orchestrator.js";
import { EVENT_TYPES, type ForgeEvent, type RunState } from "./types.js";
import { LLM } from "./mock-llm.js";
import { loadWsHub, type WsHub } from "./ws-hub.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultPublic = path.resolve(here, "..", "..", "public");

export interface ForgeServer {
  port: number;
  url: string;
  wsUrl: string;
  close(): Promise<void>;
  runs: Map<string, RunState>;
}

export interface StartOptions {
  port?: number;
  host?: string;
  tickMs?: number;
  publicDir?: string;
}

function cors(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type",
  };
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", ...cors() });
  res.end(data);
}

function mime(file: string): string {
  if (file.endsWith(".html")) return "text/html; charset=utf-8";
  if (file.endsWith(".js")) return "text/javascript; charset=utf-8";
  if (file.endsWith(".css")) return "text/css; charset=utf-8";
  if (file.endsWith(".svg")) return "image/svg+xml";
  if (file.endsWith(".png")) return "image/png";
  if (file.endsWith(".gif")) return "image/gif";
  return "application/octet-stream";
}

function resolvePublic(publicDir: string, pathname: string): string | null {
  let rel: string;
  if (pathname === "/" || pathname === "/ui" || pathname === "/ui/") rel = "index.html";
  else if (pathname.startsWith("/ui/")) rel = pathname.slice("/ui/".length);
  else rel = pathname.replace(/^\/+/, "");
  if (!rel || rel.includes("\0")) return null;
  const root = path.resolve(publicDir);
  const file = path.resolve(root, rel);
  if (file !== root && !file.startsWith(root + path.sep)) return null;
  return file;
}

async function readBody(req: http.IncomingMessage, limit = 65_536): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buf.length;
    if (size > limit) throw new Error("body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function startForge(options: StartOptions = {}): Promise<ForgeServer> {
  const port = options.port ?? 0;
  const host = options.host;
  const tickMs = options.tickMs ?? 280;
  const publicDir = options.publicDir ?? defaultPublic;
  const runs = new Map<string, RunState>();

  const server = http.createServer(async (req, res) => {
    try {
      await route(req, res);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!res.headersSent) sendJson(res, message === "body too large" ? 413 : 500, { ok: false, error: message });
      else res.end();
    }
  });

  const wss = await loadWsHub(server);

  async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);

    if (req.method === "OPTIONS") {
      res.writeHead(204, cors());
      res.end();
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/health") {
      sendJson(res, 200, {
        ok: true,
        service: "agentfuse-forge",
        mode: "mock",
        llm: LLM.id,
        label: LLM.label,
        engine: "planner-coder-verifier",
        version: "0.1.0-forge",
        wsPath: "/ws",
        clients: wss.size,
        events: EVENT_TYPES,
      });
      return;
    }

    if (req.method === "GET" && url.pathname.startsWith("/api/run/")) {
      const id = decodeURIComponent(url.pathname.slice("/api/run/".length));
      if (!/^run_[a-z0-9_]+$/i.test(id)) {
        sendJson(res, 404, { ok: false, error: "not_found" });
        return;
      }
      const run = runs.get(id);
      if (!run) {
        sendJson(res, 404, { ok: false, error: "not_found" });
        return;
      }
      sendJson(res, 200, {
        ok: true,
        run: {
          id: run.id,
          goal: run.goal,
          status: run.status,
          score: run.score,
          agents: run.agents,
          createdAt: run.createdAt,
          finishedAt: run.finishedAt,
          events: run.events,
          llm: run.llm,
          label: run.label,
        },
      });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/run") {
      let parsed: { goal?: unknown; prompt?: unknown } = {};
      try {
        const raw = await readBody(req);
        parsed = raw ? (JSON.parse(raw) as { goal?: unknown; prompt?: unknown }) : {};
      } catch (err) {
        const tooBig = err instanceof Error && err.message === "body too large";
        sendJson(res, tooBig ? 413 : 400, { ok: false, error: tooBig ? "body_too_large" : "invalid_json" });
        return;
      }
      const goal = typeof parsed.goal === "string" && parsed.goal.trim()
        ? parsed.goal
        : typeof parsed.prompt === "string" && parsed.prompt.trim()
          ? parsed.prompt
          : "Ship a hard cap demo";
      const run = createRun(goal);
      run.status = "running";
      runs.set(run.id, run);
      sendJson(res, 202, { ok: true, runId: run.id, run: { id: run.id, goal: run.goal, status: run.status } });
      setImmediate(() => {
        void executeRun(run, {
          tickMs,
          onEvent: (event) => wss.broadcast(event),
        }).catch((err) => {
          run.status = "failed";
          run.finishedAt = Date.now();
          const message = err instanceof Error ? err.message : String(err);
          const event: ForgeEvent = { type: "run.complete", runId: run.id, ts: Date.now(), status: "failed", score: run.score, summary: message };
          run.events.push(event);
          wss.broadcast(event);
        });
      });
      return;
    }

    if (req.method !== "GET" && req.method !== "HEAD") {
      sendJson(res, 404, { ok: false, error: "not_found" });
      return;
    }

    const file = resolvePublic(publicDir, url.pathname);
    if (!file) {
      res.writeHead(403, { "content-type": "text/plain; charset=utf-8" });
      res.end("forbidden");
      return;
    }
    let data: Buffer;
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) throw new Error("not a file");
      data = fs.readFileSync(file);
    } catch {
      res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": mime(file) });
    if (req.method === "HEAD") res.end();
    else res.end(data);
  }

  server.on("clientError", (_err, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
  });

  await new Promise<void>((resolve) => {
    if (host) server.listen(port, host, () => resolve());
    else server.listen(port, () => resolve());
  });

  const addr = server.address();
  const listenPort = typeof addr === "object" && addr ? addr.port : port;
  const bound = typeof addr === "object" && addr ? addr.address : "127.0.0.1";
  const printable = !bound || bound === "0.0.0.0" || bound === "::" ? "localhost" : bound;
  const url = `http://${printable}:${listenPort}`;

  return {
    port: listenPort,
    url,
    wsUrl: `ws://${printable}:${listenPort}/ws`,
    runs,
    async close() {
      await closeServer(server, wss);
    },
  };
}

function closeServer(server: http.Server, wss: WsHub): Promise<void> {
  wss.close();
  server.closeAllConnections?.();
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}
