import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { openAgentLinearDatabase } from '../src/database.js';
import { createGroupService } from '../src/group-service.js';

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlinear-groups-'));
  const storage = await openAgentLinearDatabase({ filePath: path.join(root, 'data', 'agentlinear.sqlite3') });
  return { root, storage, groups: createGroupService(storage.database) };
}

function cleanup({ root, storage }) {
  storage.close();
  fs.rmSync(root, { recursive: true, force: true });
}

test('creates and lists a group from a real folder', async () => {
  const context = await fixture();
  const folder = path.join(context.root, 'my-project');
  fs.mkdirSync(folder);
  try {
    const created = context.groups.create(folder);
    assert.equal(created.name, 'my-project');
    assert.equal(created.path, fs.realpathSync(folder));
    assert.equal(context.groups.list()[0].taskCount, 0);
    assert.throws(() => context.groups.create(folder), /已经关联/);
  } finally {
    cleanup(context);
  }
});

test('renames the folder and updates matching session working directories', async () => {
  const context = await fixture();
  const folder = path.join(context.root, 'before');
  fs.mkdirSync(folder);
  try {
    const group = context.groups.create(folder);
    const timestamp = new Date().toISOString();
    context.storage.database.prepare(`
      INSERT INTO tasks (id, group_id, title, prompt, status, created_at, updated_at)
      VALUES ('task-1', ?, 'task', 'prompt', 'draft', ?, ?)
    `).run(group.id, timestamp, timestamp);
    context.storage.database.prepare(`
      INSERT INTO sessions (id, task_id, cwd, created_at, updated_at)
      VALUES ('session-1', 'task-1', ?, ?, ?)
    `).run(group.path, timestamp, timestamp);

    const updated = context.groups.update({ id: group.id, name: 'after' });
    assert.equal(updated.name, 'after');
    assert.equal(fs.existsSync(folder), false);
    assert.equal(fs.existsSync(path.join(context.root, 'after')), true);
    assert.equal(
      context.storage.database.prepare("SELECT cwd FROM sessions WHERE id = 'session-1'").get().cwd,
      fs.realpathSync(path.join(context.root, 'after'))
    );
  } finally {
    cleanup(context);
  }
});

test('relinks a group without deleting the old folder', async () => {
  const context = await fixture();
  const original = path.join(context.root, 'original');
  const replacement = path.join(context.root, 'replacement');
  fs.mkdirSync(original);
  fs.mkdirSync(replacement);
  try {
    const group = context.groups.create(original);
    const updated = context.groups.update({ id: group.id, folderPath: replacement });
    assert.equal(updated.name, 'replacement');
    assert.equal(updated.path, fs.realpathSync(replacement));
    assert.equal(fs.existsSync(original), true);
  } finally {
    cleanup(context);
  }
});

test('rolls the filesystem rename back when the database update fails', async () => {
  const context = await fixture();
  const folder = path.join(context.root, 'stable');
  fs.mkdirSync(folder);
  try {
    const group = context.groups.create(folder);
    context.storage.database.exec(`
      CREATE TRIGGER reject_group_update BEFORE UPDATE ON groups
      BEGIN SELECT RAISE(ABORT, 'blocked for test'); END;
    `);
    assert.throws(() => context.groups.update({ id: group.id, name: 'should-not-stick' }), /blocked for test/);
    assert.equal(fs.existsSync(folder), true);
    assert.equal(fs.existsSync(path.join(context.root, 'should-not-stick')), false);
    assert.equal(context.groups.list()[0].path, fs.realpathSync(folder));
  } finally {
    cleanup(context);
  }
});

test('removes only empty groups and never deletes their folders', async () => {
  const context = await fixture();
  const emptyFolder = path.join(context.root, 'empty');
  const busyFolder = path.join(context.root, 'busy');
  fs.mkdirSync(emptyFolder);
  fs.mkdirSync(busyFolder);
  try {
    const empty = context.groups.create(emptyFolder);
    context.groups.remove(empty.id);
    assert.equal(fs.existsSync(emptyFolder), true);

    const busy = context.groups.create(busyFolder);
    const timestamp = new Date().toISOString();
    context.storage.database.prepare(`
      INSERT INTO tasks (id, group_id, title, prompt, status, created_at, updated_at)
      VALUES ('task-1', ?, 'task', 'prompt', 'draft', ?, ?)
    `).run(busy.id, timestamp, timestamp);
    assert.throws(() => context.groups.remove(busy.id), /仍有 1 个任务/);
  } finally {
    cleanup(context);
  }
});
