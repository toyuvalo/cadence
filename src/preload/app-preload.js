'use strict';

// Preload for Cadence's OWN windows (shell overlay, settings, mini-player).
// Exposes a minimal, audited surface over contextBridge — no Node in the page.

const { contextBridge, ipcRenderer } = require('electron');
const { LYRICS_DEFAULT_API, LYRICS_MIRROR_API } = require('../shared/constants');

const IPC = {
  GET_STATE: 'app:getState',
  GET_CONFIG: 'app:getConfig',
  SET_CONFIG: 'app:setConfig',
  CONFIG_CHANGED: 'app:configChanged',
  CONTROL: 'app:control',
  OPEN_SETTINGS: 'app:openSettings',
  TOGGLE_MINI: 'app:toggleMini',
  TOGGLE_LYRICS: 'app:toggleLyrics',
  APP_INFO: 'app:info',
  SUPERVISOR_STATUS: 'app:supervisorStatus',
  STATE_PUSH: 'app:statePush',
  GET_LYRICS: 'app:getLyrics',
  LYRICS_PUSH: 'app:lyricsPush',
  LYRICS_REFETCH: 'app:lyricsRefetch',
  UPDATE_STATUS: 'app:updateStatus',
  GET_UPDATE_STATUS: 'app:getUpdateStatus',
  CHECK_UPDATES: 'app:checkUpdates',
  INSTALL_UPDATE: 'app:installUpdate',
};

contextBridge.exposeInMainWorld('cadence', {
  // constants — so the lyrics/settings UIs never hardcode an endpoint that
  // could drift from the one the main process actually uses.
  lyricsEndpoints: Object.freeze({
    default: LYRICS_DEFAULT_API,
    mirror: LYRICS_MIRROR_API,
  }),

  // queries
  getState: () => ipcRenderer.invoke(IPC.GET_STATE),
  getConfig: () => ipcRenderer.invoke(IPC.GET_CONFIG),
  getInfo: () => ipcRenderer.invoke(IPC.APP_INFO),
  getLyrics: () => ipcRenderer.invoke(IPC.GET_LYRICS),
  getUpdateStatus: () => ipcRenderer.invoke(IPC.GET_UPDATE_STATUS),

  // mutations
  setConfig: (patch) => ipcRenderer.invoke(IPC.SET_CONFIG, patch),
  control: (action, value) => ipcRenderer.send(IPC.CONTROL, { action, value }),
  openSettings: () => ipcRenderer.send(IPC.OPEN_SETTINGS),
  toggleMini: () => ipcRenderer.send(IPC.TOGGLE_MINI),
  toggleLyrics: () => ipcRenderer.send(IPC.TOGGLE_LYRICS),
  // `query` is optional { title, artist } for a manual correction.
  refetchLyrics: (query) => ipcRenderer.send(IPC.LYRICS_REFETCH, query || null),
  retryNow: () => ipcRenderer.send(IPC.CONTROL, { action: '__retry__' }),
  checkUpdates: () => ipcRenderer.send(IPC.CHECK_UPDATES),
  installUpdate: () => ipcRenderer.send(IPC.INSTALL_UPDATE),

  // subscriptions
  onState: (cb) => {
    const h = (_e, s) => cb(s);
    ipcRenderer.on(IPC.STATE_PUSH, h);
    return () => ipcRenderer.removeListener(IPC.STATE_PUSH, h);
  },
  onLyrics: (cb) => {
    const h = (_e, l) => cb(l);
    ipcRenderer.on(IPC.LYRICS_PUSH, h);
    return () => ipcRenderer.removeListener(IPC.LYRICS_PUSH, h);
  },
  onUpdateStatus: (cb) => {
    const h = (_e, u) => cb(u);
    ipcRenderer.on(IPC.UPDATE_STATUS, h);
    return () => ipcRenderer.removeListener(IPC.UPDATE_STATUS, h);
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
