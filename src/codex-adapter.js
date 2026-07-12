/**
 * [INPUT]: A prompt, optional Codex Session ID, working directory and Codex CLI executable.
 * [OUTPUT]: Final answer, stable Session ID, usage, exit code and stderr diagnostics.
 * [POS]: App-server JSON-RPC adapter between AgentLinear and the local Codex runtime.
 * [PROTOCOL]: Use the public Codex app-server lifecycle so sessions remain interactive-client visible.
 */

import { spawn, spawnSync } from 'node:child_process';

const MAX_STDERR_LENGTH = 256 * 1024;
const CLIENT_INFO = { name:'agentlinear', title:'AgentLinear', version:'0.1.0' };

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

function promptWithAttachments(prompt, attachments) {
  if (!attachments.length) return prompt;
  const manifest = attachments.map(file => ({ name:file.name, path:file.path, mimeType:file.mimeType }));
  return `${prompt}\n\n<agentlinear_attachments>\nThe user attached these local files. Read them from their absolute paths when relevant:\n${JSON.stringify(manifest, null, 2)}\n</agentlinear_attachments>`;
}

export function buildAppServerTurn({ cwd, prompt, attachments = [] }) {
  const input = [{ type:'text', text:promptWithAttachments(prompt, attachments) }];
  for (const file of attachments) {
    if (file.mimeType?.startsWith('image/')) input.push({ type:'localImage', path:file.path });
  }
  return {
    input,
    cwd,
    approvalPolicy:'never',
    sandboxPolicy:{ type:'dangerFullAccess' }
  };
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
    threadName = '',
    sessionId = null,
    prepareOnly = false,
    onEvent = () => {},
    onSpawn = () => {},
    signal = null,
    timeoutMs = 0,
    killGraceMs = 1500,
    attachments = []
  }) {
    if (!cwd || (!prepareOnly && !prompt?.trim())) throw new Error('Codex 执行需要工作目录和指令。');

    return new Promise((resolve, reject) => {
      const child = this.spawnProcess(executable, ['app-server', '--stdio'], {
        cwd,
        env:process.env,
        stdio:['pipe', 'pipe', 'pipe'],
        detached:process.platform !== 'win32',
        windowsHide:true
      });
      const state = {
        sessionId,
        migratedFromSessionId:null,
        turnId:null,
        finalOutput:'',
        usage:null,
        stderr:'',
        events:[],
        invalidLines:[]
      };
      const requests = new Map();
      let requestId = 0;
      let stdoutBuffer = '';
      let settled = false;
      let turnSettled = false;
      let termination = null;
      let timeout;
      let forceKillTimeout;

      const cleanup = () => {
        if (timeout) clearTimeout(timeout);
        if (forceKillTimeout) clearTimeout(forceKillTimeout);
        signal?.removeEventListener('abort', abortListener);
      };

      const send = message => child.stdin.write(`${JSON.stringify(message)}\n`);
      const notify = (method, params = {}) => send({ method, params });
      const request = (method, params = {}) => new Promise((requestResolve, requestReject) => {
        const id = ++requestId;
        requests.set(id, { resolve:requestResolve, reject:requestReject, method });
        send({ method, id, params });
      });

      const finishTransport = () => {
        if (!child.stdin.destroyed) child.stdin.end();
      };

      const requestStop = reason => {
        if (termination || settled) return;
        termination = typeof reason === 'object' && reason ? reason : { kind:'user', message:String(reason || '用户停止') };
        if (state.sessionId && state.turnId && !child.stdin.destroyed) {
          void request('turn/interrupt', { threadId:state.sessionId, turnId:state.turnId }).catch(() => {});
        }
        terminateProcessTree(child);
        forceKillTimeout = setTimeout(() => terminateProcessTree(child, { force:true }), killGraceMs);
        forceKillTimeout.unref?.();
      };
      const abortListener = () => requestStop(signal.reason);

      const failProtocol = error => {
        if (settled) return;
        const failure = error instanceof Error ? error : new Error(String(error));
        requestStop({ kind:'internal', message:failure.message });
      };

      const handleNotification = message => {
        state.events.push(message);
        if (message.method === 'thread/started' && message.params?.thread?.id) {
          state.sessionId = message.params.thread.id;
          onEvent({ type:'thread.started', thread_id:state.sessionId, raw:message });
        }
        if (message.method === 'turn/started' && message.params?.turn?.id) state.turnId = message.params.turn.id;
        if (message.method === 'item/completed' && message.params?.item?.type === 'agentMessage') {
          state.finalOutput = message.params.item.text || '';
        }
        if (message.method === 'thread/tokenUsage/updated') state.usage = message.params?.tokenUsage || null;
        if (message.method === 'turn/completed') {
          turnSettled = true;
          const turn = message.params?.turn;
          if (turn?.id) state.turnId = turn.id;
          if (!state.finalOutput) {
            const finalMessage = [...(turn?.items || [])].reverse().find(item => item.type === 'agentMessage');
            state.finalOutput = finalMessage?.text || '';
          }
          if (turn?.status !== 'completed') {
            const detail = turn?.error?.message || `Codex turn 状态为 ${turn?.status || 'unknown'}`;
            failProtocol(new Error(detail));
            return;
          }
          finishTransport();
        }
        onEvent(message);
      };

      const consumeLine = line => {
        if (!line.trim()) return;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          state.invalidLines.push(line);
          return;
        }
        if (message.id !== undefined && requests.has(message.id)) {
          const pending = requests.get(message.id);
          requests.delete(message.id);
          if (message.error) pending.reject(new Error(`${pending.method}：${message.error.message || '请求失败'}`));
          else pending.resolve(message.result);
          return;
        }
        if (message.method) handleNotification(message);
      };

      async function startTurn() {
        try {
          await request('initialize', { clientInfo:CLIENT_INFO });
          notify('initialized');
          let threadResult = sessionId
            ? await request('thread/resume', {
                threadId:sessionId,
                cwd,
                approvalPolicy:'never',
                sandbox:'danger-full-access'
              })
            : await request('thread/start', {
                cwd,
                approvalPolicy:'never',
                sandbox:'danger-full-access',
                threadSource:'agentlinear'
              });
          let shouldNameThread = !sessionId;
          if (sessionId && threadResult?.thread?.source === 'exec') {
            state.migratedFromSessionId = sessionId;
            threadResult = await request('thread/fork', {
              threadId:sessionId,
              cwd,
              approvalPolicy:'never',
              sandbox:'danger-full-access',
              threadSource:'agentlinear'
            });
            shouldNameThread = true;
          }
          state.sessionId = threadResult?.thread?.id || sessionId;
          if (!state.sessionId) throw new Error('Codex app-server 没有返回 Session ID。');
          onEvent({ type:'thread.started', thread_id:state.sessionId, raw:threadResult });
          if (shouldNameThread && threadName.trim()) {
            await request('thread/name/set', { threadId:state.sessionId, name:threadName.trim() });
          }
          if (prepareOnly) {
            finishTransport();
            return;
          }
          const turnResult = await request('turn/start', {
            threadId:state.sessionId,
            ...buildAppServerTurn({ cwd, prompt, attachments })
          });
          state.turnId = turnResult?.turn?.id || state.turnId;
        } catch (error) {
          failProtocol(error);
        }
      }

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
        reject(new CodexExecutionError(`无法启动 Codex app-server：${error.message}`, { ...state, exitCode:null }, error));
      });
      child.once('close', (exitCode, closeSignal) => {
        if (settled) return;
        settled = true;
        cleanup();
        consumeLine(stdoutBuffer);
        for (const pending of requests.values()) pending.reject(new Error('Codex app-server 已关闭。'));
        requests.clear();
        const result = { ...state, exitCode, signal:closeSignal, pid:child.pid, termination };
        if (termination) {
          reject(new CodexExecutionError(termination.message || 'Codex 进程已停止。', result));
          return;
        }
        if (exitCode !== 0) {
          const detail = state.stderr.trim().split(/\r?\n/).at(-1) || `退出码 ${exitCode}`;
          reject(new CodexExecutionError(`Codex app-server 执行失败：${detail}`, result));
          return;
        }
        if (!prepareOnly && !turnSettled) {
          reject(new CodexExecutionError('Codex app-server 在 turn 完成前退出。', result));
          return;
        }
        if (!state.sessionId) {
          reject(new CodexExecutionError('Codex 没有返回 Session ID。', result));
          return;
        }
        if (!prepareOnly && !state.finalOutput) {
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
        void startTurn();
      } catch (error) {
        requestStop({ kind:'internal', message:'Codex app-server 启动初始化失败。' });
        terminateProcessTree(child, { force:true });
        if (!settled) {
          settled = true;
          cleanup();
          reject(new CodexExecutionError(error.message, { ...state, exitCode:null, pid:child.pid, termination }, error));
        }
      }
    });
  }

  prepareSession(input) {
    return this.execute({ ...input, prompt:'', prepareOnly:true, timeoutMs:input.timeoutMs || 30_000 });
  }
}
