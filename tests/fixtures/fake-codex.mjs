#!/usr/bin/env node
import fs from 'node:fs';
import { spawn } from 'node:child_process';

const args = process.argv.slice(2);
if (args.includes('--version')) {
  console.log('codex-cli test-fixture');
  process.exit(0);
}
if (args[0] === 'login' && args[1] === 'status') {
  console.log('Logged in using test fixture');
  process.exit(0);
}

console.log(JSON.stringify({ type:'thread.started', thread_id:'00000000-0000-4000-8000-000000000001' }));
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio:'ignore' });
if (process.env.AGENTLINEAR_FAKE_PID_FILE) {
  fs.writeFileSync(process.env.AGENTLINEAR_FAKE_PID_FILE, JSON.stringify({ parent:process.pid, child:child.pid }));
}
setInterval(() => {}, 1000);
