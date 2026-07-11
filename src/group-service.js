/**
 * [INPUT]: SQLite storage plus user-selected local folder paths.
 * [OUTPUT]: Folder-backed group CRUD with filesystem/database consistency.
 * [POS]: Main-process domain service for Session groups.
 * [PROTOCOL]: Group names always equal the basename of their real local folder.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const GROUP_COLORS = ['#5e6ad2', '#2e8b64', '#bf6b3b', '#7a5bb6', '#3b7fbf', '#a85c72'];

function now() {
  return new Date().toISOString();
}

function domainError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function canonicalFolder(folderPath) {
  if (typeof folderPath !== 'string' || !folderPath.trim()) throw domainError('INVALID_PATH', '请选择本地文件夹。');
  let resolved;
  try {
    resolved = fs.realpathSync(path.resolve(folderPath));
  } catch {
    throw domainError('MISSING_FOLDER', `文件夹不存在：${folderPath}`);
  }
  if (!fs.statSync(resolved).isDirectory()) throw domainError('NOT_A_FOLDER', `路径不是文件夹：${resolved}`);
  fs.accessSync(resolved, fs.constants.R_OK | fs.constants.W_OK);
  return resolved;
}

function validFolderName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\') || name.includes('\0')) {
    throw domainError('INVALID_NAME', '请输入不含路径分隔符的文件夹名称。');
  }
  return name;
}

function duplicateGroup(database, { folderPath, name, exceptId = '' }) {
  return database.prepare(`
    SELECT id, name, folder_path
    FROM groups
    WHERE id <> ? AND (lower(folder_path) = lower(?) OR lower(name) = lower(?))
    LIMIT 1
  `).get(exceptId, folderPath, name);
}

function mapGroup(row) {
  return {
    id: row.id,
    name: row.name,
    path: row.folder_path,
    color: row.color,
    taskCount: Number(row.task_count || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

export function createGroupService(database) {
  function list() {
    return database.prepare(`
      SELECT groups.*, COUNT(tasks.id) AS task_count
      FROM groups
      LEFT JOIN tasks ON tasks.group_id = groups.id
      GROUP BY groups.id
      ORDER BY groups.created_at, groups.id
    `).all().map(mapGroup);
  }

  function create(folderPath) {
    const canonicalPath = canonicalFolder(folderPath);
    const name = path.basename(canonicalPath);
    const duplicate = duplicateGroup(database, { folderPath: canonicalPath, name });
    if (duplicate) throw domainError('DUPLICATE_GROUP', `“${duplicate.name}”已经关联到看板。`);

    const count = Number(database.prepare('SELECT COUNT(*) AS count FROM groups').get().count);
    const timestamp = now();
    const group = {
      id: randomUUID(),
      name,
      path: canonicalPath,
      color: GROUP_COLORS[count % GROUP_COLORS.length],
      taskCount: 0,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    database.prepare(`
      INSERT INTO groups (id, name, folder_path, color, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(group.id, group.name, group.path, group.color, timestamp, timestamp);
    return group;
  }

  function update({ id, folderPath = null, name = null }) {
    const current = database.prepare('SELECT * FROM groups WHERE id = ?').get(id);
    if (!current) throw domainError('GROUP_NOT_FOUND', '分组不存在或已被移除。');

    const selectedPath = folderPath ? canonicalFolder(folderPath) : canonicalFolder(current.folder_path);
    const desiredName = validFolderName(name || path.basename(selectedPath));
    const desiredPath = path.join(path.dirname(selectedPath), desiredName);
    const duplicate = duplicateGroup(database, { folderPath: desiredPath, name: desiredName, exceptId: id });
    if (duplicate) throw domainError('DUPLICATE_GROUP', `“${duplicate.name}”已经使用相同名称或路径。`);

    const requiresRename = selectedPath !== desiredPath;
    if (requiresRename && fs.existsSync(desiredPath)) throw domainError('TARGET_EXISTS', `目标文件夹已经存在：${desiredPath}`);

    if (requiresRename) fs.renameSync(selectedPath, desiredPath);
    let transactionStarted = false;
    try {
      database.exec('BEGIN IMMEDIATE;');
      transactionStarted = true;
      const timestamp = now();
      database.prepare(`
        UPDATE groups SET name = ?, folder_path = ?, updated_at = ? WHERE id = ?
      `).run(desiredName, desiredPath, timestamp, id);
      database.prepare(`
        UPDATE sessions
        SET cwd = ?, updated_at = ?
        WHERE cwd = ? AND task_id IN (SELECT id FROM tasks WHERE group_id = ?)
      `).run(desiredPath, timestamp, current.folder_path, id);
      database.exec('COMMIT;');
      transactionStarted = false;
      return mapGroup(database.prepare(`
        SELECT groups.*, COUNT(tasks.id) AS task_count
        FROM groups LEFT JOIN tasks ON tasks.group_id = groups.id
        WHERE groups.id = ? GROUP BY groups.id
      `).get(id));
    } catch (error) {
      if (transactionStarted) database.exec('ROLLBACK;');
      if (requiresRename) {
        try {
          fs.renameSync(desiredPath, selectedPath);
        } catch (rollbackError) {
          throw domainError('ROLLBACK_FAILED', `数据库更新失败，且文件夹无法恢复：${rollbackError.message}`);
        }
      }
      throw error;
    }
  }

  function remove(id) {
    const group = database.prepare(`
      SELECT groups.*, COUNT(tasks.id) AS task_count
      FROM groups LEFT JOIN tasks ON tasks.group_id = groups.id
      WHERE groups.id = ? GROUP BY groups.id
    `).get(id);
    if (!group) throw domainError('GROUP_NOT_FOUND', '分组不存在或已被移除。');
    if (Number(group.task_count) > 0) throw domainError('GROUP_NOT_EMPTY', `该分组仍有 ${group.task_count} 个任务，无法移除。`);
    database.prepare('DELETE FROM groups WHERE id = ?').run(id);
    return mapGroup(group);
  }

  return { list, create, update, remove };
}
