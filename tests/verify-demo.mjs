import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const mainProcess = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');
const preload = fs.readFileSync(path.join(root, 'src/preload.cjs'), 'utf8');
const scheduler = fs.readFileSync(path.join(root, 'src/scheduler.js'), 'utf8');
const codexAdapter = fs.readFileSync(path.join(root, 'src/codex-adapter.js'), 'utf8');
const recovery = fs.readFileSync(path.join(root, 'src/recovery.js'), 'utf8');

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

const roadmap = [...html.matchAll(/\{ id:'(BE-\d+)'[\s\S]*?status:'(\w+)' \}/g)];
assert(roadmap.length === 0, `剩余后端 MVP 需求数量应为 0，实际为 ${roadmap.length}`);
assert(roadmap.every(match => match[2] === 'confirm'), '剩余后端需求必须保持待开发状态');
assert(!html.includes("id:'FE-"), '需求排期仍包含已完成的前端需求');
assert(!html.includes("id:'BE-01'"), '已完成的 BE-01 仍出现在需求排期');
assert(!html.includes("id:'BE-02'"), '已完成的 BE-02 仍出现在需求排期');
assert(!html.includes("id:'BE-03'"), '已完成的 BE-03 仍出现在需求排期');
assert(!html.includes("id:'BE-04'"), '已完成的 BE-04 仍出现在需求排期');
assert(!html.includes("id:'BE-05'"), '已完成的 BE-05 仍出现在需求排期');
assert(!html.includes("id:'BE-06'"), '已完成的 BE-06 仍出现在需求排期');
assert(!html.includes("id:'BE-07'"), '已完成的 BE-07 仍出现在需求排期');
assert(!html.includes("id:'BE-08'"), '已完成的 BE-08 仍出现在需求排期');
assert(!html.includes("id:'BE-09'"), '已完成的 BE-09 仍出现在需求排期');
assert(!html.includes("id:'BE-10'"), '已完成的 BE-10 仍出现在需求排期');
assert(html.includes('本地后端 MVP 已全部完成'), '空排期缺少完成状态');

for (const token of ['Electron', 'Node.js', 'SQLite', '本地优先', '无云端服务']) {
  assert(html.includes(token), `后端排期缺少本地优先约束: ${token}`);
}

for (const token of ['MAX_CONCURRENT_TASKS = 6', 'queueOrder', 'transitionTask', 'recoveryPending', 'completionNotified', 'confirmModal']) {
  assert(html.includes(token), `缺少关键前端契约: ${token}`);
}

for (const token of ['height: 100dvh;', '.main { min-width: 0; min-height: 0; height: 100dvh;', 'overflow-y: auto;', '.view-panel, .schedule-view { height: auto; overflow: visible;', '.app { display: block; height: auto;']) {
  assert(html.includes(token), `需求排期缺少滚动高度约束: ${token}`);
}

assert(readme.includes('FRONTEND_LOGIC.md'), 'README 缺少前端逻辑文档入口');
assert(readme.includes('FRONTEND_ACCEPTANCE.md'), 'README 缺少验收脚本入口');

assert(packageJson.main === 'src/main.js', 'Electron 主进程入口错误');
assert(packageJson.scripts?.start === 'electron .', '缺少标准桌面启动命令');
assert(packageJson.scripts?.doctor === 'node scripts/doctor.mjs', '缺少本地自检命令');
assert(packageJson.license === 'MIT', '开源许可证声明错误');
for (const token of ['contextIsolation: true', 'nodeIntegration: false', 'sandbox: true']) {
  assert(mainProcess.includes(token), `Electron 安全边界缺少配置: ${token}`);
}
assert(preload.includes("runtime: 'electron'"), '预加载脚本缺少最小运行时标识');
assert(preload.includes("ipcRenderer.invoke('environment:check'"), '预加载脚本缺少环境预检接口');
assert(preload.includes("ipcRenderer.invoke('groups:list'"), '预加载脚本缺少分组服务接口');
assert(preload.includes("ipcRenderer.invoke('tasks:create'"), '预加载脚本缺少真实任务接口');
assert(preload.includes("ipcRenderer.invoke('tasks:create-todo'"), '预加载脚本缺少待办创建接口');
assert(preload.includes("ipcRenderer.invoke('tasks:complete-todo'"), '预加载脚本缺少待办完成接口');
assert(preload.includes("ipcRenderer.invoke('tasks:convert-todo'"), '预加载脚本缺少待办转 Codex 接口');
assert(preload.includes("ipcRenderer.invoke('tasks:followup'"), '预加载脚本缺少 Session 续聊接口');
assert(preload.includes("ipcRenderer.invoke('tasks:stop'"), '预加载脚本缺少进程停止接口');
assert(preload.includes("ipcRenderer.invoke('files:pick'"), '预加载脚本缺少本地附件选择接口');
assert(preload.includes("ipcRenderer.invoke('tasks:remove-attachment'"), '预加载脚本缺少失效附件移除接口');
assert(mainProcess.includes("ipcMain.handle('environment:check'"), '主进程缺少环境预检处理器');
assert(html.includes('id="environmentStatus"'), '界面缺少环境状态反馈');
assert(scheduler.includes('MAX_CONCURRENT_TASKS = 6'), '真实调度器缺少 6 并发硬限制');
assert(scheduler.includes('WHERE lease_token IS NULL ORDER BY position'), '真实调度器缺少持久 FIFO 领取规则');
assert(mainProcess.includes('taskService.stopAll'), '应用退出流程缺少运行进程清理');
assert(mainProcess.includes('reconcileStartupState'), '主进程启动前缺少状态对账');
assert(preload.includes("ipcRenderer.invoke('recovery:report'"), '预加载脚本缺少恢复报告接口');
assert(preload.includes("ipcRenderer.invoke('tasks:retry'"), '预加载脚本缺少中断任务重试接口');
assert(recovery.includes("status = 'interrupted'"), '启动恢复没有标记中断运行');
assert(recovery.includes('looksLikeCodexProcess'), '启动恢复缺少进程身份校验');
assert(recovery.includes('lease_token = NULL'), '启动恢复缺少持久队列租约修复');
assert(codexAdapter.includes("'features.code_mode_host=true','app-server','--stdio'"), 'Codex 适配器没有对齐桌面端 app-server 能力');
assert(codexAdapter.includes('CODEX_HOME:environment.CODEX_HOME'), 'Codex 适配器没有复用桌面端 CODEX_HOME');
assert(codexAdapter.includes("threadSource:'agentlinear'"), 'Codex app-server 线程缺少 AgentLinear 来源标识');
assert(codexAdapter.includes("type:'dangerFullAccess'"), 'Codex 适配器没有使用本机完整权限');
assert(codexAdapter.includes("type:'localImage'"), 'Codex app-server 没有传递本地图片输入');
assert(codexAdapter.includes('agentlinear_attachments'), 'Codex prompt 缺少附件清单');
assert(readme.includes('docs/ARCHITECTURE.md'), 'README 缺少架构文档入口');

console.log('AgentLinear Demo verification passed');
console.log(`- DOM ids: ${ids.length}`);
console.log(`- Backend roadmap items: ${roadmap.length}`);
console.log('- Backend roadmap: complete');
console.log('- Electron shell: configured');
