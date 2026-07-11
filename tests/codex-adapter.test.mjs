import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { CodexAdapter, CodexExecutionError } from '../src/codex-adapter.js';

const fixtureDirectory = path.dirname(fileURLToPath(import.meta.url));

function processIsAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error('Timed out waiting for process state');
}

function fakeProcess(events, { exitCode = 0, stderr = '' } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  queueMicrotask(() => {
    if (stderr) child.stderr.write(stderr);
    events.forEach(event => child.stdout.write(`${JSON.stringify(event)}\n`));
    child.stdout.end();
    child.stderr.end();
    child.emit('close', exitCode, null);
  });
  return child;
}

test('parses a new Codex JSONL session and final output', async () => {
  let invocation;
  const adapter = new CodexAdapter({ spawnProcess(executable, args, options) {
    invocation = { executable, args, options };
    return fakeProcess([
      { type:'thread.started', thread_id:'thread-1' },
      { type:'item.completed', item:{ type:'agent_message', text:'finished' } },
      { type:'turn.completed', usage:{ input_tokens:12, output_tokens:3 } }
    ]);
  } });
  const result = await adapter.execute({ executable:'/usr/bin/codex', cwd:'/tmp/project', prompt:'work' });
  assert.equal(result.sessionId, 'thread-1');
  assert.equal(result.finalOutput, 'finished');
  assert.equal(result.usage.output_tokens, 3);
  assert.deepEqual(invocation.args, ['exec','-s','workspace-write','-C','/tmp/project','--json','-']);
  assert.equal(invocation.options.cwd, '/tmp/project');
});

test('uses the official resume command for follow-up turns', async () => {
  let args;
  const adapter = new CodexAdapter({ spawnProcess(_executable, receivedArgs) {
    args = receivedArgs;
    return fakeProcess([
      { type:'thread.started', thread_id:'thread-1' },
      { type:'item.completed', item:{ type:'agent_message', text:'continued' } }
    ]);
  } });
  const result = await adapter.execute({ cwd:'/tmp/project', prompt:'continue', sessionId:'thread-1' });
  assert.equal(result.finalOutput, 'continued');
  assert.deepEqual(args, ['exec','resume','--json','thread-1','-']);
});

test('returns exit diagnostics on Codex failure', async () => {
  const adapter = new CodexAdapter({ spawnProcess() {
    return fakeProcess([{ type:'thread.started', thread_id:'thread-2' }], { exitCode:7, stderr:'permission denied\n' });
  } });
  await assert.rejects(
    adapter.execute({ cwd:'/tmp/project', prompt:'work' }),
    error => error instanceof CodexExecutionError && error.result.exitCode === 7 && /permission denied/.test(error.message)
  );
});

test('aborting a run terminates the full local process tree', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlinear-process-tree-'));
  const pidFile = path.join(root, 'pids.json');
  const fixture = path.join(fixtureDirectory, 'fixtures', 'process-tree.mjs');
  const controller = new AbortController();
  const adapter = new CodexAdapter({
    spawnProcess(_executable, _args, options) {
      return spawn(process.execPath, [fixture, pidFile], options);
    }
  });
  try {
    const execution = adapter.execute({
      cwd:root,
      prompt:'wait',
      signal:controller.signal,
      killGraceMs:300
    });
    await waitFor(() => fs.existsSync(pidFile));
    const pids = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
    assert.equal(processIsAlive(pids.parent), true);
    assert.equal(processIsAlive(pids.child), true);
    controller.abort({ kind:'user', message:'stop test' });
    await assert.rejects(execution, error => error instanceof CodexExecutionError && error.result.termination.kind === 'user');
    await waitFor(() => !processIsAlive(pids.parent) && !processIsAlive(pids.child));
  } finally {
    fs.rmSync(root, { recursive:true, force:true });
  }
});

test('grants local attachment directories and adds image inputs to Codex', async () => {
  let args;
  let stdin = '';
  const adapter = new CodexAdapter({ spawnProcess(_executable, receivedArgs) {
    args = receivedArgs;
    const child = fakeProcess([
      { type:'thread.started', thread_id:'thread-files' },
      { type:'item.completed', item:{ type:'agent_message', text:'read files' } }
    ]);
    child.stdin.on('data', chunk => { stdin += chunk.toString(); });
    return child;
  } });
  await adapter.execute({
    cwd:'/workspace',
    prompt:'Review attachments',
    attachments:[
      { name:'notes.md', path:'/outside/docs/notes.md', mimeType:'text/markdown' },
      { name:'screen.png', path:'/outside/images/screen.png', mimeType:'image/png' }
    ]
  });
  assert.deepEqual(args, [
    '--add-dir','/outside/docs','--add-dir','/outside/images',
    'exec','-s','workspace-write','-C','/workspace','--json','-i','/outside/images/screen.png','-'
  ]);
  assert.match(stdin, /agentlinear_attachments/);
  assert.match(stdin, /\/outside\/docs\/notes\.md/);
});
