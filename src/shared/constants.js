'use strict';

// Single source of truth for the app's contract: version, URLs, IPC channel
// names, and the default settings schema. Every module imports from here so the
// main process, preload bridge, and renderer UIs can never drift apart.

const APP_NAME = 'Cadence';
// Version is duplicated in package.json (the build authority). Keep them in sync
// on every release — this constant is what the UI/tray/about screen displays.
const APP_VERSION = '1.0.6';

const YTM_URL = 'https://music.youtube.com/';
const YTM_ORIGIN = 'https://music.youtube.com';

// A recent desktop Chrome UA. Electron's default UA contains "Electron" and the
// app name, which some Google surfaces treat differently; presenting as plain
// Chrome avoids "unsupported browser" friction and keeps us resilient to UA
// gating. Chromium version is filled in at runtime from process.versions.chrome.
const UA_TEMPLATE =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/%CHROME% Safari/537.36';

// IPC channels. Prefix by direction to keep them greppable.
const IPC = {
  // ytm preload  ->  main
  STATE: 'ytm:state', // full PlayerState snapshot
  READY: 'ytm:ready', // preload bridge attached
  LOG: 'ytm:log', // forwarded diagnostic line from the bridge

  // main  ->  ytm preload
  COMMAND: 'ytm:command', // { action, value }

  // app UI (settings / mini-player)  <->  main
  GET_STATE: 'app:getState',
  GET_CONFIG: 'app:getConfig',
  SET_CONFIG: 'app:setConfig',
  CONFIG_CHANGED: 'app:configChanged',
  CONTROL: 'app:control', // UI buttons -> a player command
  OPEN_SETTINGS: 'app:openSettings',
  TOGGLE_MINI: 'app:toggleMini',
  APP_INFO: 'app:info',
};

// Player commands understood by the ytm preload bridge.
const ACTIONS = {
  PLAY: 'play',
  PAUSE: 'pause',
  PLAY_PAUSE: 'playPause',
  NEXT: 'next',
  PREVIOUS: 'previous',
  SEEK: 'seek', // value: seconds (absolute)
  SEEK_BY: 'seekBy', // value: delta seconds
  VOLUME: 'volume', // value: 0..100
  LIKE: 'like',
  DISLIKE: 'dislike',
  MUTE_TOGGLE: 'muteToggle',
};

// Like state enum mirrored from YTM.
const LIKE = { LIKE: 'LIKE', DISLIKE: 'DISLIKE', INDIFFERENT: 'INDIFFERENT' };

// Default settings. electron-store persists overrides; this is the schema +
// fallback so a corrupt/missing config can never crash startup.
const DEFAULT_CONFIG = {
  general: {
    startMinimized: false,
    // Minimize always stays in the taskbar (so the thumbnail-toolbar media
    // controls work on hover); there is no longer a minimize-to-tray option.
    closeToTray: true, // ✕ while playing shrinks to the mini player instead of quitting
    startOnBoot: false,
    restoreLastTrack: true,
  },
  appearance: {
    zoom: 100, // percent
    customCSSEnabled: false,
    customCSSPath: '',
    theme: 'system', // system | dark | light (applies to our own chrome)
  },
  resilience: {
    autoRecover: true, // supervisor reloads on crash
    watchdogEnabled: true, // detect hung/blank renderer
    watchdogIntervalMs: 15000,
    maxReloadAttempts: 8,
  },
  features: {
    skipDisabledAds: true, // auto-skip/mute video ads
    hideAds: true, // CSS-hide promo surfaces
    sleepTimerEnabled: false,
  },
  integrations: {
    discordRPC: false,
    discordClientId: '', // register a Discord app and set its id to enable RPC
    lastFmEnabled: false,
    notificationsOnTrackChange: true,
  },
  shortcuts: {
    // empty string = use OS media keys only; values are Electron accelerators
    playPause: 'MediaPlayPause',
    next: 'MediaNextTrack',
    previous: 'MediaPreviousTrack',
    volumeUp: '',
    volumeDown: '',
    like: '',
    miniPlayer: '',
  },
  lastfm: {
    // The app's public Last.fm API identity lives in code, not here. This holds
    // only the per-user session key obtained after the user authorizes.
    sessionKey: '',
    username: '',
    scrobblePercent: 50,
  },
  state: {
    windowBounds: { width: 1280, height: 800, x: undefined, y: undefined },
    maximized: false,
    lastUrl: '',
    volume: 60,
  },
};

module.exports = {
  APP_NAME,
  APP_VERSION,
  YTM_URL,
  YTM_ORIGIN,
  UA_TEMPLATE,
  IPC,
  ACTIONS,
  LIKE,
  DEFAULT_CONFIG,
};
