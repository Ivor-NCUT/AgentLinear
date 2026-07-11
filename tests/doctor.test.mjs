import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { formatDoctorReport, runDoctor } from '../scripts/doctor.mjs';

function readyPreflight() {
  return {
    checks:[
      { id:'node', status:'ok', summary:'Node.js 22.12.0', action:'' },
      { id:'codex-cli', status:'ok', summary:'codex-cli 1.0.0', action:'' },
      { id:'codex-auth', status:'ok', summary:'Logged in', action:'' }
    ]
  };
}

test('reports a local-only ready clone without exposing its path', () => {
  const report = runDoctor({ preflight:readyPreflight, platform:'darwin' });
  const output = formatDoctorReport(report);
  assert.equal(report.ok, true);
  assert.equal(report.localOnly, true);
  assert.match(output, /不会上传/);
  assert.doesNotMatch(output, new RegExp(os.homedir().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('returns actionable failures for unsupported systems and incomplete clones', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agentlinear-doctor-test-'));
  try {
    const report = runDoctor({ root, platform:'linux', preflight:readyPreflight });
    assert.equal(report.ok, false);
    assert.match(report.checks.find(check => check.id === 'platform').action, /macOS/);
    assert.match(report.checks.find(check => check.id === 'project').action, /重新克隆/);
  } finally {
    fs.rmSync(root, { recursive:true, force:true });
  }
});
