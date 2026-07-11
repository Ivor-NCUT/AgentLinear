import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
  LATEST_SCHEMA_VERSION,
  createDatabaseBackup,
  openAgentLinearDatabase,
  restoreDatabaseBackup
} from '../src/database.js';

function temporaryWorkspace() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'agentlinear-db-'));
}

function insertFixture(database) {
  const now = new Date().toISOString();
  database.prepare(`
    INSERT INTO groups (id, name, folder_path, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run('group-1', 'agentlinear', '/tmp/agentlinear', now, now);
  database.prepare(`
    INSERT INTO tasks (id, group_id, title, prompt, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('task-1', 'group-1', '测试任务', '完成数据库测试', 'queued', now, now);
  database.prepare(`
    INSERT INTO sessions (id, task_id, cwd, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `).run('session-1', 'task-1', '/tmp/agentlinear', now, now);
  database.prepare(`
    INSERT INTO messages (id, task_id, session_id, role, content, turn_index, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('message-1', 'task-1', 'session-1', 'user', '开始工作', 0, now);
  database.prepare(`
    INSERT INTO queue_entries (task_id, position, enqueued_at)
    VALUES (?, ?, ?)
  `).run('task-1', 1, now);
}

test('creates the complete v1 schema and enforces relationships', async () => {
  const root = temporaryWorkspace();
  const context = await openAgentLinearDatabase({ filePath: path.join(root, 'agentlinear.sqlite3') });
  try {
    assert.equal(context.schemaVersion, LATEST_SCHEMA_VERSION);
    const tables = context.database.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
    `).all().map(row => row.name);
    for (const table of ['attachments','groups','messages','queue_entries','runs','schema_migrations','sessions','settings','tasks']) {
      assert.ok(tables.includes(table), `missing table ${table}`);
    }

    insertFixture(context.database);
    assert.equal(context.database.prepare('SELECT COUNT(*) AS count FROM tasks').get().count, 1);
    assert.throws(() => {
      context.database.prepare(`
        INSERT INTO tasks (id, group_id, title, prompt, status, created_at, updated_at)
        VALUES ('bad-task', 'missing-group', 'bad', 'bad', 'draft', 'now', 'now')
      `).run();
    }, /FOREIGN KEY/);
  } finally {
    context.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('persists data across reopen', async () => {
  const root = temporaryWorkspace();
  const filePath = path.join(root, 'agentlinear.sqlite3');
  const first = await openAgentLinearDatabase({ filePath });
  insertFixture(first.database);
  first.close();

  const second = await openAgentLinearDatabase({ filePath });
  try {
    assert.equal(second.database.prepare('SELECT title FROM tasks WHERE id = ?').get('task-1').title, '测试任务');
    assert.equal(second.database.prepare('SELECT position FROM queue_entries WHERE task_id = ?').get('task-1').position, 1);
  } finally {
    second.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('creates and restores a verified offline backup', async () => {
  const root = temporaryWorkspace();
  const filePath = path.join(root, 'agentlinear.sqlite3');
  const first = await openAgentLinearDatabase({ filePath });
  insertFixture(first.database);
  const backupPath = await createDatabaseBackup(first.database, path.join(root, 'backups'), 'test');
  first.close();

  const changed = await openAgentLinearDatabase({ filePath });
  changed.database.prepare("UPDATE tasks SET title = '被修改' WHERE id = 'task-1'").run();
  changed.close();

  restoreDatabaseBackup({ backupPath, destinationPath: filePath });
  const restored = await openAgentLinearDatabase({ filePath });
  try {
    assert.equal(restored.database.prepare('SELECT title FROM tasks WHERE id = ?').get('task-1').title, '测试任务');
  } finally {
    restored.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('backs up an existing database before its first migration', async () => {
  const root = temporaryWorkspace();
  const filePath = path.join(root, 'agentlinear.sqlite3');
  const legacy = new DatabaseSync(filePath);
  legacy.exec("CREATE TABLE legacy_data (value TEXT); INSERT INTO legacy_data VALUES ('keep-me');");
  legacy.close();

  const context = await openAgentLinearDatabase({ filePath });
  try {
    assert.ok(context.migrationBackupPath);
    assert.ok(fs.existsSync(context.migrationBackupPath));
    const snapshot = new DatabaseSync(context.migrationBackupPath, { readOnly: true });
    try {
      assert.equal(snapshot.prepare('SELECT value FROM legacy_data').get().value, 'keep-me');
    } finally {
      snapshot.close();
    }
  } finally {
    context.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('quarantines a corrupt database instead of overwriting it', async () => {
  const root = temporaryWorkspace();
  const filePath = path.join(root, 'agentlinear.sqlite3');
  fs.writeFileSync(filePath, 'not a sqlite database');

  await assert.rejects(
    openAgentLinearDatabase({ filePath }),
    error => error.name === 'DatabaseCorruptionError' && fs.existsSync(error.quarantinePath)
  );
  assert.equal(fs.existsSync(filePath), false);
  fs.rmSync(root, { recursive: true, force: true });
});
