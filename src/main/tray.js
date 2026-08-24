'use strict';

const path = require('path');
const { Tray, Menu, nativeImage, app } = require('electron');
const { hub } = require('./hub');
const { APP_NAME } = require('../shared/constants');

let tray = null;

function iconImage() {
  const p = path.join(__dirname, '..', '..', 'assets', 'icons', 'tray.png');
  const img = nativeImage.createFromPath(p);
  return img.isEmpty() ? nativeImage.createFromPath(path.join(__dirname, '..', '..', 'assets', 'icons', 'icon.ico')) : img;
}

function truncate(s, n) {
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

// The updater entry doubles as its own status readout, so the tray always tells
// the truth about where an update got to without needing a separate window.
function updateMenuLabel() {
  const u = hub._update.getState();
  if (u.status === 'ready') return `Restart to install ${u.version}`;
  if (u.status === 'downloading') return `Downloading update… ${u.percent}%`;
  if (u.status === 'checking') return 'Checking for updates…';
  return 'Check for updates…';
}

function updateMenuClick() {
  const u = hub._update.getState();
  if (u.status === 'ready') hub._update.onInstall();
  else if (u.status !== 'downloading' && u.status !== 'checking') hub._update.onCheck();
}

function buildMenu(state) {
  const playing = state && state.hasSong;
  const nowLabel = playing
    ? `${truncate(state.title, 40)} — ${truncate(state.artist, 30)}`
    : 'Nothing playing';

  return Menu.buildFromTemplate([
    { label: nowLabel, enabled: false },
    { type: 'separator' },
    {
      label: playing && !state.isPaused ? 'Pause' : 'Play',
      click: () => hub.sendCommand('playPause'),
    },
    { label: 'Next', click: () => hub.sendCommand('next') },
    { label: 'Previous', click: () => hub.sendCommand('previous') },
    { type: 'separator' },
    { label: 'Like', click: () => hub.sendCommand('like') },
    { type: 'separator' },
    { label: 'Mini Player', click: () => hub._onToggleMini() },
    { label: 'Lyrics', click: () => hub._onToggleLyrics() },
    { label: 'Settings…', click: () => hub._onOpenSettings() },
    { label: updateMenuLabel(), click: () => updateMenuClick() },
    { type: 'separator' },
    {
      label: 'Show / Hide',
      click: () => {
        const { getWindow } = require('./windows/mainWindow');
        const win = getWindow();
        if (!win) return;
        if (win.isVisible() && !win.isMinimized()) win.hide();
        else {
          win.show();
          win.focus();
        }
      },
    },
    { type: 'separator' },
    {
      label: 'Quit Cadence',
      click: () => {
        app.isQuitting = true;
        app.quit();
      },
    },
  ]);
}

function update(state) {
  if (!tray) return;
  const tip = state && state.hasSong
    ? `${APP_NAME} — ${truncate(state.title, 50)}`
    : `${APP_NAME}`;
  tray.setToolTip(tip);
  tray.setContextMenu(buildMenu(state));
}

function create() {
  try {
    tray = new Tray(iconImage());
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[tray] failed to create:', err.message);
    return null;
  }
  tray.setToolTip(APP_NAME);
  update(hub.latest);

  tray.on('click', () => {
    const { getWindow } = require('./windows/mainWindow');
    const win = getWindow();
    if (!win) return;
    if (win.isVisible() && !win.isMinimized()) win.focus();
    else {
      win.show();
      win.focus();
    }
  });

  hub.on('state', (state) => update(state));
  // Rebuild on updater progress too, so the menu's status line stays live.
  hub.on('update', () => update(hub.latest));
  return tray;
}

module.exports = { create };
