import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { openAgentLinearDatabase } from '../src/database.js';
import { createGroupService } from '../src/group-service.js';
import { reconcileStartupState } from '../src/recovery.js';
import { createPersistentScheduler } from '../src/scheduler.js';
import { createTaskService } from '../src/task-service.js';

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

function insertTask(database, { id, groupId, status, externalSessionId = null }) {
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO tasks (id, group_id, title, prompt, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(id, groupId, id, `Prompt ${id}`, status, now, now);
  database.prepare(`
    INSERT INTO sessions (id, task_id, external_session_id, cwd, state, created_at, updated_at)
    VALUES (?, ?, ?, '/tmp/project', 'running', ?, ?)
  `).run(`session-${id}`, id, externalSessionId, now, now);
  database.prepare(`
    INSERT INTO messages (id, task_id, session_id, role, content, turn_index, created_at)
    VALUES (?, ?, ?, 'user', ?, 0, ?)
  `).run(`message-${id}`, id, `session-${id}`, `Prompt ${id}`, now);
}

test('reconciles crash leftovers without killing a reused PID and preserves FIFO', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlinear-recovery-'));
  const workspace = path.join(root, 'project');
  fs.mkdirSync(workspace);
  const filePath = path.join(root, 'data.sqlite3');
  const storage = await openAgentLinearDatabase({ filePath });
  const group = createGroupService(storage.database).create(workspace);
  const now = new Date().toISOString();
  try {
    for (const item of [
      { id:'AGT-1001', status:'running', externalSessionId:'thread-1' },
      { id:'AGT-1002', status:'queued' },
      { id:'AGT-1003', status:'running' },
      { id:'AGT-1004', status:'draft' },
      { id:'AGT-1005', status:'running' },
      { id:'AGT-1006', status:'running' }
    ]) insertTask(storage.database, { ...item, groupId:group.id });
    storage.database.prepare(`INSERT INTO runs (id, task_id, session_id, status, pid, started_at) VALUES ('run-1','AGT-1001','session-AGT-1001','running',111,?)`).run(now);
    storage.database.prepare(`INSERT INTO runs (id, task_id, session_id, status, pid, started_at) VALUES ('run-6','AGT-1006','session-AGT-1006','running',222,?)`).run(now);
    storage.database.prepare(`INSERT INTO queue_entries (task_id, position, enqueued_at, lease_token, claimed_at) VALUES ('AGT-1001',1,?,'lease-1',?)`).run(now, now);
    storage.database.prepare(`INSERT INTO queue_entries (task_id, position, enqueued_at) VALUES ('AGT-1002',2,?)`).run(now);
    storage.database.prepare(`INSERT INTO queue_entries (task_id, position, enqueued_at, lease_token, claimed_at) VALUES ('AGT-1003',3,?,'lease-3',?)`).run(now, now);

    const terminated = [];
    const report = await reconcileStartupState({
      database:storage.database,
      expectedExecutable:'/usr/local/bin/codex',
      inspectProcess:pid => pid === 111
        ? { alive:true, command:'/usr/local/bin/codex exec --json' }
        : pid === 222
          ? { alive:true, command:'/Applications/Unrelated.app/worker' }
          : { alive:false, command:'' },
      terminateProcess:async pid => { terminated.push(pid); return true; }
    });

    assert.deepEqual(terminated, [111]);
    assert.equal(report.orphanProcessesStopped, 1);
    assert.equal(report.unrecognizedProcessesSkipped, 1);
    assert.equal(report.interrupted, 3);
    assert.equal(report.requeued, 2);
    assert.equal(storage.database.prepare("SELECT status FROM runs WHERE id='run-1'").get().status, 'interrupted');
    assert.equal(storage.database.prepare("SELECT status FROM tasks WHERE id='AGT-1005'").get().status, 'interrupted');
    assert.deepEqual(storage.database.prepare(`
      SELECT task_id FROM queue_entries WHERE lease_token IS NULL ORDER BY position
    `).all().map(row => row.task_id), ['AGT-1002','AGT-1003','AGT-1004']);

    const secondPass = await reconcileStartupState({ database:storage.database, inspectProcess:() => ({ alive:false, command:'' }) });
    assert.equal(secondPass.interrupted, 0);
    assert.equal(secondPass.requeued, 0);
  } finally {
    storage.close();
    fs.rmSync(root, { recursive:true, force:true });
  }
});

