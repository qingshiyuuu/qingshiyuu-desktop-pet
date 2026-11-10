'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('settingsApi', {
  get: () => ipcRenderer.invoke('settings:get'),
  save: (patch) => ipcRenderer.invoke('settings:save', patch),
  test: () => ipcRenderer.invoke('settings:test'),
  clearMemory: () => ipcRenderer.invoke('settings:clear-memory'),
  clearHistory: () => ipcRenderer.invoke('settings:clear-history'),
  openKeyPage: () => ipcRenderer.send('settings:open-link', 'https://platform.deepseek.com/api_keys')
});
