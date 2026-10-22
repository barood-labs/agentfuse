<h1 align="center">⚡ agentfuse</h1>
<p align="center"><b>A hard spending cap and kill switch for AI coding agents.</b><br>
Run your agent behind it and the agent <i>cannot</i> spend more than the amount you set.</p>

<p align="center">
<a href="https://github.com/barood-labs/agentfuse/actions/workflows/ci.yml"><img src="https://github.com/barood-labs/agentfuse/actions/workflows/ci.yml/badge.svg" alt="ci"></a>
<img src="https://img.shields.io/badge/dependencies-0-brightgreen" alt="zero dependencies">
<img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT">
</p>

```bash
npx github:barood-labs/agentfuse --cap 5 -- claude
```

<p align="center"><img src="docs/demo.gif" alt="agentfuse stopping a runaway agent at $1" width="820"></p>

Agents loop. They retry a flaky test 40 times, re-read a 200k-token repo on every turn, or get left running overnight. Dashboards tell you what happened **after** the money is gone. agentfuse sits between the agent and the API and **stops it at the limit you set**.

## What it does

- **Hard cap per session, per day, and per repo.** `--cap 5 --daily 20 --repo-cap 10`
- **Live meter.** A progress bar in your terminal and a `⚡ $1.23 / $5.00 (25%)` title bar that works while the agent's own TUI is running.
- **Warn, then act.** At 80% (`--warn`) it warns. At 100% it does what `--on-cap` says:
  - `kill` (default): stops the agent (SIGTERM, then SIGKILL) and exits with code **86**.
  - `pause`: holds every model call until you run `agentfuse raise 5` in another terminal.
  - `block`: answers with a provider-shaped HTTP 402 `budget_exceeded` error and leaves the agent running.
- **Strict streaming.** If one huge response pushes spend over the cap, the stream is cut mid-flight.
- **Accurate cost math.** Reads the real `usage` the API returns (JSON and SSE), including prompt-cache reads and writes, OpenAI `cached_tokens` (not double-counted), Chat Completions, and the Responses API. Dated model snapshots resolve by longest prefix.
- **Never under-counts.** Models it doesn't know are billed at a pessimistic fallback rate and flagged in the receipt.
- **Metered OpenAI streams.** It injects `stream_options.include_usage` automatically, so OpenAI streams report their usage.
- **Receipts and a local ledger.** You get a JSON receipt per session, `~/.agentfuse/ledger.jsonl`, and `agentfuse report` to break spend down by model and by repo.
- **Small and local.** Zero dependencies and about 600 lines of Node. It binds to 127.0.0.1, sends no telemetry, and never touches your API key. Headers pass straight through.

## Install

```bash
npx github:barood-labs/agentfuse --help         # no install
npm i -g github:barood-labs/agentfuse           # puts `agentfuse` on your PATH
```
Requires Node ≥ 18.17.

## Use

```bash
agentfuse --cap 2 -- claude                     # Claude Code
agentfuse --cap 5 --on-cap pause -- codex       # OpenAI Codex CLI
agentfuse --cap 1 -- aider --model sonnet       # anything that honours *_BASE_URL
agentfuse --cap 3 --daily 15 -- python agent.py # your own agent (Anthropic/OpenAI SDKs)

agentfuse status          # live state of running sessions
agentfuse raise 5         # add $5 to the newest running session (un-pauses it)
agentfuse report --days 7 # spend by model and by repo
agentfuse serve --cap 10  # proxy only; prints the env vars to export
```

For the child process, agentfuse sets `ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL` and `OPENAI_API_BASE` to point at a local proxy on a random port. Most agents and SDKs pick these up automatically. Tools that read their endpoint from a config file instead (some Codex setups, for example) need that file to point at the `agentfuse serve` URL.

### In CI

```yaml
- run: npx github:barood-labs/agentfuse --cap 3 --receipt fuse.json -- claude -p "fix the failing tests"
```
If the fuse kills the agent, the step fails with exit code 86 and `fuse.json` tells you why.

### Custom prices / local models

```json
{ "my-finetune": { "input": 0.5, "output": 1.5 }, "llama": { "input": 0, "output": 0 } }
```
`agentfuse --prices prices.json --cap 1 -- ...`. Keys are model-id prefixes, prices are USD per 1M tokens (`input`, `output`, `cacheWrite`, `cacheRead`).

## How it compares

| | enforces a cap *before* spend | kills / pauses the agent | streaming-aware | setup |
|---|:-:|:-:|:-:|---|
| **agentfuse** | ✅ | ✅ | ✅ cuts mid-stream | `npx`, zero deps |
| Usage dashboards / trackers (e.g. codeburn, ccusage) | ❌ after the fact | ❌ | n/a | log parsers |
| Provider console spend limits | monthly, org-wide | ❌ | – | web UI, lagging |
| LiteLLM proxy budgets | ✅ | ❌ | ✅ | Python server + DB + config |

agentfuse is complementary to trackers. Keep your dashboard, and add a fuse.

## Accuracy and limits (honest notes)

- Spend is committed when the API reports usage. Overshoot is bounded by one request, and strict mode cuts a stream as soon as its reported usage crosses the cap. In the demo, a $1 cap stopped at $1.02.
- Prices are list prices built into [`src/pricing.js`](src/pricing.js). Batch discounts, regional pricing and negotiated rates aren't modelled, so override them with `--prices`.
- Only traffic sent through the proxy is metered. Requests made directly to a hard-coded endpoint bypass it.

## Develop

```bash
npm test        # 17 tests, uses a mock API, costs $0
npm run demo    # the GIF above: a runaway agent vs a $1 fuse, against a mock API
```

PRs for more providers (Gemini, Bedrock, OpenRouter headers) and price updates are very welcome.

## License

MIT
