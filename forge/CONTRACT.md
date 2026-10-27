# Forge wire contract

The dashboard in `public/` is built against this shape. The backend
(`forge/src`) emits it. Names are exact; extra JSON fields are ignored by the UI.

The model is **`mock-llm`**, labeled **`MOCK`**. It does not call the network.

## HTTP

| Method | Path | Body / response |
| --- | --- | --- |
| `GET` | `/api/health` | `{ ok, service: "agentfuse-forge", mode: "mock", llm: "mock-llm", label: "MOCK", engine, version, wsPath: "/ws", clients, events }` |
| `POST` | `/api/run` | Request `{ "goal": "…" }` (also accepts `prompt`). `202` `{ ok: true, runId, run: { id, goal, status } }`. Bad JSON → `400 { ok: false, error: "invalid_json" }`. |
| `GET` | `/api/run/:id` | `{ ok: true, run: { id, goal, status, score, agents, createdAt, finishedAt, events, llm, label } }` or `404 { ok: false, error: "not_found" }`. |

Static files: `public/` at `/` and `/ui`.

WebSocket: `GET /ws` (same host as the page). One JSON object per text frame. No replay filter — every event on the socket is for the live demo, matching the dashboard.

## Events

Every event has `type`, `runId`, and `ts` (epoch milliseconds). Payload fields sit on the same object (not nested under `payload`).

### `agent.spawn`

```json
{ "type": "agent.spawn", "agent": { "id": "planner", "role": "planner", "name": "Plan", "status": "spawning" } }
```

Crew ids, in order: `planner` (Plan), `coder` (Code), `verifier` (Verify).

### `agent.status`

```json
{ "type": "agent.status", "agentId": "coder", "status": "running" }
```

`status` is one of `spawning`, `ready`, `running`, `done`, `error`. The dashboard treats `running` and `spawning` as the active glow.

### `agent.log`

```json
{ "type": "agent.log", "agentId": "coder", "level": "info", "message": "tool write_file solution.js · 180 bytes", "mock": true }
```

`level` is `info` or `error`. Tool calls are log lines whose `message` starts with `tool `, plus a `tool` object `{ name, args?, ok }`. Tool names: `read_file`, `write_file`, `run_tests`, `score`.

### `plan.step`

```json
{ "type": "plan.step", "agentId": "planner", "index": 0, "total": 4, "step": "Parse goal: …", "status": "done" }
```

The timeline appends one card per event. `index` is 0-based.

### `code.diff`

```json
{ "type": "code.diff", "agentId": "coder", "path": "solution.js", "patch": "--- a/solution.js\n+++ b/solution.js\n@@ …" }
```

`patch` is a unified diff. The planner also emits one for `task.test.js`.

### `verify.result`

```json
{
  "type": "verify.result",
  "agentId": "verifier",
  "ok": false,
  "summary": "2 failed, 1 passed (3 total)",
  "checks": [{ "name": "under cap returns spent", "ok": false }]
}
```

A normal run emits this twice: first miss, then pass. A goal that contains the words `fail` or `broken` stays failed.

### `score.update`

```json
{ "type": "score.update", "score": 40, "max": 100, "label": "verify", "provisional": false }
```

`label` is `plan`, `code`, or `verify`. Plan/code updates are provisional progress so the meter moves. The verify update is the rubric:

| Row | Points |
| --- | --- |
| `tests_pass` | 60 if `node --test` exits 0 |
| `task_complete` | 40 if `solution.js` exports `clampSpend` |

A clean run ends at **100**. The verify event may include `rubric`.

### `run.complete`

```json
{ "type": "run.complete", "status": "complete", "score": 100, "summary": "Forge run complete for “…”", "llm": "mock-llm", "label": "MOCK" }
```

`status` is `complete` or `failed`. The dashboard re-enables **Run forge** on this event.

## Eval loop

1. Planner pins `task.test.js` (three `clampSpend` assertions).
2. Coder pass 1 writes an inverted clamp. Verifier runs the file. Score is 40 (export exists, tests fail).
3. Coder pass 2 writes the fix. Verifier runs again. Score is 100.
4. `run.complete`.

Workspaces are temp dirs and are deleted when the run finishes. Nothing is sent to a model provider.
