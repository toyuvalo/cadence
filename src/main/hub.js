'use strict';

const { ipcMain } = require('electron');
const { EventEmitter } = require('events');
const config = require('./config');
const { diag } = require('../shared/diag');

// Channel literals kept in lockstep with app-preload.js / ytm-preload.js.
const CH = {
  // bridge -> main
  STATE: 'ytm:state',
  READY: 'ytm:ready',
  LOG: 'ytm:log',
  // main -> bridge
  COMMAND: 'ytm:command',
  // our UI <-> main
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

const EMPTY_STATE = {
  hasSong: false,
  title: '',
  artist: '',
  album: '',
  artworkUrl: '',
  isPaused: true,
  currentTime: 0,
  duration: 0,
  volume: config.get('state.volume', 60),
  muted: false,
  liked: 'INDIFFERENT',
  videoId: '',
  adShowing: false,
  ts: 0,
};

// Central nervous system: holds latest player state, fans it out to every
// consumer (tray, mini-player, settings, integrations), and routes UI/key
// commands back into the music bridge.
class Hub extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(40);
    this.latest = { ...EMPTY_STATE };
    this._getYtmWC = null;
    this._supervisor = null;
    this._uiWindows = new Set(); // BrowserWindow refs hosting our own pages
    this._lastStatus = { status: 'starting', detail: '' };
    this._onOpenSettings = () => {};
    this._onToggleMini = () => {};
  }

  setRefs({ getYtmWebContents, supervisor, onOpenSettings, onToggleMini }) {
    if (getYtmWebContents) this._getYtmWC = getYtmWebContents;
    if (supervisor) this._supervisor = supervisor;
    if (onOpenSettings) this._onOpenSettings = onOpenSettings;
    if (onToggleMini) this._onToggleMini = onToggleMini;
  }

  registerUI(win) {
    this._uiWindows.add(win);
    win.on('closed', () => this._uiWindows.delete(win));
    // Prime the new window with current data.
    if (!win.webContents.isDestroyed()) {
      win.webContents.send(CH.STATE_PUSH, this.latest);
      win.webContents.send(CH.SUPERVISOR_STATUS, this._lastStatus);
    }
  }

  sendCommand(action, value) {
    if (action === '__retry__') {
      if (this._supervisor) this._supervisor.forceReload();
      return;
    }
    const wc = this._getYtmWC && this._getYtmWC();
    diag(`hub.sendCommand ${action} -> wc=${wc ? (wc.isDestroyed() ? 'destroyed' : 'ok#' + wc.id) : 'null'}`);
    if (!wc || wc.isDestroyed()) return;

    // Browser-style history navigation for the toolbar back/forward buttons.
    if (action === 'back' || action === 'forward') {
      const nav = wc.navigationHistory;
      if (!nav) return;
      if (action === 'back' && nav.canGoBack()) nav.goBack();
      if (action === 'forward' && nav.canGoForward()) nav.goForward();
      return;
    }

    wc.send(CH.COMMAND, { action, value });
  }

  _broadcast(channel, payload) {
    for (const win of this._uiWindows) {
      if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.send(channel, payload);
      }
    }
  }

  pushSupervisorStatus(status, detail) {
    this._lastStatus = { status, detail: detail || '' };
    this._broadcast(CH.SUPERVISOR_STATUS, this._lastStatus);
    this.emit('status', this._lastStatus);
  }

  _ingestState(state) {
    const prev = this.latest;
    this.latest = state;
    if (this._supervisor) this._supervisor.noteAlive();
    // Persist volume + last url-ish bits opportunistically.
    if (typeof state.volume === 'number' && state.volume !== prev.volume) {
      config.set('state.volume', state.volume);
    }
    this._broadcast(CH.STATE_PUSH, state);
    this.emit('state', state, prev);
  }

  wire() {
    ipcMain.on(CH.STATE, (_e, state) => this._ingestState(state));

    ipcMain.on(CH.READY, (_e, info) => {
      this.emit('bridge-ready', info);
      this.pushSupervisorStatus('ok');
    });

    ipcMain.on(CH.LOG, (_e, line) => {
      // eslint-disable-next-line no-console
      console.log('[bridge]', line);
    });

    ipcMain.handle(CH.GET_STATE, () => this.latest);
    ipcMain.handle(CH.GET_CONFIG, () => config.all());
    ipcMain.handle(CH.APP_INFO, () => {
      const { APP_NAME, APP_VERSION } = require('../shared/constants');
      return {
        name: APP_NAME,
        version: APP_VERSION,
        electron: process.versions.electron,
        chrome: process.versions.chrome,
        node: process.versions.node,
      };
    });
    ipcMain.handle(CH.SET_CONFIG, (_e, patch) => {
      const next = config.set(patch);
      this._broadcast(CH.CONFIG_CHANGED, next);
      this.emit('config', next);
      return next;
    });

    ipcMain.on(CH.CONTROL, (_e, { action, value }) => this.sendCommand(action, value));
    ipcMain.on(CH.OPEN_SETTINGS, () => this._onOpenSettings());
    ipcMain.on(CH.TOGGLE_MINI, () => this._onToggleMini());
  }
}

module.exports = { hub: new Hub(), CH };
