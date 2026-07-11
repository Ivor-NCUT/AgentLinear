import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openAgentLinearDatabase } from '../src/database.js';
import { createGroupService } from '../src/group-service.js';
import { createPersistentScheduler } from '../src/scheduler.js';
import { createTaskService } from '../src/task-service.js';
import { CodexExecutionError } from '../src/codex-adapter.js';

function nextTurn() {
  return new Promise(resolve => setImmediate(resolve));
}

test('runs only six of ten tasks and promotes the FIFO head without duplicates', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlinear-scheduler-'));
  const workspace = path.join(root, 'project');
  fs.mkdirSync(workspace);
  const storage = await openAgentLinearDatabase({ filePath:path.join(root, 'data.sqlite3') });
  const group = createGroupService(storage.database).create(workspace);
  const calls = [];
  const deferred = [];
  let inFlight = 0;
  let maximumInFlight = 0;
  const adapter = {
    execute(input) {
      calls.push(input);
      inFlight += 1;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      return new Promise(resolve => deferred.push({
        resolved:false,
        resolve() {
          if (this.resolved) return;
          this.resolved = true;
          inFlight -= 1;
          resolve({ sessionId:`thread-${calls.indexOf(input) + 1}`, finalOutput:'done', exitCode:0, stderr:'', usage:{} });
        }
      }));
    }
  };
  const service = createTaskService({ database:storage.database, adapter, ensureReady:() => ({ codexExecutable:'codex' }) });
  const scheduler = createPersistentScheduler({
    database:storage.database,
    executeTask:taskId => service.executeQueued(taskId),
    getTask:taskId => service.get(taskId)
  });
  service.setScheduler(scheduler);

  try {
    const created = Array.from({ length:10 }, (_, index) => service.create({
      groupId:group.id,
      title:`Task ${index + 1}`,
      prompt:`Prompt ${index + 1}`
    }));
    await nextTurn();

    let tasks = service.list();
    assert.equal(tasks.filter(task => task.status === 'running').length, 6);
    assert.equal(tasks.filter(task => task.status === 'queued').length, 4);
    assert.deepEqual(tasks.filter(task => task.status === 'queued').map(task => task.queueIndex), [1,2,3,4]);
    assert.equal(calls.length, 6);
    scheduler.drain();
    scheduler.drain();
    assert.equal(calls.length, 6, 'repeated drain must not duplicate starts');

    deferred[0].resolve();
    await nextTurn();
    await nextTurn();
    tasks = service.list();
    assert.equal(calls.length, 7);
    assert.equal(tasks.find(task => task.id === created[6].id).status, 'running', 'the first queued task should start next');
    assert.deepEqual(tasks.filter(task => task.status === 'queued').map(task => task.id), created.slice(7).map(task => task.id));

    while (calls.length < 10) {
      deferred.find(item => !item.resolved)?.resolve();
      await nextTurn();
      await nextTurn();
    }
    deferred.forEach(item => item.resolve());
    await scheduler.waitForIdle();
    assert.equal(maximumInFlight, 6);
    assert.equal(new Set(calls.map(call => call.prompt)).size, 10);
    assert.equal(service.list().every(task => task.status === 'done'), true);
    assert.equal(storage.database.prepare('SELECT COUNT(*) AS count FROM queue_entries').get().count, 0);
  } finally {
    storage.close();
    fs.rmSync(root, { recursive:true, force:true });
  }
});

test('keeps unclaimed FIFO order in SQLite', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlinear-queue-persist-'));
  const workspace = path.join(root, 'project');
  fs.mkdirSync(workspace);
  const storage = await openAgentLinearDatabase({ filePath:path.join(root, 'data.sqlite3') });
  const group = createGroupService(storage.database).create(workspace);
  const pending = [];
  const adapter = { execute:() => new Promise(resolve => pending.push(resolve)) };
  const service = createTaskService({ database:storage.database, adapter, ensureReady:() => ({ codexExecutable:'codex' }) });
  const scheduler = createPersistentScheduler({
    database:storage.database,
    executeTask:taskId => service.executeQueued(taskId),
    getTask:taskId => service.get(taskId),
    maxConcurrency:1
  });
  service.setScheduler(scheduler);
  try {
    const tasks = [1,2,3].map(index => service.create({ groupId:group.id, title:`Task ${index}`, prompt:`Prompt ${index}` }));
    await nextTurn();
    assert.deepEqual(scheduler.queueSnapshot().map(entry => entry.taskId), [tasks[1].id, tasks[2].id]);
    const persisted = storage.database.prepare(`
      SELECT task_id FROM queue_entries WHERE lease_token IS NULL ORDER BY position
    `).all().map(row => row.task_id);
    assert.deepEqual(persisted, [tasks[1].id, tasks[2].id]);

    while (pending.length) {
      pending.shift()({ sessionId:`thread-${Date.now()}`, finalOutput:'done', exitCode:0 });
      await nextTurn();
      await nextTurn();
    }
    while (scheduler.runningCount() || scheduler.queueSnapshot().length) {
      if (pending.length) pending.shift()({ sessionId:`thread-${Date.now()}`, finalOutput:'done', exitCode:0 });
      await nextTurn();
    }
  } finally {
    storage.close();
    fs.rmSync(root, { recursive:true, force:true });
  }
});

