/**
 * [INPUT]: User-selected local file paths and SQLite attachment records.
 * [OUTPUT]: Canonical metadata, missing-file reconciliation and safe record removal.
 * [POS]: Main-process boundary for local attachments; never copies or uploads file contents.
 * [PROTOCOL]: The original file is user-owned and must never be deleted by this service.
 */

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const MAX_ATTACHMENTS_PER_TURN = 20;
const MIME_TYPES = new Map([
  ['.png','image/png'], ['.jpg','image/jpeg'], ['.jpeg','image/jpeg'], ['.gif','image/gif'],
  ['.webp','image/webp'], ['.svg','image/svg+xml'], ['.pdf','application/pdf'],
  ['.json','application/json'], ['.js','text/javascript'], ['.mjs','text/javascript'],
  ['.ts','text/typescript'], ['.tsx','text/typescript'], ['.jsx','text/javascript'],
  ['.md','text/markdown'], ['.txt','text/plain'], ['.csv','text/csv'], ['.html','text/html'],
  ['.css','text/css'], ['.py','text/x-python'], ['.go','text/x-go'], ['.rs','text/x-rust']
]);

function mimeTypeFor(filePath) {
  return MIME_TYPES.get(path.extname(filePath).toLowerCase()) || 'application/octet-stream';
}

function mapRow(row) {
  return {
    id:row.id,
    name:row.name,
    path:row.file_path,
    mimeType:row.mime_type || 'application/octet-stream',
    sizeBytes:Number(row.size_bytes),
    missing:Boolean(row.missing),
    createdAt:row.created_at
  };
}

export function createAttachmentService(database) {
  function inspectPaths(paths = []) {
    if (!Array.isArray(paths)) throw new Error('附件列表格式无效。');
    if (paths.length > MAX_ATTACHMENTS_PER_TURN) throw new Error(`每轮最多选择 ${MAX_ATTACHMENTS_PER_TURN} 个附件。`);
    const seen = new Set();
    return paths.map(filePath => {
      if (typeof filePath !== 'string' || !filePath.trim()) throw new Error('附件路径无效。');
      let canonical;
      try {
        canonical = fs.realpathSync(path.resolve(filePath));
        fs.accessSync(canonical, fs.constants.R_OK);
      } catch {
        throw new Error(`附件不存在或不可读取：${filePath}`);
      }
      const stat = fs.statSync(canonical);
      if (!stat.isFile()) throw new Error(`附件不是普通文件：${canonical}`);
      if (seen.has(canonical)) throw new Error(`重复选择了附件：${path.basename(canonical)}`);
      seen.add(canonical);
      return {
        id:randomUUID(),
        name:path.basename(canonical),
        path:canonical,
        mimeType:mimeTypeFor(canonical),
        sizeBytes:stat.size,
        createdAt:new Date().toISOString()
      };
    });
  }

  function insertPrepared({ taskId, messageId, files }) {
    const insert = database.prepare(`
      INSERT INTO attachments (id, task_id, message_id, name, file_path, mime_type, size_bytes, missing, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?)
    `);
    for (const file of files) {
      insert.run(file.id, taskId, messageId, file.name, file.path, file.mimeType, file.sizeBytes, file.createdAt);
    }
  }

  function listForMessage(messageId) {
    const rows = database.prepare(`
      SELECT * FROM attachments WHERE message_id = ? ORDER BY created_at, id
    `).all(messageId);
    const updateMissing = database.prepare('UPDATE attachments SET missing = ? WHERE id = ?');
    return rows.map(row => {
      let missing = true;
      try { missing = !fs.statSync(row.file_path).isFile(); } catch { missing = true; }
      if (Number(row.missing) !== Number(missing)) updateMissing.run(Number(missing), row.id);
      return mapRow({ ...row, missing:Number(missing) });
    });
  }

  function availableForMessage(messageId) {
    return listForMessage(messageId).filter(file => !file.missing);
  }

  function remove({ taskId, attachmentId }) {
    const result = database.prepare('DELETE FROM attachments WHERE id = ? AND task_id = ?').run(attachmentId, taskId);
    if (result.changes !== 1) throw new Error('附件记录不存在。');
    return true;
  }

  return { inspectPaths, insertPrepared, listForMessage, availableForMessage, remove };
}
