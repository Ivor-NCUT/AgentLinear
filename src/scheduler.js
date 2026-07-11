/**
 * [INPUT]: SQLite queue entries and an async single-task executor.
 * [OUTPUT]: A persistent global FIFO scheduler with a hard concurrency limit.
 * [POS]: Sole owner of task admission; Codex adapters never decide when work starts.
 * [PROTOCOL]: Queue claims are persisted before execution and released only after settlement.
 */

import { randomUUID } from 'node:crypto';

export const MAX_CONCURRENT_TASKS = 6;

function now() {
  return new Date().toISOString();
}

export function createPersistentScheduler({
  database,
  executeTask,
  getTask,
  onChanged = () => {},
  onError = console.error,
  maxConcurrency = MAX_CONCURRENT_TASKS
}) {
  if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) throw new Error('并发上限必须是正整数。');
  const active = new Map();
  let draining = false;
  let paused = false;

  function enqueue(taskId) {
    database.exec('BEGIN IMMEDIATE;');
    try {
      const task = database.prepare('SELECT status FROM tasks WHERE id = ?').get(taskId);
      if (!task) throw new Error('任务不存在。');
      const existing = database.prepare('SELECT task_id FROM queue_entries WHERE task_id = ?').get(taskId);
      if (existing || active.has(taskId) || ['queued', 'running'].includes(task.status)) throw new Error('任务已经在运行或排队。');
      const position = Number(database.prepare('SELECT COALESCE(MAX(position), 0) + 1 AS value FROM queue_entries').get().value);
      const timestamp = now();
      database.prepare(`
        INSERT INTO queue_entries (task_id, position, enqueued_at) VALUES (?, ?, ?)
      `).run(taskId, position, timestamp);
      database.prepare(`
        UPDATE tasks SET status = 'queued', summary = ?, updated_at = ? WHERE id = ?
      `).run('等待全局执行槽位，将按提交顺序自动开始。', timestamp, taskId);
      database.exec('COMMIT;');
    } catch (error) {
      database.exec('ROLLBACK;');
      throw error;
    }
    drain();
    return getTask(taskId);
  }

  function claimNext() {
    const token = randomUUID();
    database.exec('BEGIN IMMEDIATE;');
    try {
      const entry = database.prepare(`
        SELECT task_id, position FROM queue_entries
        WHERE lease_token IS NULL ORDER BY position LIMIT 1
      `).get();
      if (!entry) {
        database.exec('COMMIT;');
        return null;
      }
      const timestamp = now();
      const claimed = database.prepare(`
        UPDATE queue_entries SET lease_token = ?, claimed_at = ?
        WHERE task_id = ? AND lease_token IS NULL
      `).run(token, timestamp, entry.task_id);
      if (claimed.changes !== 1) {
        database.exec('ROLLBACK;');
        return null;
      }
      database.prepare(`
        UPDATE tasks SET status = 'running', summary = ?, updated_at = ? WHERE id = ?
      `).run('本地 Codex 正在静默执行，本轮结束后展示最终结果。', timestamp, entry.task_id);
      database.exec('COMMIT;');
      return { taskId: entry.task_id, position: entry.position, token };
    } catch (error) {
      database.exec('ROLLBACK;');
      throw error;
    }
  }

  function release(claim) {
    database.prepare('DELETE FROM queue_entries WHERE task_id = ? AND lease_token = ?').run(claim.taskId, claim.token);
  }

  function drain() {
    if (draining || paused) return;
    draining = true;
    try {
      while (active.size < maxConcurrency) {
        const claim = claimNext();
        if (!claim) break;
        onChanged(getTask(claim.taskId));
        const execution = Promise.resolve()
          .then(() => executeTask(claim.taskId))
          .catch(onError)
          .finally(() => {
            try {
              release(claim);
            } catch (error) {
              onError(error);
            }
            active.delete(claim.taskId);
            drain();
          });
        active.set(claim.taskId, { ...claim, execution });
      }
    } finally {
      draining = false;
    }
  }

  function queueSnapshot() {
    return database.prepare(`
      SELECT task_id, position, enqueued_at
      FROM queue_entries WHERE lease_token IS NULL ORDER BY position
    `).all().map((entry, index) => ({
      taskId: entry.task_id,
      position: entry.position,
      queueIndex: index + 1,
      enqueuedAt: entry.enqueued_at
    }));
  }

  function cancelQueued(taskId) {
    database.exec('BEGIN IMMEDIATE;');
    try {
      const entry = database.prepare(`
        SELECT task_id FROM queue_entries WHERE task_id = ? AND lease_token IS NULL
      `).get(taskId);
      if (!entry) throw new Error('任务不在等待队列中。');
      const timestamp = now();
      database.prepare('DELETE FROM queue_entries WHERE task_id = ? AND lease_token IS NULL').run(taskId);
      database.prepare(`
        UPDATE tasks SET status = 'canceled', summary = ?, updated_at = ?, canceled_at = ? WHERE id = ?
      `).run('任务已从等待队列取消。', timestamp, timestamp, taskId);
      database.exec('COMMIT;');
    } catch (error) {
      database.exec('ROLLBACK;');
      throw error;
    }
    const task = getTask(taskId);
    onChanged(task);
    return task;
  }

  async function waitForIdle() {
    while (active.size || queueSnapshot().length) {
      await Promise.allSettled([...active.values()].map(item => item.execution));
    }
  }

  async function waitForActive() {
    await Promise.allSettled([...active.values()].map(item => item.execution));
  }

  return {
    enqueue,
    drain,
    pause: () => { paused = true; },
    resume: () => { paused = false; drain(); },
    cancelQueued,
    queueSnapshot,
    waitForIdle,
    waitForActive,
    runningCount: () => active.size,
    maxConcurrency
  };
}
