import { startForge } from "./server.js";

const port = Number(process.env.PORT || process.env.FORGE_PORT || 8787);
const tickMs = Number(process.env.FORGE_TICK_MS ?? 280);
const host = process.env.HOST || process.env.FORGE_HOST || undefined;

const forge = await startForge({ port, tickMs, host });
console.log("[forge] AgentFuse Forge — Planner → Coder → Verifier");
console.log(`[forge] UI     ${forge.url}/`);
console.log(`[forge] health ${forge.url}/api/health`);
console.log(`[forge] ws     ${forge.wsUrl}`);
console.log("[forge] llm    MOCK mock-llm — no API key, no network, $0");
console.log("[forge] loop   real node:test + tests-pass/task-complete score");
console.log(`[forge] POST   ${forge.url}/api/run  {"goal":"…"}`);

async function shutdown(): Promise<void> {
  await forge.close();
  process.exit(0);
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