test('lets the user retry an interrupted task with its saved Session', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlinear-retry-'));
  const workspace = path.join(root, 'project');
  fs.mkdirSync(workspace);
  const storage = await openAgentLinearDatabase({ filePath:path.join(root, 'data.sqlite3') });
  const group = createGroupService(storage.database).create(workspace);
  insertTask(storage.database, { id:'AGT-1001', groupId:group.id, status:'interrupted', externalSessionId:'thread-existing' });
  const calls = [];
  const service = createTaskService({
    database:storage.database,
    adapter:{ async execute(input) { calls.push(input); return { sessionId:'thread-existing', finalOutput:'recovered', exitCode:0 }; } },
    ensureReady:() => ({ codexExecutable:'codex' })
  });
  const scheduler = createPersistentScheduler({ database:storage.database, executeTask:id => service.executeQueued(id), getTask:id => service.get(id) });
  service.setScheduler(scheduler);
  try {
    const retried = service.retry('AGT-1001');
    assert.equal(retried.status, 'running');
    await scheduler.waitForIdle();
    assert.equal(service.get('AGT-1001').status, 'done');
    assert.equal(calls[0].sessionId, 'thread-existing');
  } finally {
    storage.close();
    fs.rmSync(root, { recursive:true, force:true });
  }
});

test('terminates a real orphan process tree before marking its task interrupted', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlinear-orphan-recovery-'));
  const workspace = path.join(root, 'project');
  const pidFile = path.join(root, 'pids.json');
  const fixture = path.join(fixtureDirectory, 'fixtures', 'process-tree.mjs');
  fs.mkdirSync(workspace);
  const storage = await openAgentLinearDatabase({ filePath:path.join(root, 'data.sqlite3') });
  const group = createGroupService(storage.database).create(workspace);
  const orphan = spawn(process.execPath, [fixture, pidFile], {
    stdio:'ignore',
    detached:process.platform !== 'win32'
  });
  let pids = { parent:orphan.pid, child:null };
  try {
    await waitFor(() => fs.existsSync(pidFile));
    pids = JSON.parse(fs.readFileSync(pidFile, 'utf8'));
    insertTask(storage.database, { id:'AGT-ORPHAN', groupId:group.id, status:'running', externalSessionId:'thread-orphan' });
    const startedAt = new Date().toISOString();
    storage.database.prepare(`
      INSERT INTO runs (id, task_id, session_id, status, pid, started_at)
      VALUES ('run-orphan','AGT-ORPHAN','session-AGT-ORPHAN','running',?,?)
    `).run(pids.parent, startedAt);
    storage.database.prepare(`
      INSERT INTO queue_entries (task_id, position, enqueued_at, lease_token, claimed_at)
      VALUES ('AGT-ORPHAN',1,?,'lease-orphan',?)
    `).run(startedAt, startedAt);

    const report = await reconcileStartupState({
      database:storage.database,
      expectedExecutable:fixture
    });

    await waitFor(() => !processIsAlive(pids.parent) && !processIsAlive(pids.child));
    assert.equal(report.orphanProcessesStopped, 1);
    assert.equal(report.interrupted, 1);
    assert.equal(storage.database.prepare("SELECT status FROM tasks WHERE id='AGT-ORPHAN'").get().status, 'interrupted');
    assert.equal(storage.database.prepare("SELECT status FROM runs WHERE id='run-orphan'").get().status, 'interrupted');
    assert.equal(storage.database.prepare("SELECT COUNT(*) AS count FROM queue_entries WHERE task_id='AGT-ORPHAN'").get().count, 0);
  } finally {
    if (processIsAlive(pids.parent)) process.kill(-pids.parent, 'SIGKILL');
    storage.close();
    fs.rmSync(root, { recursive:true, force:true });
  }
});
