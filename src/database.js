/**
 * [INPUT]: A local database path and Node.js built-in SQLite.
 * [OUTPUT]: Versioned AgentLinear storage, backups and offline restore helpers.
 * [POS]: Main-process persistence layer; the renderer never imports this module.
 * [PROTOCOL]: Add schema changes as a new migration and update docs/ARCHITECTURE.md.
 */

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';

export const DATABASE_FILENAME = 'agentlinear.sqlite3';
export const LATEST_SCHEMA_VERSION = 2;

const migrations = [
  {
    version: 1,
    name: 'initial_local_storage',
    sql: `
      CREATE TABLE schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        folder_path TEXT NOT NULL UNIQUE,
        color TEXT NOT NULL DEFAULT '#5e6ad2',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        group_id TEXT NOT NULL REFERENCES groups(id) ON DELETE RESTRICT,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        summary TEXT,
        status TEXT NOT NULL CHECK (status IN ('draft','queued','running','done','failed','canceled','interrupted')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        canceled_at TEXT
      ) STRICT;

      CREATE INDEX tasks_group_updated_idx ON tasks(group_id, updated_at DESC);
      CREATE INDEX tasks_status_created_idx ON tasks(status, created_at);

      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL UNIQUE REFERENCES tasks(id) ON DELETE CASCADE,
        provider TEXT NOT NULL DEFAULT 'codex',
        external_session_id TEXT,
        cwd TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'new' CHECK (state IN ('new','ready','running','stopped','error')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;

      CREATE UNIQUE INDEX sessions_provider_external_idx
        ON sessions(provider, external_session_id)
        WHERE external_session_id IS NOT NULL;

      CREATE TABLE messages (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
        content TEXT NOT NULL,
        turn_index INTEGER NOT NULL CHECK (turn_index >= 0),
        created_at TEXT NOT NULL,
        UNIQUE(task_id, turn_index)
      ) STRICT;

      CREATE TABLE attachments (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
        name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        mime_type TEXT,
        size_bytes INTEGER NOT NULL DEFAULT 0 CHECK (size_bytes >= 0),
        missing INTEGER NOT NULL DEFAULT 0 CHECK (missing IN (0, 1)),
        created_at TEXT NOT NULL
      ) STRICT;

      CREATE INDEX attachments_task_idx ON attachments(task_id, created_at);

      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
        status TEXT NOT NULL CHECK (status IN ('starting','running','completed','failed','stopped','interrupted')),
        pid INTEGER,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        exit_code INTEGER,
        error_message TEXT,
        final_output TEXT
      ) STRICT;

      CREATE INDEX runs_task_started_idx ON runs(task_id, started_at DESC);
      CREATE INDEX runs_status_started_idx ON runs(status, started_at);

      CREATE TABLE queue_entries (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        position INTEGER NOT NULL UNIQUE CHECK (position > 0),
        enqueued_at TEXT NOT NULL,
        lease_token TEXT,
        claimed_at TEXT
      ) STRICT;

      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
    `
  },
  {
    version: 2,
    name: 'task_kinds',
    sql: `
      ALTER TABLE tasks ADD COLUMN task_kind TEXT NOT NULL DEFAULT 'codex'
        CHECK (task_kind IN ('todo', 'codex'));
    `
  }
];

export class DatabaseCorruptionError extends Error {
  constructor(message, quarantinePath, cause) {
    super(message, { cause });
    this.name = 'DatabaseCorruptionError';
    this.quarantinePath = quarantinePath;
  }
}

function timestampForFilename() {
  return new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-');
}

function configureConnection(database) {
  database.exec('PRAGMA foreign_keys = ON;');
  database.exec('PRAGMA journal_mode = WAL;');
  database.exec('PRAGMA synchronous = NORMAL;');
  database.exec('PRAGMA busy_timeout = 5000;');
}

function currentSchemaVersion(database) {
  return Number(database.prepare('PRAGMA user_version').get().user_version);
}

function verifyDatabase(database) {
  const result = database.prepare('PRAGMA quick_check').get();
  if (result.quick_check !== 'ok') throw new Error(`SQLite quick_check failed: ${result.quick_check}`);
}

