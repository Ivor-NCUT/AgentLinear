/**
 * [INPUT]: Electron contextBridge and read-only application metadata.
 * [OUTPUT]: A deliberately small window.agentLinear API for the renderer.
 * [POS]: Security boundary between the unprivileged UI and the desktop main process.
 * [PROTOCOL]: Add capabilities here only together with a validated main-process handler.
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('agentLinear', Object.freeze({
  runtime: 'electron',
  checkEnvironment: workspacePath => ipcRenderer.invoke('environment:check', workspacePath ?? null),
  getRecoveryReport: () => ipcRenderer.invoke('recovery:report'),
  pickFolder: () => ipcRenderer.invoke('folders:pick'),
  pickFiles: () => ipcRenderer.invoke('files:pick'),
  groups: Object.freeze({
    list: () => ipcRenderer.invoke('groups:list'),
    create: folderPath => ipcRenderer.invoke('groups:create', folderPath),
    update: input => ipcRenderer.invoke('groups:update', input),
    remove: id => ipcRenderer.invoke('groups:remove', id)
  }),
  tasks: Object.freeze({
    list: () => ipcRenderer.invoke('tasks:list'),
    get: id => ipcRenderer.invoke('tasks:get', id),
    create: input => ipcRenderer.invoke('tasks:create', input),
    createTodo: input => ipcRenderer.invoke('tasks:create-todo', input),
    completeTodo: id => ipcRenderer.invoke('tasks:complete-todo', id),
    convertTodo: id => ipcRenderer.invoke('tasks:convert-todo', id),
    followup: input => ipcRenderer.invoke('tasks:followup', input),
    stop: id => ipcRenderer.invoke('tasks:stop', id),
    retry: id => ipcRenderer.invoke('tasks:retry', id),
    removeAttachment: input => ipcRenderer.invoke('tasks:remove-attachment', input),
    onChanged: callback => {
      const listener = (_event, task) => callback(task);
      ipcRenderer.on('tasks:changed', listener);
      return () => ipcRenderer.removeListener('tasks:changed', listener);
    }
  })
}));
