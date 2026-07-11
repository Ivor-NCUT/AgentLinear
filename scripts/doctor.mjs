#!/usr/bin/env node

/**
 * [INPUT]: The local Node.js runtime, repository files and Codex CLI state.
 * [OUTPUT]: A human-readable, offline readiness report and a meaningful exit code.
 * [POS]: Clone-to-use diagnostic entry point; it never uploads project or user data.
 * [PROTOCOL]: Keep this command safe to run before Electron starts.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runEnvironmentPreflight } from '../src/environment.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDirectory, '..');

function result(id, ok, summary, action = '') {
  return { id, status:ok ? 'ok' : 'error', summary, action };
}

function checkProjectFiles(root) {
  const required = ['package.json', 'package-lock.json', 'index.html', 'src/main.js', 'src/preload.cjs'];
  const missing = required.filter(relativePath => !fs.existsSync(path.join(root, relativePath)));
  return missing.length
    ? result('project', false, `项目文件不完整：缺少 ${missing.join('、')}`, '重新克隆仓库后再运行 npm ci。')
    : result('project', true, '项目文件完整');
}

function checkDependencies(root) {
  try {
    const manifestPath = path.join(root, 'node_modules', 'electron', 'package.json');
    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    return result('dependencies', Boolean(manifest.version), `Electron ${manifest.version} 已安装`);
  } catch {
    return result('dependencies', false, '尚未安装 Electron 依赖', '在仓库目录运行 npm ci。');
  }
}

export function runDoctor({
  root = projectRoot,
  platform = process.platform,
  dataDirectory = null,
  preflight = runEnvironmentPreflight
} = {}) {
  const temporaryDirectory = dataDirectory || fs.mkdtempSync(path.join(os.tmpdir(), 'agentlinear-doctor-'));
  try {
    const checks = [
      result('platform', platform === 'darwin', platform === 'darwin' ? 'macOS 平台受支持' : `当前平台 ${platform} 尚未进入 MVP 支持范围`, '请在 macOS 上运行当前 MVP。'),
      checkProjectFiles(root),
      checkDependencies(root)
    ];
    const environment = preflight({ dataDirectory:temporaryDirectory });
    checks.push(...environment.checks.filter(check => ['node', 'codex-cli', 'codex-app-server', 'codex-auth'].includes(check.id)));
    return {
      ok:checks.every(check => check.status === 'ok'),
      localOnly:true,
      checkedAt:new Date().toISOString(),
      checks
    };
  } finally {
    if (!dataDirectory) fs.rmSync(temporaryDirectory, { recursive:true, force:true });
  }
}

export function formatDoctorReport(report) {
  const lines = [
    'AgentLinear 本地环境自检',
    '不会上传代码、文件路径、登录信息或诊断结果。',
    ''
  ];
  for (const check of report.checks) {
    lines.push(`${check.status === 'ok' ? '✓' : '✗'} ${check.summary}`);
    if (check.status !== 'ok' && check.action) lines.push(`  处理：${check.action}`);
  }
  lines.push('', report.ok ? '自检通过，可以运行 npm start。' : '自检未通过，请处理上面的项目后重试。');
  return lines.join('\n');
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  const report = runDoctor();
  console.log(formatDoctorReport(report));
  process.exitCode = report.ok ? 0 : 1;
}
