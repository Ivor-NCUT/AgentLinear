import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { buildAppServerTurn, CodexAdapter, CodexExecutionError } from '../src/codex-adapter.js';

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

function fakeAppServer({ sessionId = 'thread-1', source = 'vscode', output = 'finished', usage = { inputTokens:12, outputTokens:3, totalTokens:15 } } = {}) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  child.requests = [];
  let inputBuffer = '';
  const send = message => child.stdout.write(`${JSON.stringify(message)}\n`);
  child.stdin.on('data', chunk => {
    inputBuffer += chunk.toString();
    const lines = inputBuffer.split(/\r?\n/);
    inputBuffer = lines.pop() || '';
    for (const line of lines) {
      if (!line) continue;
      const request = JSON.parse(line);
      child.requests.push(request);
      if (request.method === 'initialize') send({ id:request.id, result:{ userAgent:'fake' } });
      if (request.method === 'thread/start' || request.method === 'thread/resume') {
        send({ id:request.id, result:{ thread:{ id:request.params.threadId || sessionId, source } } });
      }
      if (request.method === 'thread/fork') send({ id:request.id, result:{ thread:{ id:'thread-migrated', source:'vscode' } } });
      if (request.method === 'thread/name/set') send({ id:request.id, result:{} });
      if (request.method === 'turn/start') {
        send({ id:request.id, result:{ turn:{ id:'turn-1', status:'inProgress', items:[] } } });
        queueMicrotask(() => {
          send({ method:'turn/started', params:{ threadId:sessionId, turn:{ id:'turn-1', status:'inProgress', items:[] } } });
          send({ method:'thread/tokenUsage/updated', params:{ threadId:sessionId, turnId:'turn-1', tokenUsage:usage } });
          send({ method:'item/completed', params:{ threadId:sessionId, turnId:'turn-1', completedAtMs:Date.now(), item:{ id:'item-1', type:'agentMessage', text:output } } });
          send({ method:'turn/completed', params:{ threadId:sessionId, turn:{ id:'turn-1', status:'completed', items:[] } } });
        });
      }
    }
  });
  child.stdin.on('finish', () => queueMicrotask(() => {
    child.stdout.end();
    child.stderr.end();
    child.emit('close', 0, null);
  }));
  return child;
}

function failedProcess() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new PassThrough();
  queueMicrotask(() => {
    child.stderr.end('permission denied\n');
    child.stdout.end();
    child.emit('close', 7, null);
  });
  return child;
}

test('uses app-server to create an interactive session and collect the final output', async () => {
  let invocation;
  const adapter = new CodexAdapter({ spawnProcess(executable, args, options) {
    invocation = { executable, args, options };
    invocation.child = fakeAppServer();
    return invocation.child;
  } });
  const result = await adapter.execute({ executable:'/usr/bin/codex', cwd:'/tmp/project', prompt:'work', threadName:'Visible task' });
  assert.equal(result.sessionId, 'thread-1');
  assert.equal(result.finalOutput, 'finished');
  assert.equal(result.usage.outputTokens, 3);
  assert.deepEqual(invocation.args, ['app-server','--stdio']);
  assert.equal(invocation.options.cwd, '/tmp/project');
  assert.deepEqual(invocation.child.requests.map(request => request.method), ['initialize','initialized','thread/start','thread/name/set','turn/start']);
  const threadStart = invocation.child.requests.find(request => request.method === 'thread/start');
  assert.equal(threadStart.params.threadSource, 'agentlinear');
  assert.equal(invocation.child.requests.find(request => request.method === 'thread/name/set').params.name, 'Visible task');
});

test('uses app-server thread/resume for follow-up turns', async () => {
  let child;
  const adapter = new CodexAdapter({ spawnProcess(_executable, receivedArgs) {
    assert.deepEqual(receivedArgs, ['app-server','--stdio']);
    child = fakeAppServer({ output:'continued' });
    return child;
  } });
  const result = await adapter.execute({ cwd:'/tmp/project', prompt:'continue', sessionId:'thread-1' });
  assert.equal(result.finalOutput, 'continued');
  const resume = child.requests.find(request => request.method === 'thread/resume');
  assert.equal(resume.params.threadId, 'thread-1');
  assert.equal(child.requests.some(request => request.method === 'thread/name/set'), false);
});

test('forks a legacy exec session into an interactive thread without losing its history', async () => {
  let child;
  const adapter = new CodexAdapter({ spawnProcess() {
    child = fakeAppServer({ sessionId:'thread-legacy', source:'exec', output:'migrated' });
    return child;
  } });
  const result = await adapter.execute({
    cwd:'/tmp/project',
    prompt:'continue legacy work',
    sessionId:'thread-legacy',
    threadName:'Legacy task'
  });
  assert.equal(result.sessionId, 'thread-migrated');
  assert.equal(result.migratedFromSessionId, 'thread-legacy');
  assert.equal(result.finalOutput, 'migrated');
  assert.deepEqual(child.requests.map(request => request.method), [
    'initialize','initialized','thread/resume','thread/fork','thread/name/set','turn/start'
  ]);
  assert.equal(child.requests.find(request => request.method === 'thread/fork').params.threadId, 'thread-legacy');
  assert.equal(child.requests.find(request => request.method === 'turn/start').params.threadId, 'thread-migrated');
});

test('prepares and migrates a legacy session without starting a new turn', async () => {
  let child;
  const adapter = new CodexAdapter({ spawnProcess() {
    child = fakeAppServer({ sessionId:'thread-legacy', source:'exec' });
    return child;
  } });
  const result = await adapter.prepareSession({
    cwd:'/tmp/project',
    sessionId:'thread-legacy',
    threadName:'Legacy task'
  });
  assert.equal(result.sessionId, 'thread-migrated');
  assert.equal(result.migratedFromSessionId, 'thread-legacy');
  assert.equal(result.finalOutput, '');
  assert.deepEqual(child.requests.map(request => request.method), [
    'initialize','initialized','thread/resume','thread/fork','thread/name/set'
  ]);
});

test('returns exit diagnostics on Codex failure', async () => {
  const adapter = new CodexAdapter({ spawnProcess() {
    return failedProcess();
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

test('uses full local access and adds image inputs to Codex', async () => {
  let child;
  const adapter = new CodexAdapter({ spawnProcess(_executable, receivedArgs) {
    assert.deepEqual(receivedArgs, ['app-server','--stdio']);
    child = fakeAppServer({ sessionId:'thread-files', output:'read files' });
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
  const turn = child.requests.find(request => request.method === 'turn/start').params;
  assert.deepEqual(turn.sandboxPolicy, { type:'dangerFullAccess' });
  assert.equal(turn.input.some(input => input.type === 'localImage' && input.path === '/outside/images/screen.png'), true);
  assert.match(turn.input[0].text, /agentlinear_attachments/);
  assert.match(turn.input[0].text, /\/outside\/docs\/notes\.md/);
});

test('builds a full-access turn without special cases for an empty attachment list', () => {
  assert.deepEqual(buildAppServerTurn({ cwd:'/workspace', prompt:'work' }), {
    input:[{ type:'text', text:'work' }],
    cwd:'/workspace',
    approvalPolicy:'never',
    sandboxPolicy:{ type:'dangerFullAccess' }
  });
});
