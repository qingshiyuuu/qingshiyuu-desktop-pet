'use strict';

const { contextBridge, ipcRenderer } = require('electron');

const EVENTS = new Set([
  'pet:command',
  'pet:layout',
  'pet:settings',
  'pet:walk-blocked',
  'pet:airborne',
  'pet:landed',
  'pet:user-away',
  'pet:user-back',
  'pet:say'
]);

contextBridge.exposeInMainWorld('petApi', {
  init: () => ipcRenderer.invoke('pet:init'),
  showMenu: () => ipcRenderer.send('pet:menu'),
  setIgnoreMouse: (ignore) => ipcRenderer.send('pet:ignore-mouse', Boolean(ignore)),
  walk: (dir) => ipcRenderer.invoke('pet:walk', dir),
  stopWalk: () => ipcRenderer.send('pet:walk-stop'),
  dragStart: () => ipcRenderer.send('pet:drag-start'),
  dragEnd: () => ipcRenderer.send('pet:drag-end'),
  notifyState: (label) => ipcRenderer.send('pet:state', String(label)),
  chat: (text) => ipcRenderer.invoke('pet:chat', String(text)),
  focusWindow: () => ipcRenderer.send('pet:focus'),
  openSettings: () => ipcRenderer.send('pet:open-settings'),
  reportReady: () => ipcRenderer.invoke('pet:ready'),
  reportError: (message) => ipcRenderer.send('pet:error', String(message)),
  on: (channel, callback) => {
    if (!EVENTS.has(channel)) throw new Error(`Unknown channel ${channel}`);
    ipcRenderer.on(channel, (_event, payload) => callback(payload));
  }
});
