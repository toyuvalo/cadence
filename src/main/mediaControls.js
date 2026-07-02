'use strict';

const path = require('path');
const { globalShortcut, nativeImage } = require('electron');
const { hub } = require('./hub');
const config = require('./config');

// Maps the configurable accelerators to player commands. Registering the OS
// media keys (MediaPlayPause etc.) is what makes keyboard/headset buttons work.
// Windows SMTC (the volume-OSD now-playing card) comes for free: Chromium emits
// it from navigator.mediaSession, which YTM populates — no native code needed.

const ICON_DIR = path.join(__dirname, '..', '..', 'assets', 'icons');

function thumbIcon(name) {
  const img = nativeImage.createFromPath(path.join(ICON_DIR, name));
  return img.isEmpty() ? null : img;
}

function registerShortcuts() {
  globalShortcut.unregisterAll();
  const s = config.get('shortcuts', {});
  const map = [
    [s.playPause, 'playPause'],
    [s.next, 'next'],
    [s.previous, 'previous'],
    [s.like, 'like'],
  ];
  for (const [accel, action] of map) {
    if (!accel) continue;
    try {
      globalShortcut.register(accel, () => hub.sendCommand(action));
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error(`[mediaControls] could not register ${accel}:`, err.message);
    }
  }
  // Volume up/down support a repeat-friendly delta.
  if (s.volumeUp) {
    try {
      globalShortcut.register(s.volumeUp, () => {
        const v = Math.min(100, (hub.latest.volume || 0) + 5);
        hub.sendCommand('volume', v);
      });
    } catch {}
  }
  if (s.volumeDown) {
    try {
      globalShortcut.register(s.volumeDown, () => {
        const v = Math.max(0, (hub.latest.volume || 0) - 5);
        hub.sendCommand('volume', v);
      });
    } catch {}
  }
}

let thumbReady = false;
function updateThumbar(win, state) {
  if (!win || win.isDestroyed()) return;
  const prev = thumbIcon('thumb-prev.png');
  const next = thumbIcon('thumb-next.png');
  const play = thumbIcon('thumb-play.png');
  const pause = thumbIcon('thumb-pause.png');
  if (!prev || !next || !play || !pause) return; // icons not present yet

  const isPlaying = state && state.hasSong && !state.isPaused;
  try {
    win.setThumbarButtons([
      {
        tooltip: 'Previous',
        icon: prev,
        click: () => hub.sendCommand('previous'),
      },
      {
        tooltip: isPlaying ? 'Pause' : 'Play',
        icon: isPlaying ? pause : play,
        click: () => hub.sendCommand('playPause'),
      },
      {
        tooltip: 'Next',
        icon: next,
        click: () => hub.sendCommand('next'),
      },
    ]);
    thumbReady = true;
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[mediaControls] thumbar failed:', err.message);
  }
}

function init(win) {
  registerShortcuts();
  updateThumbar(win, hub.latest);
  hub.on('state', (state) => updateThumbar(win, state));
  config.on('change', () => registerShortcuts());
}

module.exports = { init, registerShortcuts };
