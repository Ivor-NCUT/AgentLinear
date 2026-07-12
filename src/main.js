/**
 * [INPUT]: Electron lifecycle, BrowserWindow, shell and the local HTML renderer.
 * [OUTPUT]: A single secure AgentLinear desktop window.
 * [POS]: Desktop main process; owns OS capabilities and keeps them out of the renderer.
 * [PROTOCOL]: Update docs/ARCHITECTURE.md when the process boundary changes.
 */

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { DATABASE_FILENAME, openAgentLinearDatabase } from './database.js';
import { runEnvironmentPreflight } from './environment.js';
import { createGroupService } from './group-service.js';
import { CodexAdapter } from './codex-adapter.js';
import { createTaskService } from './task-service.js';
import { createPersistentScheduler } from './scheduler.js';
import { reconcileStartupState } from './recovery.js';

const currentDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(currentDirectory, '..');
let storage;
let dataDirectory;
let groupService;
let taskService;
let scheduler;
let shutdownStarted = false;
let resourcesClosed = false;
let startupRecoveryReport = null;

function ensureEnvironmentReady(workspacePath) {
  const result = runEnvironmentPreflight({ dataDirectory, workspacePath });
  if (!result.ok) {
    const failed = result.checks.find(check => check.status === 'error');
    throw new Error(`${failed.summary}：${failed.action}`);
  }
  return result;
}

function broadcastTaskChange(task) {
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send('tasks:changed', task);
}

function normalizeWorkspacePath(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string' || value.length > 4096) throw new Error('工作目录格式无效');
  return path.resolve(value);
}

function registerIpcHandlers() {
  ipcMain.handle('environment:check', (_event, workspacePath) => runEnvironmentPreflight({
    dataDirectory,
    workspacePath: normalizeWorkspacePath(workspacePath)
  }));
  ipcMain.handle('recovery:report', () => startupRecoveryReport);
  ipcMain.handle('folders:pick', async event => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(owner, {
      title: '选择本地项目文件夹',
      properties: ['openDirectory', 'createDirectory']
    });
    return result.canceled ? null : result.filePaths[0];
  });
  ipcMain.handle('files:pick', async event => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(owner, {
      title: '选择要交给 Codex 的本地文件',
      properties: ['openFile', 'multiSelections']
    });
    if (result.canceled) return [];
    return result.filePaths.map(filePath => {
      const canonical = fs.realpathSync(filePath);
      const stat = fs.statSync(canonical);
      return { path:canonical, name:path.basename(canonical), size:stat.size, lastModified:stat.mtimeMs };
    });
  });
  ipcMain.handle('groups:list', () => groupService.list());
  ipcMain.handle('groups:create', (_event, folderPath) => groupService.create(folderPath));
  ipcMain.handle('groups:update', (_event, input) => groupService.update({
    id: String(input?.id || ''),
    folderPath: input?.folderPath || null,
    name: input?.name || null
  }));
  ipcMain.handle('groups:remove', (_event, id) => groupService.remove(String(id || '')));
  ipcMain.handle('tasks:list', () => taskService.list());
  ipcMain.handle('tasks:get', (_event, id) => taskService.get(String(id || '')));
  ipcMain.handle('tasks:create', (_event, input) => taskService.create({
    groupId: String(input?.groupId || ''),
    title: input?.title,
    prompt: input?.prompt,
    attachmentPaths: Array.isArray(input?.attachmentPaths) ? input.attachmentPaths : []
  }));
  ipcMain.handle('tasks:create-todo', (_event, input) => taskService.createTodo({
    groupId: String(input?.groupId || ''),
    title: input?.title,
    description: input?.description
  }));
  ipcMain.handle('tasks:complete-todo', (_event, id) => taskService.completeTodo(String(id || '')));
  ipcMain.handle('tasks:convert-todo', (_event, id) => taskService.convertTodo(String(id || '')));
  ipcMain.handle('tasks:followup', (_event, input) => taskService.followup({
    taskId: String(input?.taskId || ''),
    prompt: input?.prompt,
    attachmentPaths: Array.isArray(input?.attachmentPaths) ? input.attachmentPaths : []
  }));
  ipcMain.handle('tasks:stop', (_event, id) => taskService.stop(String(id || '')));
  ipcMain.handle('tasks:retry', (_event, id) => taskService.retry(String(id || '')));
  ipcMain.handle('tasks:remove-attachment', (_event, input) => taskService.removeAttachment({
    taskId:String(input?.taskId || ''),
    attachmentId:String(input?.attachmentId || '')
  }));
}

