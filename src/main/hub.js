'use strict';

const { ipcMain } = require('electron');
const { EventEmitter } = require('events');
const config = require('./config');
const { EMPTY_LYRICS, EMPTY_UPDATE } = require('../shared/constants');
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
    this.latestLyrics = { ...EMPTY_LYRICS };
    this._getYtmWC = null;
    this._supervisor = null;
    this._uiWindows = new Set(); // BrowserWindow refs hosting our own pages
    this._lastStatus = { status: 'starting', detail: '' };
    this._onOpenSettings = () => {};
    this._onToggleMini = () => {};
    this._onToggleLyrics = () => {};
    this._onLyricsRefetch = () => {};
    this._update = { onCheck: () => {}, onInstall: () => false, getState: () => ({ ...EMPTY_UPDATE }) };
  }

  setUpdateHandlers(handlers) {
    this._update = { ...this._update, ...handlers };
  }

  setRefs({ getYtmWebContents, supervisor, onOpenSettings, onToggleMini, onToggleLyrics }) {
    if (getYtmWebContents) this._getYtmWC = getYtmWebContents;
    if (supervisor) this._supervisor = supervisor;
    if (onOpenSettings) this._onOpenSettings = onOpenSettings;
    if (onToggleMini) this._onToggleMini = onToggleMini;
    if (onToggleLyrics) this._onToggleLyrics = onToggleLyrics;
  }

  registerUI(win) {
    this._uiWindows.add(win);
    win.on('closed', () => this._uiWindows.delete(win));
    // Prime the new window with current data.
    if (!win.webContents.isDestroyed()) {
      win.webContents.send(CH.STATE_PUSH, this.latest);
      win.webContents.send(CH.SUPERVISOR_STATUS, this._lastStatus);
      win.webContents.send(CH.LYRICS_PUSH, this.latestLyrics);
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

  // Fan out a new LyricsState (produced by integrations/lyrics.js) to every one
  // of our windows, and remember it so a window opened later is primed with it.
  pushLyrics(payload) {
    this.latestLyrics = payload;
    this._broadcast(CH.LYRICS_PUSH, payload);
    this.emit('lyrics', payload);
  }

  // Fan out updater progress (checking / downloading / ready) to our windows.
  pushUpdateStatus(payload) {
    this._broadcast(CH.UPDATE_STATUS, payload);
    this.emit('update', payload);
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
    ipcMain.handle(CH.GET_LYRICS, () => this.latestLyrics);
    ipcMain.handle(CH.GET_UPDATE_STATUS, () => this._update.getState());
    ipcMain.on(CH.CHECK_UPDATES, () => this._update.onCheck());
    ipcMain.on(CH.INSTALL_UPDATE, () => this._update.onInstall());
    ipcMain.on(CH.LYRICS_REFETCH, (_e, query) => this._onLyricsRefetch(query));
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
    ipcMain.on(CH.TOGGLE_LYRICS, () => this._onToggleLyrics());
  }
}

module.exports = { hub: new Hub(), CH };
