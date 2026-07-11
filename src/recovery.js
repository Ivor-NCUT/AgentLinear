/**
 * [INPUT]: Persisted task/run/queue state plus live OS process inspection.
 * [OUTPUT]: A trustworthy startup state and a structured recovery report.
 * [POS]: Runs before the scheduler starts, reconciling crash leftovers exactly once.
 * [PROTOCOL]: Never automatically re-run a task that may already have modified files.
 */

import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { terminateProcessTree } from './codex-adapter.js';

function now() {
  return new Date().toISOString();
}

export function inspectLocalProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return { alive:false, command:'' };
  const result = process.platform === 'win32'
    ? spawnSync('powershell.exe', ['-NoProfile', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CommandLine`], { encoding:'utf8', windowsHide:true })
    : spawnSync('ps', ['-p', String(pid), '-o', 'command='], { encoding:'utf8' });
  return { alive:result.status === 0 && Boolean(result.stdout.trim()), command:result.stdout.trim() };
}

export function looksLikeCodexProcess(command, expectedExecutable = '') {
  const normalized = String(command || '').toLowerCase();
  const expectedName = expectedExecutable ? path.basename(expectedExecutable).toLowerCase() : '';
  return normalized.includes('codex') || Boolean(expectedName && normalized.includes(expectedName));
}

export async function terminateRecordedProcess(pid) {
  terminateProcessTree({ pid });
  const deadline = Date.now() + 1200;
  while (Date.now() < deadline) {
    if (!inspectLocalProcess(pid).alive) return true;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  terminateProcessTree({ pid }, { force:true });
  return !inspectLocalProcess(pid).alive;
}

export async function reconcileStartupState({
  database,
  inspectProcess = inspectLocalProcess,
  terminateProcess = terminateRecordedProcess,
  expectedExecutable = ''
}) {
  const report = {
    interrupted:0,
    requeued:0,
    orphanProcessesStopped:0,
    unrecognizedProcessesSkipped:0,
    repairedQueueEntries:0,
    details:[]
  };

  const runningRuns = database.prepare(`
    SELECT runs.id AS run_id, runs.task_id, runs.pid
    FROM runs WHERE runs.status = 'running' ORDER BY runs.started_at
  `).all();
  for (const run of runningRuns) {
    const processState = inspectProcess(Number(run.pid));
    if (!processState.alive) {
      report.details.push(`${run.task_id}: recorded process is no longer alive`);
      continue;
    }
    if (!looksLikeCodexProcess(processState.command, expectedExecutable)) {
      report.unrecognizedProcessesSkipped += 1;
      report.details.push(`${run.task_id}: PID ${run.pid} no longer looks like Codex and was not killed`);
      continue;
    }
    const stopped = await terminateProcess(Number(run.pid));
    if (stopped) report.orphanProcessesStopped += 1;
    report.details.push(`${run.task_id}: orphan PID ${run.pid} ${stopped ? 'stopped' : 'could not be stopped'}`);
  }

  database.exec('BEGIN IMMEDIATE;');
  try {
    const timestamp = now();
    const interruptedTaskIds = database.prepare(`
      SELECT DISTINCT task_id FROM runs WHERE status = 'running'
    `).all().map(row => row.task_id);
    const markRun = database.prepare(`
      UPDATE runs SET status = 'interrupted', finished_at = ?, error_message = ?
      WHERE task_id = ? AND status = 'running'
    `);
    const markTask = database.prepare(`
      UPDATE tasks SET status = 'interrupted', summary = ?, updated_at = ? WHERE id = ?
    `);
    const markSession = database.prepare(`
      UPDATE sessions SET state = 'stopped', updated_at = ? WHERE task_id = ?
    `);
    for (const taskId of interruptedTaskIds) {
      markRun.run(timestamp, '应用上次未正常退出，本轮运行已中断。', taskId);
      markTask.run('应用异常退出导致本轮中断；历史记录已保留，可以安全检查后重试。', timestamp, taskId);
      markSession.run(timestamp, taskId);
      database.prepare('DELETE FROM queue_entries WHERE task_id = ?').run(taskId);
      report.interrupted += 1;
    }

    const claimedWithoutRun = database.prepare(`
      SELECT queue_entries.task_id FROM queue_entries
      LEFT JOIN runs ON runs.task_id = queue_entries.task_id AND runs.status = 'running'
      WHERE queue_entries.lease_token IS NOT NULL AND runs.id IS NULL
      ORDER BY queue_entries.position
    `).all();
    for (const entry of claimedWithoutRun) {
      database.prepare(`
        UPDATE queue_entries SET lease_token = NULL, claimed_at = NULL WHERE task_id = ?
      `).run(entry.task_id);
      database.prepare(`
        UPDATE tasks SET status = 'queued', summary = ?, updated_at = ? WHERE id = ?
      `).run('应用重启后已恢复到等待队列。', timestamp, entry.task_id);
      report.requeued += 1;
      report.repairedQueueEntries += 1;
    }

    const orphanRunningTasks = database.prepare(`
      SELECT tasks.id FROM tasks
      LEFT JOIN runs ON runs.task_id = tasks.id AND runs.status = 'running'
      LEFT JOIN queue_entries ON queue_entries.task_id = tasks.id
      WHERE tasks.status = 'running' AND runs.id IS NULL AND queue_entries.task_id IS NULL
    `).all();
    for (const task of orphanRunningTasks) {
      markTask.run('应用状态不完整，本轮已标记中断；历史记录仍可查看和重试。', timestamp, task.id);
      markSession.run(timestamp, task.id);
      report.interrupted += 1;
    }

    database.prepare(`
      DELETE FROM queue_entries
      WHERE lease_token IS NULL AND task_id IN (
        SELECT id FROM tasks WHERE status IN ('done','failed','canceled','interrupted')
      )
    `).run();

    let nextPosition = Number(database.prepare('SELECT COALESCE(MAX(position), 0) AS value FROM queue_entries').get().value);
    const recoverableWithoutQueue = database.prepare(`
      SELECT id FROM tasks
      WHERE status IN ('draft','queued') AND id NOT IN (SELECT task_id FROM queue_entries)
      ORDER BY created_at, id
    `).all();
    const insertQueue = database.prepare(`
      INSERT INTO queue_entries (task_id, position, enqueued_at) VALUES (?, ?, ?)
    `);
    for (const task of recoverableWithoutQueue) {
      insertQueue.run(task.id, ++nextPosition, timestamp);
      database.prepare(`
        UPDATE tasks SET status = 'queued', summary = ?, updated_at = ? WHERE id = ?
      `).run('应用重启后已恢复到等待队列。', timestamp, task.id);
      report.requeued += 1;
      report.repairedQueueEntries += 1;
    }
    database.exec('COMMIT;');
  } catch (error) {
    database.exec('ROLLBACK;');
    throw error;
  }
  return report;
}
