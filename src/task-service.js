/**
 * [INPUT]: SQLite, a Codex adapter and a local environment readiness check.
 * [OUTPUT]: Persistent task creation, queued execution, Session resume and message history.
 * [POS]: Application service joining task cards to the scheduler and local Codex sessions.
 * [PROTOCOL]: Every admitted turn creates one run and appends immutable user/assistant messages.
 */

import { randomUUID } from 'node:crypto';
import { createAttachmentService } from './attachment-service.js';

function timestamp() {
  return new Date().toISOString();
}

function taskSummary(status) {
  return {
    draft: '任务已保存，等待进入执行队列。',
    running: '本地 Codex 正在静默执行，本轮结束后展示最终结果。',
    done: '任务已完成，最终交付已保存到本地。',
    failed: '本轮执行失败，历史上下文已经保留。'
  }[status] || '';
}

function requiredText(value, label, maxLength) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new Error(`请填写${label}。`);
  if (text.length > maxLength) throw new Error(`${label}不能超过 ${maxLength} 个字符。`);
  return text;
}

export function createTaskService({ database, adapter, ensureReady, onChanged = () => {}, executionTimeoutMs = 60 * 60 * 1000 }) {
  let scheduler;
  const attachmentService = createAttachmentService(database);
  const activeControllers = new Map();
  const pendingStopRequests = new Map();

  function setScheduler(value) {
    if (scheduler) throw new Error('调度器已经设置。');
    scheduler = value;
  }

  function requireScheduler() {
    if (!scheduler) throw new Error('任务调度器尚未初始化。');
    return scheduler;
  }

  function nextTaskId() {
    const row = database.prepare(`
      SELECT COALESCE(MAX(CAST(substr(id, 5) AS INTEGER)), 1000) + 1 AS next_id
      FROM tasks WHERE id GLOB 'AGT-[0-9]*'
    `).get();
    return `AGT-${row.next_id}`;
  }

  function messages(taskId) {
    return database.prepare(`
      SELECT id, role, content, turn_index, created_at
      FROM messages WHERE task_id = ? ORDER BY turn_index
    `).all(taskId).map(row => ({
      id: row.id,
      role: row.role,
      content: row.content,
      turnIndex: row.turn_index,
      createdAt: row.created_at,
      attachments:attachmentService.listForMessage(row.id)
    }));
  }

  function get(taskId) {
    const row = database.prepare(`
      SELECT tasks.*, groups.folder_path, sessions.id AS local_session_id,
             sessions.external_session_id, sessions.state AS session_state,
             queue_entries.position AS queue_position,
             CASE WHEN queue_entries.lease_token IS NULL AND queue_entries.position IS NOT NULL THEN (
               SELECT COUNT(*) FROM queue_entries queued
               WHERE queued.lease_token IS NULL AND queued.position <= queue_entries.position
             ) ELSE NULL END AS queue_index,
             runs.status AS latest_run_status, runs.started_at AS latest_run_started_at,
             runs.finished_at AS latest_run_finished_at, runs.exit_code AS latest_exit_code
      FROM tasks
      JOIN groups ON groups.id = tasks.group_id
      LEFT JOIN sessions ON sessions.task_id = tasks.id
      LEFT JOIN queue_entries ON queue_entries.task_id = tasks.id
      LEFT JOIN runs ON runs.id = (
        SELECT id FROM runs WHERE task_id = tasks.id ORDER BY started_at DESC LIMIT 1
      )
      WHERE tasks.id = ?
    `).get(taskId);
    if (!row) return null;
    const history = messages(taskId);
    return {
      id: row.id,
      groupId: row.group_id,
      title: row.title,
      status: row.status,
      summary: row.summary || taskSummary(row.status),
      cwd: row.folder_path,
      sessionId: row.external_session_id,
      sessionState: row.session_state,
      queuePosition: row.queue_position,
      queueIndex: row.queue_index,
      turns: history.filter(message => message.role === 'user').length,
      prompt: history.find(message => message.role === 'user')?.content || row.prompt,
      finalOutput: [...history].reverse().find(message => message.role === 'assistant')?.content || '',
      messages: history,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      completedAt: row.completed_at,
      latestRun: row.latest_run_status ? {
        status: row.latest_run_status,
        startedAt: row.latest_run_started_at,
        finishedAt: row.latest_run_finished_at,
        exitCode: row.latest_exit_code
      } : null
    };
  }

  function list() {
    return database.prepare('SELECT id FROM tasks ORDER BY created_at, id').all().map(row => get(row.id));
  }

  function create({ groupId, title, prompt, attachmentPaths = [] }) {
    const cleanTitle = requiredText(title, '任务标题', 120);
    const cleanPrompt = requiredText(prompt, '第一条指令', 100_000);
    const group = database.prepare('SELECT * FROM groups WHERE id = ?').get(groupId);
    if (!group) throw new Error('当前 Session 分组不存在。');
    ensureReady(group.folder_path);
    const preparedAttachments = attachmentService.inspectPaths(attachmentPaths);

    const taskId = nextTaskId();
    const sessionId = randomUUID();
    const now = timestamp();
    database.exec('BEGIN IMMEDIATE;');
    try {
      database.prepare(`
        INSERT INTO tasks (id, group_id, title, prompt, summary, status, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'draft', ?, ?)
      `).run(taskId, groupId, cleanTitle, cleanPrompt, taskSummary('draft'), now, now);
      database.prepare(`
        INSERT INTO sessions (id, task_id, cwd, state, created_at, updated_at)
        VALUES (?, ?, ?, 'new', ?, ?)
      `).run(sessionId, taskId, group.folder_path, now, now);
      const messageId = randomUUID();
      database.prepare(`
        INSERT INTO messages (id, task_id, session_id, role, content, turn_index, created_at)
        VALUES (?, ?, ?, 'user', ?, 0, ?)
      `).run(messageId, taskId, sessionId, cleanPrompt, now);
      attachmentService.insertPrepared({ taskId, messageId, files:preparedAttachments });
      database.exec('COMMIT;');
    } catch (error) {
      database.exec('ROLLBACK;');
      throw error;
    }
    const task = requireScheduler().enqueue(taskId);
    onChanged(task);
    return get(taskId);
  }

  function followup({ taskId, prompt, attachmentPaths = [] }) {
    const current = get(taskId);
    if (!current) throw new Error('任务不存在。');
    if (['queued', 'running'].includes(current.status)) throw new Error('这个任务仍在执行或排队，请等待本轮结束。');
    if (!current.sessionId) throw new Error('任务尚未获得可恢复的 Codex Session ID。');
    ensureReady(current.cwd);
    const preparedAttachments = attachmentService.inspectPaths(attachmentPaths);
    const cleanPrompt = typeof prompt === 'string' && prompt.trim()
      ? requiredText(prompt, '补充指令', 100_000)
      : preparedAttachments.length
        ? '请查看本轮附件，并结合当前会话上下文继续处理。'
        : requiredText(prompt, '补充指令', 100_000);

    const localSession = database.prepare('SELECT id FROM sessions WHERE task_id = ?').get(taskId);
    const turnIndex = Number(database.prepare('SELECT COALESCE(MAX(turn_index), -1) + 1 AS value FROM messages WHERE task_id = ?').get(taskId).value);
    const now = timestamp();
    database.exec('BEGIN IMMEDIATE;');
    try {
      const messageId = randomUUID();
      database.prepare(`
        INSERT INTO messages (id, task_id, session_id, role, content, turn_index, created_at)
        VALUES (?, ?, ?, 'user', ?, ?, ?)
      `).run(messageId, taskId, localSession.id, cleanPrompt, turnIndex, now);
      attachmentService.insertPrepared({ taskId, messageId, files:preparedAttachments });
      database.prepare(`
        UPDATE tasks SET status = 'draft', summary = ?, updated_at = ?, completed_at = NULL WHERE id = ?
      `).run(taskSummary('draft'), now, taskId);
      database.exec('COMMIT;');
    } catch (error) {
      database.exec('ROLLBACK;');
      throw error;
    }
    const task = requireScheduler().enqueue(taskId);
    onChanged(task);
    return get(taskId);
  }

  async function executeQueued(taskId) {
    const task = get(taskId);
    if (!task || task.status !== 'running') throw new Error('调度器尝试执行无效任务。');
    const session = database.prepare('SELECT * FROM sessions WHERE task_id = ?').get(taskId);
    const userMessage = database.prepare(`
      SELECT id, content FROM messages WHERE task_id = ? AND role = 'user' ORDER BY turn_index DESC LIMIT 1
    `).get(taskId);
    const runId = randomUUID();
    const controller = new AbortController();
    const now = timestamp();
    database.exec('BEGIN IMMEDIATE;');
    try {
      database.prepare(`
        INSERT INTO runs (id, task_id, session_id, status, started_at)
        VALUES (?, ?, ?, 'running', ?)
      `).run(runId, taskId, session.id, now);
      database.prepare("UPDATE sessions SET state = 'running', updated_at = ? WHERE id = ?").run(now, session.id);
      database.exec('COMMIT;');
    } catch (error) {
      database.exec('ROLLBACK;');
      throw error;
    }

    activeControllers.set(taskId, controller);
    try {
      const readiness = ensureReady(task.cwd);
      const pendingStop = pendingStopRequests.get(taskId);
      if (pendingStop) controller.abort(pendingStop);
      const result = await adapter.execute({
        executable: readiness.codexExecutable,
        cwd: task.cwd,
        prompt: userMessage.content,
        sessionId: session.external_session_id || null,
        signal: controller.signal,
        timeoutMs: executionTimeoutMs,
        attachments:attachmentService.availableForMessage(userMessage.id),
        onEvent:event => {
          if (event.type === 'thread.started' && event.thread_id) {
            database.prepare(`
              UPDATE sessions SET external_session_id = ?, updated_at = ? WHERE id = ?
            `).run(event.thread_id, timestamp(), session.id);
          }
        },
        onSpawn: pid => database.prepare('UPDATE runs SET pid = ? WHERE id = ?').run(pid, runId)
      });
      finishSuccess({ taskId, runId, localSessionId:session.id }, result);
    } catch (error) {
      if (error?.result?.termination) finishTermination({ taskId, runId, localSessionId:session.id }, error);
      else finishFailure({ taskId, runId, localSessionId:session.id }, error);
    } finally {
      activeControllers.delete(taskId);
      pendingStopRequests.delete(taskId);
    }
  }

  function finishSuccess(input, result) {
    const now = timestamp();
    const turnIndex = Number(database.prepare('SELECT COALESCE(MAX(turn_index), -1) + 1 AS value FROM messages WHERE task_id = ?').get(input.taskId).value);
    database.exec('BEGIN IMMEDIATE;');
    try {
      database.prepare(`
        UPDATE sessions SET external_session_id = ?, state = 'ready', updated_at = ? WHERE id = ?
      `).run(result.sessionId, now, input.localSessionId);
      database.prepare(`
        UPDATE runs SET status = 'completed', finished_at = ?, exit_code = ?, final_output = ? WHERE id = ?
      `).run(now, result.exitCode, result.finalOutput, input.runId);
      database.prepare(`
        INSERT INTO messages (id, task_id, session_id, role, content, turn_index, created_at)
        VALUES (?, ?, ?, 'assistant', ?, ?, ?)
      `).run(randomUUID(), input.taskId, input.localSessionId, result.finalOutput, turnIndex, now);
      database.prepare(`
        UPDATE tasks SET status = 'done', summary = ?, updated_at = ?, completed_at = ? WHERE id = ?
      `).run(taskSummary('done'), now, now, input.taskId);
      database.exec('COMMIT;');
    } catch (error) {
      database.exec('ROLLBACK;');
      throw error;
    }
    onChanged(get(input.taskId));
  }

  function finishFailure(input, error) {
    const now = timestamp();
    const result = error?.result || {};
    database.exec('BEGIN IMMEDIATE;');
    try {
      if (result.sessionId) database.prepare(`
        UPDATE sessions SET external_session_id = ?, state = 'error', updated_at = ? WHERE id = ?
      `).run(result.sessionId, now, input.localSessionId);
      else database.prepare("UPDATE sessions SET state = 'error', updated_at = ? WHERE id = ?").run(now, input.localSessionId);
      database.prepare(`
        UPDATE runs SET status = 'failed', finished_at = ?, exit_code = ?, error_message = ? WHERE id = ?
      `).run(now, result.exitCode ?? null, error instanceof Error ? error.message : String(error), input.runId);
      database.prepare(`
        UPDATE tasks SET status = 'failed', summary = ?, updated_at = ? WHERE id = ?
      `).run(taskSummary('failed'), now, input.taskId);
      database.exec('COMMIT;');
    } catch (databaseError) {
      database.exec('ROLLBACK;');
      throw databaseError;
    }
    onChanged(get(input.taskId));
  }

  function finishTermination(input, error) {
    const now = timestamp();
    const termination = error.result.termination;
    const isShutdown = termination.kind === 'shutdown';
    const isUserStop = termination.kind === 'user';
    const taskStatus = isShutdown ? 'interrupted' : isUserStop ? 'canceled' : 'failed';
    const runStatus = isShutdown ? 'interrupted' : isUserStop ? 'stopped' : 'failed';
    const sessionState = taskStatus === 'failed' ? 'error' : 'stopped';
    const summary = isShutdown
      ? '应用退出时已终止本轮进程，历史上下文和运行记录已保留。'
      : isUserStop
        ? '用户已停止本轮执行，Codex 进程树已终止。'
        : '任务执行超时，Codex 进程树已自动终止。';
    database.exec('BEGIN IMMEDIATE;');
    try {
      if (error.result.sessionId) database.prepare(`
        UPDATE sessions SET external_session_id = ?, state = ?, updated_at = ? WHERE id = ?
      `).run(error.result.sessionId, sessionState, now, input.localSessionId);
      else database.prepare('UPDATE sessions SET state = ?, updated_at = ? WHERE id = ?').run(sessionState, now, input.localSessionId);
      database.prepare(`
        UPDATE runs SET status = ?, finished_at = ?, exit_code = ?, error_message = ? WHERE id = ?
      `).run(runStatus, now, error.result.exitCode ?? null, error.message, input.runId);
      database.prepare(`
        UPDATE tasks SET status = ?, summary = ?, updated_at = ?, canceled_at = ? WHERE id = ?
      `).run(taskStatus, summary, now, isUserStop ? now : null, input.taskId);
      database.exec('COMMIT;');
    } catch (databaseError) {
      database.exec('ROLLBACK;');
      throw databaseError;
    }
    onChanged(get(input.taskId));
  }

  function stop(taskId, reason = { kind:'user', message:'用户停止了任务。' }) {
    const task = get(taskId);
    if (!task) throw new Error('任务不存在。');
    if (task.status === 'queued') return requireScheduler().cancelQueued(taskId);
    if (task.status !== 'running') throw new Error('只有运行中或排队中的任务可以停止。');
    const normalizedReason = typeof reason === 'object' && reason ? reason : { kind:'user', message:String(reason) };
    const controller = activeControllers.get(taskId);
    if (controller) controller.abort(normalizedReason);
    else pendingStopRequests.set(taskId, normalizedReason);
    database.prepare('UPDATE tasks SET summary = ?, updated_at = ? WHERE id = ?')
      .run('正在终止 Codex 进程树…', timestamp(), taskId);
    const updated = get(taskId);
    onChanged(updated);
    return updated;
  }

  function stopAll(reason = { kind:'shutdown', message:'AgentLinear 正在退出。' }) {
    const running = database.prepare("SELECT id FROM tasks WHERE status = 'running'").all();
    for (const task of running) {
      try { stop(task.id, reason); } catch { /* Continue stopping the remaining processes. */ }
    }
    return running.length;
  }

  function removeAttachment({ taskId, attachmentId }) {
    attachmentService.remove({ taskId, attachmentId });
    const task = get(taskId);
    onChanged(task);
    return task;
  }

  function retry(taskId) {
    const task = get(taskId);
    if (!task) throw new Error('任务不存在。');
    if (!['failed', 'interrupted'].includes(task.status)) throw new Error('只有失败或中断的任务可以重试。');
    ensureReady(task.cwd);
    const now = timestamp();
    database.exec('BEGIN IMMEDIATE;');
    try {
      database.prepare(`
        UPDATE tasks SET status = 'draft', summary = ?, updated_at = ?, completed_at = NULL, canceled_at = NULL WHERE id = ?
      `).run(taskSummary('draft'), now, taskId);
      database.prepare(`
        UPDATE sessions SET state = ?, updated_at = ? WHERE task_id = ?
      `).run(task.sessionId ? 'ready' : 'new', now, taskId);
      database.exec('COMMIT;');
    } catch (error) {
      database.exec('ROLLBACK;');
      throw error;
    }
    const queued = requireScheduler().enqueue(taskId);
    onChanged(queued);
    return get(taskId);
  }

  return {
    list,
    get,
    create,
    followup,
    executeQueued,
    setScheduler,
    stop,
    stopAll,
    removeAttachment,
    retry,
    activeCount: () => activeControllers.size
  };
}
