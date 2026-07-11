import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runEnvironmentPreflight } from '../src/environment.js';

function commandResult(status, stdout = '', stderr = '', error = undefined) {
  return { status, stdout, stderr, error };
}

test('reports a ready local Codex environment', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlinear-env-'));
  const runCommand = (_command, args) => args[0] === '--version'
    ? commandResult(0, 'codex-cli 1.2.3\n')
    : commandResult(0, 'Logged in using ChatGPT\n');
  try {
    const result = runEnvironmentPreflight({ dataDirectory: root, workspacePath: root, runCommand, nodeVersion: 'v22.12.0' });
    assert.equal(result.ok, true);
    assert.equal(result.codexExecutable, 'codex');
    assert.equal(result.checks.length, 5);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('returns actionable failures for missing Codex and invalid workspace', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlinear-env-'));
  const runCommand = () => commandResult(null, '', '', Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  try {
    const result = runEnvironmentPreflight({
      dataDirectory: root,
      workspacePath: path.join(root, 'missing'),
      runCommand,
      nodeVersion: 'v22.12.0'
    });
    assert.equal(result.ok, false);
    assert.match(result.checks.find(check => check.id === 'workspace').action, /文件夹/);
    assert.match(result.checks.find(check => check.id === 'codex-cli').action, /AGENTLINEAR_CODEX_PATH/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('detects an unauthenticated Codex CLI', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlinear-env-'));
  const runCommand = (_command, args) => args[0] === '--version'
    ? commandResult(0, 'codex-cli 1.2.3\n')
    : commandResult(1, '', 'Not logged in');
  try {
    const result = runEnvironmentPreflight({ dataDirectory: root, runCommand, nodeVersion: 'v23.0.0' });
    const auth = result.checks.find(check => check.id === 'codex-auth');
    assert.equal(result.ok, false);
    assert.match(auth.action, /codex login/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('rejects unsupported Node.js versions', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlinear-env-'));
  const runCommand = (_command, args) => args[0] === '--version'
    ? commandResult(0, 'codex-cli 1.2.3\n')
    : commandResult(0, 'Logged in');
  try {
    const result = runEnvironmentPreflight({ dataDirectory: root, runCommand, nodeVersion: 'v20.11.0' });
    assert.equal(result.ok, false);
    assert.match(result.checks.find(check => check.id === 'node').action, /升级 Node.js/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('gives an explicit Codex path priority over PATH discovery', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlinear-env-'));
  const configured = path.join(root, 'custom-codex');
  fs.writeFileSync(configured, '#!/bin/sh\n');
  fs.chmodSync(configured, 0o755);
  const commands = [];
  const runCommand = (command, args) => {
    commands.push(command);
    return args[0] === '--version' ? commandResult(0, 'codex-cli custom\n') : commandResult(0, 'Logged in');
  };
  try {
    const result = runEnvironmentPreflight({ dataDirectory:root, runCommand, configuredCodexPath:configured });
    assert.equal(result.ok, true);
    assert.equal(result.codexExecutable, configured);
    assert.equal(commands.includes('codex'), false);
  } finally {
    fs.rmSync(root, { recursive:true, force:true });
  }
});
