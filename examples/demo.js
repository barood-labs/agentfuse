'use strict';
// $0 demo: mock API + runaway agent + agentfuse with a $1 cap.
const path = require('path');
const { spawn } = require('child_process');
const mock = require('./mock-upstream');
(async () => {
  const up = await mock.start({ inputTokens: 30000, outputTokens: 2500 });
  const env = { ...process.env, AGENTFUSE_ANTHROPIC_UPSTREAM: up.url, AGENTFUSE_HOME: process.env.AGENTFUSE_HOME || path.join(require('os').tmpdir(), 'agentfuse-demo') };
  const cap = process.argv[2] || '1';
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'bin', 'agentfuse.js'), '--cap', cap, '--', process.execPath, path.join(__dirname, 'runaway-agent.js')], { stdio: 'inherit', env });
  child.on('exit', async (c) => { await up.close(); process.exit(c); });
})();
