'use strict';

const path = require('path');
const { BrowserWindow, screen } = require('electron');
const { hub } = require('../hub');
const config = require('../config');
const mainWindow = require('./mainWindow');
const lyrics = require('../integrations/lyrics');

let winRef = null;

function open() {
  if (winRef && !winRef.isDestroyed()) {
    winRef.show();
    winRef.focus();
    return winRef;
  }

  const saved = config.get('state.lyricsBounds', {}) || {};
  const { width: sw, height: sh } = screen.getPrimaryDisplay().workAreaSize;

  // Parenting the lyrics window to the main window keeps it above CADENCE only:
  // switch to another app and it goes behind with the rest of Cadence, which is
  // what you want from a companion panel. `alwaysOnTop` (opt-in, below) is the
  // separate, deliberate "float over every other app" behaviour.
  const parent = mainWindow.getWindow();
  const floatOverEverything = config.get('features.lyricsAlwaysOnTop', false);

  winRef = new BrowserWindow({
    width: saved.width || 420,
    height: saved.height || 560,
    x: saved.x,
    y: saved.y === undefined ? Math.round((sh - (saved.height || 560)) / 2) : saved.y,
    minWidth: 300,
    minHeight: 240,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    resizable: true,
    skipTaskbar: true,
    parent: floatOverEverything ? undefined : parent || undefined,
    alwaysOnTop: floatOverEverything,
    title: 'Cadence — Lyrics',
    webPreferences: {
      preload: path.join(__dirname, '..', '..', 'preload', 'app-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false, // keep the karaoke scroll smooth when unfocused
    },
  });

  if (saved.x === undefined) winRef.setPosition(sw - (saved.width || 420) - 32, winRef.getPosition()[1]);
  if (floatOverEverything) winRef.setAlwaysOnTop(true, 'screen-saver');
  winRef.removeMenu();
  winRef.loadFile(path.join(__dirname, '..', '..', 'renderer', 'lyrics', 'lyrics.html'));
  hub.registerUI(winRef);

  // Lookups only run while this window exists — no background API traffic.
  lyrics.setActive(true);

  const saveBounds = () => {
    if (!winRef || winRef.isDestroyed() || winRef.isMinimized()) return;
    config.set('state.lyricsBounds', winRef.getBounds());
  };
  winRef.on('resize', saveBounds);
  winRef.on('move', saveBounds);

  winRef.on('closed', () => {
    winRef = null;
    lyrics.setActive(false);
  });

  return winRef;
}

function close() {
  if (winRef && !winRef.isDestroyed()) winRef.close();
  winRef = null;
}

function toggle() {
  if (winRef && !winRef.isDestroyed() && winRef.isVisible()) {
    close();
    return;
  }
  open();
}

function isOpen() {
  return !!(winRef && !winRef.isDestroyed());
}

// Live-apply the float-over-everything preference from Settings. The parent
// relationship is fixed at creation time, so switching it off also drops the
// window back to "above Cadence only" — which is the parented default.
function applyConfig(cfg) {
  if (!isOpen()) return;
  const onTop = !!(cfg.features && cfg.features.lyricsAlwaysOnTop);
  winRef.setAlwaysOnTop(onTop, onTop ? 'screen-saver' : 'normal');
}

module.exports = { open, close, toggle, isOpen, applyConfig };
