import type { Server } from "node:http";

export interface WsHub {
  broadcast(msg: unknown): void;
  close(): void;
  readonly size: number;
}

/** Load Bounty's zero-dep WebSocket server (forge/ws-lite.mjs) without pulling it into tsc's rootDir. */
export async function loadWsHub(server: Server): Promise<WsHub> {
  const href = new URL("../ws-lite.mjs", import.meta.url).href;
  const imported = (await import(href)) as {
    attachWebSocketServer: (s: Server, opts?: { path?: string }) => WsHub;
  };
  return imported.attachWebSocketServer(server, { path: "/ws" });
}
