'use strict';

// Single source of truth for the app's contract: version, URLs, IPC channel
// names, and the default settings schema. Every module imports from here so the
// main process, preload bridge, and renderer UIs can never drift apart.

const APP_NAME = 'Cadence';
// Version has ONE source: package.json, which is what electron-builder stamps
// into the installer and what the auto-updater compares against the published
// release. It used to be re-declared here and drifted every single time the
// Stop hook bumped package.json alone (fixed by hand in 646c078 and 54200df,
// then drifted again at 1.2.1) — deriving it makes that class of bug impossible.
// electron-builder always ships package.json inside the asar, so this resolves
// in a packaged build exactly as it does from source.
const APP_VERSION = require('../../package.json').version;

const YTM_URL = 'https://music.youtube.com/';
const YTM_ORIGIN = 'https://music.youtube.com';

// LRCLIB's public API — the default and the recommended way to use Cadence.
const LYRICS_DEFAULT_API = 'https://lrclib.net/api';

// A cached, read-only mirror of LRCLIB, for people whose network filter blocks
// lrclib.net and who can't change that filter (managed work/school networks,
// ISP filters with no self-serve allowlist). It is a FALLBACK, not the default:
// allowlisting lrclib.net is one change that fixes every app on the network and
// keeps the user's lookups between them and LRCLIB with no middleman. The
// lyrics window offers this only after a block has actually been detected.
const LYRICS_MIRROR_API = 'https://lyrics.dvlce.ca/api';

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
  TOGGLE_LYRICS: 'app:toggleLyrics',
  APP_INFO: 'app:info',

  // auto-update
  UPDATE_STATUS: 'app:updateStatus', // main -> UI: push on every updater event
  GET_UPDATE_STATUS: 'app:getUpdateStatus', // invoke: latest UpdateState
  CHECK_UPDATES: 'app:checkUpdates', // UI -> main: manual check
  INSTALL_UPDATE: 'app:installUpdate', // UI -> main: quit + install now

  // lyrics (main -> our UI)
  GET_LYRICS: 'app:getLyrics', // invoke: latest LyricsState
  LYRICS_PUSH: 'app:lyricsPush', // push on every lyrics state change
  LYRICS_REFETCH: 'app:lyricsRefetch', // user asked for a re-lookup / manual search
};

// Lifecycle of an update check, mirrored in the shell banner + settings UI.
const UPDATE_STATUS = {
  IDLE: 'idle',
  CHECKING: 'checking',
  CURRENT: 'current', // already on the newest version
  AVAILABLE: 'available', // newer version exists (downloading if autoDownload)
  DOWNLOADING: 'downloading',
  READY: 'ready', // downloaded; installs on quit or on demand
  ERROR: 'error',
  UNSUPPORTED: 'unsupported', // running from source / unsigned dev build
};

const EMPTY_UPDATE = {
  status: UPDATE_STATUS.IDLE,
  version: '', // the version we found, when there is one
  notes: '',
  percent: 0,
  checkedAt: 0,
  message: '',
};

// Lifecycle of a lyrics lookup, mirrored in the lyrics window UI.
const LYRICS_STATUS = {
  IDLE: 'idle', // nothing playing / feature off
  LOADING: 'loading',
  OK: 'ok', // lines (synced) or plain text available
  NOT_FOUND: 'notfound',
  ERROR: 'error', // network/API failure — retried automatically
};

// Empty LyricsState — the shape every consumer can rely on.
const EMPTY_LYRICS = {
  status: LYRICS_STATUS.IDLE,
  videoId: '',
  title: '',
  artist: '',
  synced: false, // true => `lines` carry real timestamps
  instrumental: false,
  lines: [], // [{ time: seconds, text: string }]
  plain: '', // unsynced fallback text
  source: '', // which provider answered, e.g. 'LRCLIB' / 'NetEase'
  fallback: false, // true when the primary source missed and a backup answered
  reason: '', // why the fallback was used, shown next to the source badge
  message: '',
  hint: '', // secondary line: what the user can do about it
  // Machine-readable failure kind, so the UI can react to a specific problem
  // instead of pattern-matching the human-readable message. '' when fine.
  // 'blocked' => a network filter is cutting the connection; the window offers
  // the allowlist walkthrough and the mirror fallback.
  code: '',
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
    // --- sing-along lyrics ---------------------------------------------------
    // Time-synced lyrics are looked up from LRCLIB (open, no account, no key)
    // only while the lyrics window is open, so the feature costs nothing when
    // unused. Nothing is fetched from YouTube itself.
    lyricsEnabled: true,
    lyricsOffsetMs: 0, // global nudge: +ve = lyrics appear later
    lyricsFontSize: 30, // px, active line
    // Off by default: the window is a CHILD of the main window, so it floats
    // above Cadence but goes behind when you switch to another app. On = float
    // above every other app too (for a second monitor / karaoke night).
    lyricsAlwaysOnTop: false,
    lyricsAutoScroll: true,
    // Blank = LRCLIB's public API (recommended). Point this at the Cadence
    // mirror or a self-hosted LRCLIB instance if your network filters
    // lrclib.net and you cannot allowlist it (must expose /get and /search).
    lyricsApiBase: '',
    // Lyrics sources, tried in this order. LRCLIB is the primary (open, purpose
    // built for synced lyrics); NetEase is a fallback with a much deeper
    // catalogue of obscure, regional and non-English releases. Whichever one
    // answers is named in the lyrics window, so you always know where a set of
    // lyrics came from.
    lyricsSourceLrclib: true,
    lyricsSourceNetease: true,
    // Language clamp. Lyrics providers are community databases: a track with no
    // entry in your language can still match an entry in another one, and a
    // fallback source will hand it over without comment. Set this and anything
    // that isn't in the chosen language is refused outright — Cadence reports a
    // miss rather than showing lyrics you can't read.
    // 'any' | 'english' | 'latin' | 'chinese' | 'japanese' | 'korean' | 'cyrillic'
    lyricsLanguage: 'any',
  },
  // Auto-update. Cadence checks its own GitHub releases, downloads in the
  // background, and installs on quit — so a running app is never interrupted.
  updates: {
    autoCheck: true,
    autoDownload: true,
    installOnQuit: true,
    checkIntervalHours: 6,
    allowPrerelease: false,
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
    lyrics: '',
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
    lyricsBounds: { width: 420, height: 560, x: undefined, y: undefined },
    migrationsApplied: [], // ids of one-time config repairs already run
  },
};

module.exports = {
  APP_NAME,
  APP_VERSION,
  YTM_URL,
  YTM_ORIGIN,
  LYRICS_DEFAULT_API,
  LYRICS_MIRROR_API,
  UA_TEMPLATE,
  IPC,
  ACTIONS,
  LIKE,
  LYRICS_STATUS,
  EMPTY_LYRICS,
  UPDATE_STATUS,
  EMPTY_UPDATE,
  DEFAULT_CONFIG,
};