function closeResources() {
  if (resourcesClosed) return;
  resourcesClosed = true;
  ipcMain.removeHandler('environment:check');
  for (const channel of ['recovery:report', 'folders:pick', 'files:pick', 'groups:list', 'groups:create', 'groups:update', 'groups:remove', 'tasks:list', 'tasks:get', 'tasks:create', 'tasks:create-todo', 'tasks:complete-todo', 'tasks:convert-todo', 'tasks:followup', 'tasks:stop', 'tasks:retry', 'tasks:remove-attachment']) {
    ipcMain.removeHandler(channel);
  }
  storage?.close();
  storage = undefined;
}

function isSafeExternalUrl(url) {
  try {
    return new URL(url).protocol === 'https:';
  } catch {
    return false;
  }
}

function createMainWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 960,
    minWidth: 900,
    minHeight: 640,
    show: false,
    title: 'AgentLinear',
    backgroundColor: '#f7f7f8',
    webPreferences: {
      preload: path.join(currentDirectory, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (isSafeExternalUrl(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault();
  });

  window.once('ready-to-show', () => window.show());
  void window.loadFile(path.join(projectRoot, 'index.html'));
}

app.whenReady().then(async () => {
  dataDirectory = app.getPath('userData');
  storage = await openAgentLinearDatabase({
    filePath: path.join(dataDirectory, DATABASE_FILENAME),
    backupDirectory: path.join(dataDirectory, 'backups')
  });
  const startupEnvironment = runEnvironmentPreflight({ dataDirectory });
  startupRecoveryReport = await reconcileStartupState({
    database:storage.database,
    expectedExecutable:startupEnvironment.codexExecutable || ''
  });
  groupService = createGroupService(storage.database);
  taskService = createTaskService({
    database: storage.database,
    adapter: new CodexAdapter(),
    ensureReady: ensureEnvironmentReady,
    onChanged: broadcastTaskChange,
    onError: error => console.error('[AgentLinear task]', error)
  });
  const sessionMigration = await taskService.migrateLegacySessions();
  startupRecoveryReport = {
    ...startupRecoveryReport,
    sessionsMigrated:sessionMigration.migrated,
    sessionMigrationFailures:sessionMigration.failures
  };
  scheduler = createPersistentScheduler({
    database: storage.database,
    executeTask: taskId => taskService.executeQueued(taskId),
    getTask: taskId => taskService.get(taskId),
    onChanged: broadcastTaskChange,
    onError: error => console.error('[AgentLinear scheduler]', error)
  });
  taskService.setScheduler(scheduler);
  scheduler.drain();
  registerIpcHandlers();
  createMainWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
  });
}).catch(error => {
  dialog.showErrorBox('AgentLinear 无法启动', error instanceof Error ? error.message : String(error));
  app.quit();
});

app.on('before-quit', event => {
  if (resourcesClosed) return;
  scheduler?.pause();
  if (!scheduler?.runningCount()) {
    closeResources();
    return;
  }
  if (shutdownStarted) return;

  event.preventDefault();
  shutdownStarted = true;
  taskService.stopAll({ kind:'shutdown', message:'AgentLinear 退出时已终止 Codex 进程。' });
  const fallback = new Promise(resolve => setTimeout(resolve, 4000));
  Promise.race([scheduler.waitForActive(), fallback]).finally(() => {
    closeResources();
    app.quit();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