function quarantineDatabase(filePath, cause) {
  const quarantinePath = `${filePath}.corrupt-${timestampForFilename()}`;
  if (fs.existsSync(filePath)) fs.renameSync(filePath, quarantinePath);
  for (const suffix of ['-wal', '-shm']) {
    const sidecar = `${filePath}${suffix}`;
    if (fs.existsSync(sidecar)) fs.renameSync(sidecar, `${quarantinePath}${suffix}`);
  }
  throw new DatabaseCorruptionError(
    `本地数据库无法通过完整性检查，已隔离到 ${quarantinePath}`,
    quarantinePath,
    cause
  );
}

async function createMigrationBackup(database, filePath, backupDirectory, fromVersion) {
  fs.mkdirSync(backupDirectory, { recursive: true });
  const backupPath = path.join(
    backupDirectory,
    `before-v${fromVersion}-to-v${LATEST_SCHEMA_VERSION}-${timestampForFilename()}.sqlite3`
  );
  await backup(database, backupPath);
  return backupPath;
}

function applyMigrations(database, fromVersion) {
  const pending = migrations.filter(migration => migration.version > fromVersion);
  if (pending.length === 0) return;

  database.exec('BEGIN IMMEDIATE;');
  try {
    for (const migration of pending) {
      database.exec(migration.sql);
      database.prepare(
        'INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)'
      ).run(migration.version, migration.name, new Date().toISOString());
      database.exec(`PRAGMA user_version = ${migration.version};`);
    }
    database.exec('COMMIT;');
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  }
}

export async function openAgentLinearDatabase({ filePath, backupDirectory = path.join(path.dirname(filePath), 'backups') }) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const existed = fs.existsSync(filePath) && fs.statSync(filePath).size > 0;
  let database;

  try {
    database = new DatabaseSync(filePath);
    configureConnection(database);
    if (existed) verifyDatabase(database);
  } catch (error) {
    database?.close();
    quarantineDatabase(filePath, error);
  }

  const fromVersion = currentSchemaVersion(database);
  if (fromVersion > LATEST_SCHEMA_VERSION) {
    database.close();
    throw new Error(`数据库版本 ${fromVersion} 高于应用支持的 ${LATEST_SCHEMA_VERSION}，请升级 AgentLinear。`);
  }

  const backupPath = existed && fromVersion < LATEST_SCHEMA_VERSION
    ? await createMigrationBackup(database, filePath, backupDirectory, fromVersion)
    : null;

  try {
    applyMigrations(database, fromVersion);
    verifyDatabase(database);
  } catch (error) {
    database.close();
    throw new Error(
      backupPath ? `数据库迁移失败，原始备份保存在 ${backupPath}` : '数据库初始化失败',
      { cause: error }
    );
  }

  return {
    database,
    databasePath: filePath,
    backupDirectory,
    migrationBackupPath: backupPath,
    schemaVersion: currentSchemaVersion(database),
    close() {
      database.close();
    }
  };
}

export async function createDatabaseBackup(database, backupDirectory, label = 'manual') {
  fs.mkdirSync(backupDirectory, { recursive: true });
  const safeLabel = label.replace(/[^a-z0-9_-]/gi, '-') || 'manual';
  const destination = path.join(backupDirectory, `${safeLabel}-${timestampForFilename()}.sqlite3`);
  await backup(database, destination);
  return destination;
}

export function restoreDatabaseBackup({ backupPath, destinationPath }) {
  if (!fs.existsSync(backupPath)) throw new Error(`备份文件不存在：${backupPath}`);
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });

  const temporaryPath = `${destinationPath}.restore-${process.pid}`;
  fs.copyFileSync(backupPath, temporaryPath);
  try {
    const verification = new DatabaseSync(temporaryPath, { readOnly: true });
    try {
      verifyDatabase(verification);
    } finally {
      verification.close();
    }
  } catch (error) {
    fs.rmSync(temporaryPath, { force: true });
    throw new Error('备份文件未通过 SQLite 完整性检查', { cause: error });
  }

  for (const suffix of ['', '-wal', '-shm']) {
    const target = `${destinationPath}${suffix}`;
    if (fs.existsSync(target)) fs.rmSync(target, { force: true });
  }
  fs.renameSync(temporaryPath, destinationPath);
  return destinationPath;
}
