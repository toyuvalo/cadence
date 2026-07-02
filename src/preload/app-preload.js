'use strict';

// Preload for Cadence's OWN windows (shell overlay, settings, mini-player).
// Exposes a minimal, audited surface over contextBridge — no Node in the page.

const { contextBridge, ipcRenderer } = require('electron');

const IPC = {
  GET_STATE: 'app:getState',
  GET_CONFIG: 'app:getConfig',
  SET_CONFIG: 'app:setConfig',
  CONFIG_CHANGED: 'app:configChanged',
  CONTROL: 'app:control',
  OPEN_SETTINGS: 'app:openSettings',
  TOGGLE_MINI: 'app:toggleMini',
  APP_INFO: 'app:info',
  SUPERVISOR_STATUS: 'app:supervisorStatus',
  STATE_PUSH: 'app:statePush',
};

contextBridge.exposeInMainWorld('cadence', {
  // queries
  getState: () => ipcRenderer.invoke(IPC.GET_STATE),
  getConfig: () => ipcRenderer.invoke(IPC.GET_CONFIG),
  getInfo: () => ipcRenderer.invoke(IPC.APP_INFO),

  // mutations
  setConfig: (patch) => ipcRenderer.invoke(IPC.SET_CONFIG, patch),
  control: (action, value) => ipcRenderer.send(IPC.CONTROL, { action, value }),
  openSettings: () => ipcRenderer.send(IPC.OPEN_SETTINGS),
  toggleMini: () => ipcRenderer.send(IPC.TOGGLE_MINI),
  retryNow: () => ipcRenderer.send(IPC.CONTROL, { action: '__retry__' }),

  // subscriptions
  onState: (cb) => {
    const h = (_e, s) => cb(s);
    ipcRenderer.on(IPC.STATE_PUSH, h);
    return () => ipcRenderer.removeListener(IPC.STATE_PUSH, h);
  },
  onConfigChanged: (cb) => {
    const h = (_e, c) => cb(c);
    ipcRenderer.on(IPC.CONFIG_CHANGED, h);
    return () => ipcRenderer.removeListener(IPC.CONFIG_CHANGED, h);
  },
  onSupervisorStatus: (cb) => {
    const h = (_e, s) => cb(s);
    ipcRenderer.on(IPC.SUPERVISOR_STATUS, h);
    return () => ipcRenderer.removeListener(IPC.SUPERVISOR_STATUS, h);
  },
});