test('stops a running task tree, cancels queued work and promotes the next task', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlinear-stop-'));
  const workspace = path.join(root, 'project');
  fs.mkdirSync(workspace);
  const storage = await openAgentLinearDatabase({ filePath:path.join(root, 'data.sqlite3') });
  const group = createGroupService(storage.database).create(workspace);
  const executions = [];
  const adapter = {
    execute(input) {
      input.onSpawn(5000 + executions.length);
      return new Promise((resolve, reject) => {
        const execution = { input, resolve };
        executions.push(execution);
        input.signal.addEventListener('abort', () => reject(new CodexExecutionError(
          input.signal.reason.message,
          { sessionId:null, exitCode:null, termination:input.signal.reason }
        )), { once:true });
      });
    }
  };
  const service = createTaskService({ database:storage.database, adapter, ensureReady:() => ({ codexExecutable:'codex' }) });
  const scheduler = createPersistentScheduler({
    database:storage.database,
    executeTask:taskId => service.executeQueued(taskId),
    getTask:taskId => service.get(taskId),
    maxConcurrency:1
  });
  service.setScheduler(scheduler);
  try {
    const first = service.create({ groupId:group.id, title:'First', prompt:'First' });
    const canceledQueue = service.create({ groupId:group.id, title:'Cancel queue', prompt:'Second' });
    await nextTurn();
    assert.equal(service.get(first.id).status, 'running');
    assert.equal(service.get(canceledQueue.id).status, 'queued');
    assert.equal(storage.database.prepare('SELECT pid FROM runs WHERE task_id = ?').get(first.id).pid, 5000);

    service.stop(canceledQueue.id);
    assert.equal(service.get(canceledQueue.id).status, 'canceled');
    const promoted = service.create({ groupId:group.id, title:'Promoted', prompt:'Third' });
    assert.equal(service.get(promoted.id).status, 'queued');

    service.stop(first.id);
    await nextTurn();
    await nextTurn();
    assert.equal(service.get(first.id).status, 'canceled');
    assert.equal(storage.database.prepare('SELECT status FROM runs WHERE task_id = ?').get(first.id).status, 'stopped');
    assert.equal(service.get(promoted.id).status, 'running');
    assert.equal(executions.length, 2);

    executions[1].resolve({ sessionId:'thread-promoted', finalOutput:'done', exitCode:0 });
    await scheduler.waitForIdle();
    assert.equal(service.get(promoted.id).status, 'done');
  } finally {
    storage.close();
    fs.rmSync(root, { recursive:true, force:true });
  }
});

test('marks timed out executions as failed', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlinear-timeout-'));
  const workspace = path.join(root, 'project');
  fs.mkdirSync(workspace);
  const storage = await openAgentLinearDatabase({ filePath:path.join(root, 'data.sqlite3') });
  const group = createGroupService(storage.database).create(workspace);
  const adapter = {
    execute(input) {
      return new Promise((_resolve, reject) => setTimeout(() => reject(new CodexExecutionError(
        'execution timed out',
        { sessionId:null, exitCode:null, termination:{ kind:'timeout', message:'execution timed out' } }
      )), input.timeoutMs));
    }
  };
  const service = createTaskService({
    database:storage.database,
    adapter,
    ensureReady:() => ({ codexExecutable:'codex' }),
    executionTimeoutMs:20
  });
  const scheduler = createPersistentScheduler({ database:storage.database, executeTask:id => service.executeQueued(id), getTask:id => service.get(id) });
  service.setScheduler(scheduler);
  try {
    const task = service.create({ groupId:group.id, title:'Timeout', prompt:'Wait' });
    await scheduler.waitForIdle();
    assert.equal(service.get(task.id).status, 'failed');
    assert.equal(storage.database.prepare('SELECT status FROM runs WHERE task_id = ?').get(task.id).status, 'failed');
  } finally {
    storage.close();
    fs.rmSync(root, { recursive:true, force:true });
  }
});

test('pauses dispatch during shutdown and records active work as interrupted', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlinear-shutdown-'));
  const workspace = path.join(root, 'project');
  fs.mkdirSync(workspace);
  const storage = await openAgentLinearDatabase({ filePath:path.join(root, 'data.sqlite3') });
  const group = createGroupService(storage.database).create(workspace);
  let starts = 0;
  const adapter = {
    execute(input) {
      starts += 1;
      return new Promise((_resolve, reject) => input.signal.addEventListener('abort', () => reject(new CodexExecutionError(
        input.signal.reason.message,
        { sessionId:null, exitCode:null, termination:input.signal.reason }
      )), { once:true }));
    }
  };
  const service = createTaskService({ database:storage.database, adapter, ensureReady:() => ({ codexExecutable:'codex' }) });
  const scheduler = createPersistentScheduler({
    database:storage.database,
    executeTask:id => service.executeQueued(id),
    getTask:id => service.get(id),
    maxConcurrency:1
  });
  service.setScheduler(scheduler);
  try {
    const active = service.create({ groupId:group.id, title:'Active', prompt:'Active' });
    const waiting = service.create({ groupId:group.id, title:'Waiting', prompt:'Waiting' });
    await nextTurn();
    scheduler.pause();
    service.stopAll({ kind:'shutdown', message:'shutdown' });
    await scheduler.waitForActive();
    assert.equal(service.get(active.id).status, 'interrupted');
    assert.equal(service.get(waiting.id).status, 'queued');
    assert.equal(starts, 1, 'shutdown must not start queued work');
  } finally {
    storage.close();
    fs.rmSync(root, { recursive:true, force:true });
  }
});
