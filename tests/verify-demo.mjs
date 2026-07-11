import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
assert(scriptMatch, 'index.html 缺少内联脚本');
new Function(scriptMatch[1]);

const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map(match => match[1]);
assert(ids.length === new Set(ids).size, '页面存在重复 id');

const referencedIds = [...html.matchAll(/getElementById\(['"]([^'"]+)/g)].map(match => match[1]);
const missingIds = [...new Set(referencedIds)].filter(id => !ids.includes(id));
assert(missingIds.length === 0, `脚本引用了不存在的 id: ${missingIds.join(', ')}`);

const roadmap = [...html.matchAll(/\{ id:'(FE-\d+)'[\s\S]*?status:'(\w+)' \}/g)];
assert(roadmap.length === 11, `需求数量应为 11，实际为 ${roadmap.length}`);
assert(roadmap.every(match => match[2] === 'done'), '仍有需求未标记为 done');

assert(html.includes('AgentLinear/issues/${index + 1}'), '排期表缺少按顺序生成的 GitHub Issue 链接');

for (const token of ['MAX_CONCURRENT_TASKS = 6', 'queueOrder', 'transitionTask', 'recoveryPending', 'completionNotified', 'confirmModal']) {
  assert(html.includes(token), `缺少关键前端契约: ${token}`);
}

assert(readme.includes('FRONTEND_LOGIC.md'), 'README 缺少前端逻辑文档入口');
assert(readme.includes('FRONTEND_ACCEPTANCE.md'), 'README 缺少验收脚本入口');

console.log('AgentLinear Demo verification passed');
console.log(`- DOM ids: ${ids.length}`);
console.log(`- Roadmap items: ${roadmap.length}`);
console.log('- GitHub issues linked: 11');
