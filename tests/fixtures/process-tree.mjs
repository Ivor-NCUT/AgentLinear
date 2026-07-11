import fs from 'node:fs';
import { spawn } from 'node:child_process';

const pidFile = process.argv[2];
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  stdio:'ignore',
  detached:false
});
fs.writeFileSync(pidFile, JSON.stringify({ parent:process.pid, child:child.pid }));
setInterval(() => {}, 1000);
