#!/usr/bin/env node
/**
 * Compatibility entry for `node forge/mock-server.mjs`.
 * The slideshow mock is gone: this starts the real Planner → Coder → Verifier
 * loop (MOCK LLM, no API key). The neon UI in public/ is unchanged.
 * Prefer `npm run forge` so TypeScript is built first.
 */
import { existsSync } from 'node:fs';

const cli = new URL('./dist/cli.js', import.meta.url);
if (!existsSync(cli)) {
  console.error('[forge] build missing. From the repo root run: npm install && npm run forge');
  process.exit(1);
}
await import(cli.href);
