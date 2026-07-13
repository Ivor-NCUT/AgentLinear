/**
 * [INPUT]: Local runtime paths, filesystem access and the installed Codex CLI.
 * [OUTPUT]: Structured readiness checks with actionable recovery guidance.
 * [POS]: Main-process preflight service used before any real Codex run starts.
 * [PROTOCOL]: Keep checks side-effect free except for creating the app data directory.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const MINIMUM_NODE_VERSION = [22, 16, 0];

function success(id, summary, detail = '') {
  return { id, status: 'ok', summary, detail, action: '' };
}

function failure(id, summary, detail, action) {
  return { id, status: 'error', summary, detail, action };
}

function firstLine(value) {
  return String(value || '').trim().split(/\r?\n/, 1)[0];
}

function versionAtLeast(current, minimum) {
  const currentParts = current.replace(/^v/, '').split('.').map(Number);
  for (let index = 0; index < minimum.length; index += 1) {
    const value = currentParts[index] || 0;
    if (value > minimum[index]) return true;
    if (value < minimum[index]) return false;
  }
  return true;
}

function executableCandidates(platform = process.platform) {
  const home = os.homedir();
  const candidates = [];
  if (platform === 'darwin') {
    candidates.push(
      '/Applications/ChatGPT.app/Contents/Resources/codex',
      path.join(home, 'Applications/ChatGPT.app/Contents/Resources/codex'),
      '/opt/homebrew/bin/codex',
      '/usr/local/bin/codex',
      path.join(home, '.local/bin/codex')
    );
  } else if (platform === 'win32') {
    candidates.push(
      path.join(process.env.LOCALAPPDATA || '', 'Programs', 'codex', 'codex.exe'),
      path.join(process.env.APPDATA || '', 'npm', 'codex.cmd')
    );
  } else {
    candidates.push('/usr/local/bin/codex', '/usr/bin/codex', path.join(home, '.local/bin/codex'));
  }
  return candidates.filter(Boolean);
}

function locateCodex(runCommand, configuredCodexPath, candidates = executableCandidates()) {
  if (configuredCodexPath) {
    try {
      fs.accessSync(configuredCodexPath, fs.constants.X_OK);
      const configuredProbe = runCommand(configuredCodexPath, ['--version'], { encoding:'utf8', timeout:5000 });
      if (!configuredProbe.error && configuredProbe.status === 0) return { executable:configuredCodexPath, probe:configuredProbe };
      return { executable:null, probe:configuredProbe };
    } catch (error) {
      return { executable:null, probe:{ status:null, stdout:'', stderr:'', error } };
    }
  }
  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      const probe = runCommand(candidate, ['--version'], { encoding: 'utf8', timeout: 5000 });
      if (!probe.error && probe.status === 0) return { executable: candidate, probe };
    } catch {
      // Continue through known local installation paths.
    }
  }
  const pathProbe = runCommand('codex', ['--version'], { encoding: 'utf8', timeout: 5000 });
  if (!pathProbe.error && pathProbe.status === 0) return { executable: 'codex', probe: pathProbe };
  return { executable: null, probe: pathProbe };
}

function checkDirectory(id, directory, create) {
  try {
    if (create) fs.mkdirSync(directory, { recursive: true });
    const stat = fs.statSync(directory);
    if (!stat.isDirectory()) throw new Error('路径不是文件夹');
    fs.accessSync(directory, fs.constants.R_OK | fs.constants.W_OK);
    return success(id, `${directory} 可读写`);
  } catch (error) {
    return failure(
      id,
      `${directory} 不可用`,
      error instanceof Error ? error.message : String(error),
      '请选择存在且拥有读写权限的本地文件夹。'
    );
  }
}

export function runEnvironmentPreflight({
  dataDirectory,
  workspacePath = null,
  runCommand = spawnSync,
  nodeVersion = process.version,
  configuredCodexPath = process.env.AGENTLINEAR_CODEX_PATH || process.env.CODEX_PATH,
  candidateExecutables = executableCandidates()
}) {
  const checks = [];
  checks.push(versionAtLeast(nodeVersion, MINIMUM_NODE_VERSION)
    ? success('node', `Node.js ${nodeVersion.replace(/^v/, '')}`)
    : failure('node', `Node.js ${nodeVersion.replace(/^v/, '')} 版本过低`, 'AgentLinear 需要 Node.js 22.16 或更高版本。', '升级 Node.js 后重新启动 AgentLinear。'));

  checks.push(checkDirectory('data-directory', dataDirectory, true));
  if (workspacePath) checks.push(checkDirectory('workspace', workspacePath, false));

  const located = locateCodex(runCommand, configuredCodexPath, candidateExecutables);
  if (!located.executable) {
    checks.push(failure(
      'codex-cli',
      '未找到 Codex CLI',
      firstLine(located.probe.error?.message || located.probe.stderr),
      '安装并登录 Codex CLI，或通过 AGENTLINEAR_CODEX_PATH 指定可执行文件。'
    ));
  } else {
    checks.push(success('codex-cli', firstLine(located.probe.stdout), located.executable));
    const appServer = runCommand(located.executable, ['app-server', '--help'], { encoding:'utf8', timeout:5000 });
    if (!appServer.error && appServer.status === 0) {
      checks.push(success('codex-app-server', 'Codex app-server 协议可用', '会话可被交互客户端识别'));
    } else {
      checks.push(failure(
        'codex-app-server',
        '当前 Codex CLI 不支持 app-server',
        firstLine(appServer.error?.message || appServer.stderr || appServer.stdout),
        '升级 Codex CLI 后重新运行环境检查。'
      ));
    }
    const auth = runCommand(located.executable, ['login', 'status'], { encoding: 'utf8', timeout: 8000 });
    if (!auth.error && auth.status === 0) {
      checks.push(success('codex-auth', firstLine(auth.stdout || auth.stderr), '复用本机 Codex 登录状态'));
    } else {
      checks.push(failure(
        'codex-auth',
        'Codex CLI 尚未登录',
        firstLine(auth.error?.message || auth.stderr || auth.stdout),
        '在终端运行 `codex login`，完成后回到 AgentLinear 重新检查。'
      ));
    }
  }

  return {
    ok: checks.every(check => check.status === 'ok'),
    checkedAt: new Date().toISOString(),
    codexExecutable: located.executable,
    checks
  };
}
