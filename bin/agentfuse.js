#!/usr/bin/env node
'use strict';
require('../src/cli.js').run(process.argv.slice(2)).then((code) => process.exit(code), (e) => { console.error(`agentfuse: ${e && e.stack || e}`); process.exit(1); });
