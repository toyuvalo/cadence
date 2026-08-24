'use strict';

// Auto-update. Cadence checks its own GitHub releases, downloads new versions in
// the background, and installs them when the app quits — so listening is never
// interrupted by an update, and the user never has to notice one happened.
//
// Why this exists: before it, every release required manually re-running the
// installer. In practice that meant the installed app sat at 1.0.6 from July
// while the repo shipped 1.1.0 and 1.2.x — the user only found out when a
// feature they'd asked for wasn't there.
//
// Transport is electron-updater against the `publish` block in package.json
// (GitHub provider, public repo → no token needed by the CLIENT; a token is only
// needed by the machine PUBLISHING a release). The NSIS installer is per-user
// (`perMachine: false`), so applying an update never prompts for admin rights.
//
// Everything here is defensive: an unreachable network, a rate-limited API, a
// dev run from source, or a corrupt partial download must never take the music
// player down with it.

const { app, autoUpdater: _electronAutoUpdater } = require('electron');
const { hub } = require('./hub');
const config = require('./config');
const { UPDATE_STATUS, EMPTY_UPDATE } = require('../shared/constants');

let updater = null; // electron-updater's autoUpdater, loaded lazily
let timer = null;
let state = { ...EMPTY_UPDATE };
let downloadedVersion = ''; // set once an install is staged and ready

function push(patch) {
  state = { ...state, ...patch };
  hub.pushUpdateStatus(state);
}

// Running `npm start` / `electron .` has no installer to replace, and
// electron-updater throws a hard error in that case. Detect it up front and
// present it as an honest status rather than an error the user can't action.
function isPackaged() {
  return app.isPackaged;
}

function load() {
  if (updater) return updater;
  try {
    // Required lazily so a missing/broken dependency degrades to "updates
    // unavailable" instead of preventing the app from starting at all.
    ({ autoUpdater: updater } = require('electron-updater'));
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[updater] electron-updater unavailable:', err.message);
    return null;
  }

  updater.autoDownload = config.get('updates.autoDownload', true);
  updater.autoInstallOnAppQuit = config.get('updates.installOnQuit', true);
  updater.allowPrerelease = config.get('updates.allowPrerelease', false);
  // electron-updater's own logging is noisy; route the useful parts to our log.
  updater.logger = {
    info: (m) => console.log('[updater]', m),
    warn: (m) => console.warn('[updater]', m),
    error: (m) => console.error('[updater]', m),
    debug: () => {},
  };

  updater.on('checking-for-update', () => push({ status: UPDATE_STATUS.CHECKING, message: '' }));

  updater.on('update-available', (info) => {
    push({
      status: config.get('updates.autoDownload', true)
        ? UPDATE_STATUS.DOWNLOADING
        : UPDATE_STATUS.AVAILABLE,
      version: info.version,
      notes: typeof info.releaseNotes === 'string' ? info.releaseNotes : '',
      percent: 0,
      message: `Cadence ${info.version} is available.`,
    });
  });

  updater.on('update-not-available', () => {
    push({
      status: UPDATE_STATUS.CURRENT,
      version: '',
      percent: 0,
      checkedAt: Date.now(),
      message: '',
    });
  });

  updater.on('download-progress', (p) => {
    push({ status: UPDATE_STATUS.DOWNLOADING, percent: Math.round(p.percent || 0) });
  });

  updater.on('update-downloaded', (info) => {
    downloadedVersion = info.version;
    push({
      status: UPDATE_STATUS.READY,
      version: info.version,
      percent: 100,
      checkedAt: Date.now(),
      message: `Cadence ${info.version} is ready — it installs when you quit.`,
    });
  });

  updater.on('error', (err) => {
    const msg = (err && err.message) || String(err);
    // eslint-disable-next-line no-console
    console.error('[updater] error:', msg);
    push({
      status: UPDATE_STATUS.ERROR,
      percent: 0,
      checkedAt: Date.now(),
      // Surface something a human can act on; the raw stack goes to the log.
      message: /net::|ENOTFOUND|EAI_AGAIN|ETIMEDOUT/i.test(msg)
        ? 'Could not reach the update server.'
        : 'Update check failed — see the log for details.',
    });
  });

  return updater;
}

async function check({ manual = false } = {}) {
  if (!isPackaged()) {
    push({
      status: UPDATE_STATUS.UNSUPPORTED,
      message: 'Running from source — updates apply to the installed app only.',
    });
    return;
  }
  if (!manual && !config.get('updates.autoCheck', true)) return;

  const u = load();
  if (!u) {
    push({ status: UPDATE_STATUS.UNSUPPORTED, message: 'Updater unavailable in this build.' });
    return;
  }
  // An update already staged doesn't need re-checking; re-announce it instead so
  // a manual check still gives the user feedback.
  if (downloadedVersion) {
    push({ status: UPDATE_STATUS.READY, version: downloadedVersion, percent: 100 });
    return;
  }
  try {
    await u.checkForUpdates();
  } catch (err) {
    // The 'error' event already reported this; swallow so nothing rejects here.
  }
}

// Quit and apply a staged update immediately (the "Restart now" affordance).
function installNow() {
  if (!downloadedVersion || !updater) return false;
  app.isQuitting = true;
  // isSilent=false so the user sees the installer's progress; isForceRunAfter=true
  // so Cadence comes back up on the new version rather than just disappearing.
  setImmediate(() => updater.quitAndInstall(false, true));
  return true;
}

function getState() {
  return state;
}

function init() {
  hub.setUpdateHandlers({
    onCheck: () => check({ manual: true }),
    onInstall: () => installNow(),
    getState,
  });

  // Live-apply preference changes without a restart.
  config.on('change', (cfg) => {
    if (!updater || !cfg.updates) return;
    updater.autoDownload = cfg.updates.autoDownload !== false;
    updater.autoInstallOnAppQuit = cfg.updates.installOnQuit !== false;
    updater.allowPrerelease = !!cfg.updates.allowPrerelease;
    schedule();
  });

  // First check is deliberately delayed: startup is the one moment the app is
  // busy loading YTM, restoring the last track and attaching the bridge, and an
  // update check is never urgent enough to compete with that.
  setTimeout(() => check(), 25000);
  schedule();
}

function schedule() {
  clearInterval(timer);
  const hours = Math.max(1, config.get('updates.checkIntervalHours', 6));
  if (!config.get('updates.autoCheck', true)) return;
  timer = setInterval(() => check(), hours * 60 * 60 * 1000);
}

module.exports = { init, check, installNow, getState };
