import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openAgentLinearDatabase } from '../src/database.js';
import { createGroupService } from '../src/group-service.js';
import { createTaskService } from '../src/task-service.js';
import { createPersistentScheduler } from '../src/scheduler.js';

async function fixture(results, { preparedSessionId = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlinear-tasks-'));
  const workspace = path.join(root, 'project');
  fs.mkdirSync(workspace);
  const storage = await openAgentLinearDatabase({ filePath:path.join(root, 'data.sqlite3') });
  const group = createGroupService(storage.database).create(workspace);
  const calls = [];
  const prepareCalls = [];
  const changed = [];
  const adapter = {
    async execute(input) {
      calls.push(input);
      const result = results.shift();
      if (result instanceof Error) throw result;
      return result;
    },
    async prepareSession(input) {
      prepareCalls.push(input);
      return {
        sessionId:preparedSessionId || input.sessionId,
        migratedFromSessionId:preparedSessionId ? input.sessionId : null
      };
    }
  };
  const service = createTaskService({
    database:storage.database,
    adapter,
    ensureReady:() => ({ codexExecutable:'/local/codex' }),
    onChanged:task => changed.push(task)
  });
  const scheduler = createPersistentScheduler({
    database:storage.database,
    executeTask:taskId => service.executeQueued(taskId),
    getTask:taskId => service.get(taskId),
    onChanged:task => changed.push(task)
  });
  service.setScheduler(scheduler);
  return { root, workspace, storage, group, calls, prepareCalls, changed, service, scheduler };
}

function cleanup(context) {
  context.storage.close();
  fs.rmSync(context.root, { recursive:true, force:true });
}

test('persists a first turn, Session ID, run and final answer', async () => {
  const context = await fixture([{ sessionId:'thread-1', finalOutput:'first result', exitCode:0, stderr:'', usage:{} }]);
  try {
    const started = context.service.create({ groupId:context.group.id, title:'Real task', prompt:'Do the work' });
    assert.equal(started.status, 'running');
    await context.scheduler.waitForIdle();
    const completed = context.service.get(started.id);
    assert.equal(completed.status, 'done');
    assert.equal(completed.sessionId, 'thread-1');
    assert.equal(completed.finalOutput, 'first result');
    assert.deepEqual(completed.messages.map(message => message.role), ['user','assistant']);
    assert.equal(context.storage.database.prepare('SELECT status FROM runs WHERE task_id = ?').get(started.id).status, 'completed');
    assert.equal(context.calls[0].executable, '/local/codex');
    assert.equal(context.calls[0].threadName, 'Real task');
  } finally {
    cleanup(context);
  }
});

test('resumes the same Codex Session and appends immutable history', async () => {
  const context = await fixture([
    { sessionId:'thread-1', finalOutput:'remembered', exitCode:0, stderr:'', usage:{} },
    { sessionId:'thread-1', finalOutput:'ORCHID-742', exitCode:0, stderr:'', usage:{} }
  ]);
  try {
    const started = context.service.create({ groupId:context.group.id, title:'Memory', prompt:'Remember ORCHID-742' });
    await context.scheduler.waitForIdle();
    const resumed = context.service.followup({ taskId:started.id, prompt:'What was it?' });
    assert.equal(resumed.status, 'running');
    await context.scheduler.waitForIdle();
    const completed = context.service.get(started.id);
    assert.equal(completed.turns, 2);
    assert.equal(completed.finalOutput, 'ORCHID-742');
    assert.equal(context.calls[1].sessionId, 'thread-1');
    assert.deepEqual(completed.messages.map(message => message.content), ['Remember ORCHID-742','remembered','What was it?','ORCHID-742']);
  } finally {
    cleanup(context);
  }
});

test('migrates persisted legacy Sessions at startup without adding a message', async () => {
  const context = await fixture(
    [{ sessionId:'thread-legacy', finalOutput:'legacy result', exitCode:0, stderr:'', usage:{} }],
    { preparedSessionId:'thread-visible' }
  );
  try {
    const started = context.service.create({ groupId:context.group.id, title:'Legacy card', prompt:'Old request' });
    await context.scheduler.waitForIdle();
    const beforeMessages = context.service.get(started.id).messages.length;
    const report = await context.service.migrateLegacySessions();
    assert.deepEqual(report, { examined:1, migrated:1, failures:[] });
    assert.equal(context.service.get(started.id).sessionId, 'thread-visible');
    assert.equal(context.service.get(started.id).messages.length, beforeMessages);
    assert.equal(context.prepareCalls[0].threadName, 'Legacy card');
    assert.equal(context.prepareCalls[0].sessionId, 'thread-legacy');
    assert.deepEqual(await context.service.migrateLegacySessions(), { examined:0, migrated:0, failures:[] });
    assert.equal(context.prepareCalls.length, 1);
  } finally {
    cleanup(context);
  }
});

test('records a failed run without losing the user message', async () => {
  const failure = Object.assign(new Error('Codex failed'), { result:{ sessionId:'thread-failed', exitCode:2 } });
  const context = await fixture([failure]);
  try {
    const started = context.service.create({ groupId:context.group.id, title:'Failure', prompt:'Try' });
    await context.scheduler.waitForIdle();
    const failed = context.service.get(started.id);
    assert.equal(failed.status, 'failed');
    assert.equal(failed.messages.length, 1);
    assert.equal(failed.sessionId, 'thread-failed');
    assert.equal(context.storage.database.prepare('SELECT status FROM runs WHERE task_id = ?').get(started.id).status, 'failed');
  } finally {
    cleanup(context);
  }
});

test('persists attachments per message, passes valid paths to Codex and tolerates missing files', async () => {
  const context = await fixture([
    { sessionId:'thread-files', finalOutput:'read first file', exitCode:0, stderr:'', usage:{} },
    { sessionId:'thread-files', finalOutput:'read followup file', exitCode:0, stderr:'', usage:{} }
  ]);
  const firstFile = path.join(context.root, 'first.md');
  const secondFile = path.join(context.root, 'second.txt');
  fs.writeFileSync(firstFile, '# first');
  fs.writeFileSync(secondFile, 'second');
  try {
    const started = context.service.create({
      groupId:context.group.id,
      title:'Files',
      prompt:'Read the file',
      attachmentPaths:[firstFile]
    });
    await context.scheduler.waitForIdle();
    assert.equal(context.calls[0].attachments[0].path, fs.realpathSync(firstFile));
    assert.equal(context.service.get(started.id).messages[0].attachments[0].name, 'first.md');

    context.service.followup({ taskId:started.id, prompt:'', attachmentPaths:[secondFile] });
    await context.scheduler.waitForIdle();
    const completed = context.service.get(started.id);
    assert.equal(completed.messages[2].content, '请查看本轮附件，并结合当前会话上下文继续处理。');
    assert.equal(context.calls[1].attachments[0].path, fs.realpathSync(secondFile));

    fs.rmSync(firstFile);
    const missing = context.service.get(started.id).messages[0].attachments[0];
    assert.equal(missing.missing, true);
    context.service.removeAttachment({ taskId:started.id, attachmentId:missing.id });
    assert.equal(context.service.get(started.id).messages[0].attachments.length, 0);
  } finally {
    cleanup(context);
  }
});
