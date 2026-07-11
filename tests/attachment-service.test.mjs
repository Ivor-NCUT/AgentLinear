import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createAttachmentService } from '../src/attachment-service.js';
import { openAgentLinearDatabase } from '../src/database.js';
import { createGroupService } from '../src/group-service.js';

test('stores canonical metadata, detects missing files and removes only the record', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlinear-attachments-'));
  const workspace = path.join(root, 'project');
  const filePath = path.join(root, 'notes.md');
  fs.mkdirSync(workspace);
  fs.writeFileSync(filePath, '# local attachment');
  const storage = await openAgentLinearDatabase({ filePath:path.join(root, 'data.sqlite3') });
  try {
    const group = createGroupService(storage.database).create(workspace);
    const now = new Date().toISOString();
    storage.database.prepare(`
      INSERT INTO tasks (id, group_id, title, prompt, status, created_at, updated_at)
      VALUES ('task-1', ?, 'Task', 'Prompt', 'draft', ?, ?)
    `).run(group.id, now, now);
    storage.database.prepare(`
      INSERT INTO messages (id, task_id, role, content, turn_index, created_at)
      VALUES ('message-1', 'task-1', 'user', 'Read it', 0, ?)
    `).run(now);
    const attachments = createAttachmentService(storage.database);
    const prepared = attachments.inspectPaths([filePath]);
    attachments.insertPrepared({ taskId:'task-1', messageId:'message-1', files:prepared });

    let [stored] = attachments.listForMessage('message-1');
    assert.equal(stored.path, fs.realpathSync(filePath));
    assert.equal(stored.mimeType, 'text/markdown');
    assert.equal(stored.missing, false);

    fs.rmSync(filePath);
    [stored] = attachments.listForMessage('message-1');
    assert.equal(stored.missing, true);
    attachments.remove({ taskId:'task-1', attachmentId:stored.id });
    assert.equal(attachments.listForMessage('message-1').length, 0);
  } finally {
    storage.close();
    fs.rmSync(root, { recursive:true, force:true });
  }
});

test('rejects duplicate and unreadable attachment paths', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlinear-attachments-'));
  const filePath = path.join(root, 'file.txt');
  fs.writeFileSync(filePath, 'text');
  const storage = await openAgentLinearDatabase({ filePath:path.join(root, 'data.sqlite3') });
  try {
    const attachments = createAttachmentService(storage.database);
    assert.throws(() => attachments.inspectPaths([filePath, filePath]), /重复选择/);
    assert.throws(() => attachments.inspectPaths([path.join(root, 'missing')]), /不存在或不可读取/);
  } finally {
    storage.close();
    fs.rmSync(root, { recursive:true, force:true });
  }
});
