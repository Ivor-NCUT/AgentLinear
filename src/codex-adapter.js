/**
 * [INPUT]: A prompt, optional Codex Session ID, working directory and Codex CLI executable.
 * [OUTPUT]: Final answer, stable Session ID, usage, exit code and stderr diagnostics.
 * [POS]: Replaceable process adapter between AgentLinear and the local Codex runtime.
 * [PROTOCOL]: Consume only public `codex exec --json` JSONL events; never parse terminal prose.
 */

import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';

const MAX_STDERR_LENGTH = 256 * 1024;

export class CodexExecutionError extends Error {
  constructor(message, result, cause) {
    super(message, { cause });
    this.name = 'CodexExecutionError';
    this.result = result;
  }
}

function appendLimited(current, chunk) {
  const combined = current + chunk;
  return combined.length > MAX_STDERR_LENGTH ? combined.slice(-MAX_STDERR_LENGTH) : combined;
}

function buildArguments({ cwd, sessionId, attachments }) {
  const directories = [...new Set(attachments.map(file => path.dirname(file.path)))];
  const accessArguments = directories.flatMap(directory => ['--add-dir', directory]);
  const imageArguments = attachments.filter(file => file.mimeType?.startsWith('image/')).flatMap(file => ['-i', file.path]);
  if (sessionId) return [...accessArguments, 'exec', 'resume', '--json', ...imageArguments, sessionId, '-'];
  return [...accessArguments, 'exec', '-s', 'workspace-write', '-C', cwd, '--json', ...imageArguments, '-'];
}

function promptWithAttachments(prompt, attachments) {
  if (!attachments.length) return prompt;
  const manifest = attachments.map(file => ({ name:file.name, path:file.path, mimeType:file.mimeType }));
  return `${prompt}\n\n<agentlinear_attachments>\nThe user attached these local files. Read them from their absolute paths when relevant:\n${JSON.stringify(manifest, null, 2)}\n</agentlinear_attachments>`;
}

function killPosixProcessGroup(child, signal) {
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== 'ESRCH') {
      try { child.kill(signal); } catch { /* The process already exited. */ }
    }
  }
}

export function terminateProcessTree(child, { force = false } = {}) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide:true, stdio:'ignore' });
    return;
  }
  killPosixProcessGroup(child, force ? 'SIGKILL' : 'SIGTERM');
}

export class CodexAdapter {
  constructor({ spawnProcess = spawn } = {}) {
    this.spawnProcess = spawnProcess;
  }

  execute({
    executable = 'codex',
    cwd,
    prompt,
    sessionId = null,
    onEvent = () => {},
    onSpawn = () => {},
    signal = null,
    timeoutMs = 0,
    killGraceMs = 1500,
    attachments = []
  }) {
    if (!cwd || !prompt?.trim()) throw new Error('Codex 执行需要工作目录和指令。');
    const args = buildArguments({ cwd, sessionId, attachments });

    return new Promise((resolve, reject) => {
      const child = this.spawnProcess(executable, args, {
        cwd,
        env: process.env,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
        windowsHide: true
      });
      const state = {
        sessionId,
        finalOutput: '',
        usage: null,
        stderr: '',
        events: [],
        invalidLines: []
      };
      let stdoutBuffer = '';
      let settled = false;
      let termination = null;
      let timeout;
      let forceKillTimeout;

      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        if (forceKillTimeout) clearTimeout(forceKillTimeout);
        signal?.removeEventListener('abort', abortListener);
      };

      const requestStop = reason => {
        if (termination || settled) return;
        termination = typeof reason === 'object' && reason ? reason : { kind:'user', message:String(reason || '用户停止') };
        terminateProcessTree(child);
        forceKillTimeout = setTimeout(() => terminateProcessTree(child, { force:true }), killGraceMs);
        forceKillTimeout.unref?.();
      };
      const abortListener = () => requestStop(signal.reason);

      const consumeLine = line => {
        if (!line.trim()) return;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          state.invalidLines.push(line);
          return;
        }
        state.events.push(event);
        if (event.type === 'thread.started') state.sessionId = event.thread_id;
        if (event.type === 'item.completed' && event.item?.type === 'agent_message') state.finalOutput = event.item.text || '';
        if (event.type === 'turn.completed') state.usage = event.usage || null;
        onEvent(event);
      };

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', chunk => {
        stdoutBuffer += chunk;
        const lines = stdoutBuffer.split(/\r?\n/);
        stdoutBuffer = lines.pop() || '';
        lines.forEach(consumeLine);
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => { state.stderr = appendLimited(state.stderr, chunk); });

      child.once('error', error => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(new CodexExecutionError(`无法启动 Codex：${error.message}`, { ...state, exitCode: null }, error));
      });
      child.once('close', (exitCode, signal) => {
        if (settled) return;
        settled = true;
        cleanup();
        consumeLine(stdoutBuffer);
        const result = { ...state, exitCode, signal, pid:child.pid, termination };
        if (termination) {
          reject(new CodexExecutionError(termination.message || 'Codex 进程已停止。', result));
          return;
        }
        if (exitCode !== 0) {
          const detail = state.stderr.trim().split(/\r?\n/).at(-1) || `退出码 ${exitCode}`;
          reject(new CodexExecutionError(`Codex 执行失败：${detail}`, result));
          return;
        }
        if (!state.sessionId) {
          reject(new CodexExecutionError('Codex 没有返回 Session ID。', result));
          return;
        }
        if (!state.finalOutput) {
          reject(new CodexExecutionError('Codex 没有返回最终文本。', result));
          return;
        }
        resolve(result);
      });

      try {
        onSpawn(child.pid);
        if (signal?.aborted) requestStop(signal.reason);
        else signal?.addEventListener('abort', abortListener, { once:true });
        if (timeoutMs > 0) {
          timeout = setTimeout(() => requestStop({ kind:'timeout', message:`Codex 执行超过 ${timeoutMs}ms，已自动终止。` }), timeoutMs);
          timeout.unref?.();
        }
        child.stdin.end(promptWithAttachments(prompt, attachments));
      } catch (error) {
        requestStop({ kind:'internal', message:'Codex 启动初始化失败。' });
        terminateProcessTree(child, { force:true });
        if (!settled) {
          settled = true;
          cleanup();
          reject(new CodexExecutionError(error.message, { ...state, exitCode:null, pid:child.pid, termination }, error));
        }
      }
    });
  }
}
