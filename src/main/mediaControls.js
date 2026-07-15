'use strict';

const path = require('path');
const { globalShortcut, nativeImage } = require('electron');
const { hub } = require('./hub');
const config = require('./config');
const { diag } = require('../shared/diag');

// Maps the configurable accelerators to player commands. Registering the OS
// media keys (MediaPlayPause etc.) is what makes keyboard/headset buttons work.
// Windows SMTC (the volume-OSD now-playing card) comes for free: Chromium emits
// it from navigator.mediaSession, which YTM populates — no native code needed.

const ICON_DIR = path.join(__dirname, '..', '..', 'assets', 'icons');

// Load the thumbar icons once — they never change, so there's no reason to hit
// disk on every state tick. Returns null until all four are readable.
let icons = null;
function loadIcons() {
  if (icons) return icons;
  const one = (name) => {
    const img = nativeImage.createFromPath(path.join(ICON_DIR, name));
    return img.isEmpty() ? null : img;
  };
  const set = { prev: one('thumb-prev.png'), next: one('thumb-next.png'), play: one('thumb-play.png'), pause: one('thumb-pause.png') };
  if (set.prev && set.next && set.play && set.pause) icons = set;
  return icons;
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

let winRef = null;
let lastKey = null; // 'playing' | 'paused' — skip redundant re-applies

// (Re)draw the Windows taskbar-thumbnail toolbar: Previous / Play-Pause / Next.
// These only render once the window actually owns a taskbar button, so calling
// this while the window is still hidden (show:false, pre-ready-to-show) is a
// silent no-op — which is exactly why the buttons never used to appear. We apply
// on show / restore (force) and whenever play↔pause flips.
function applyThumbar(force) {
  const win = winRef;
  if (!win || win.isDestroyed()) return;
  const set = loadIcons();
  if (!set) {
    // eslint-disable-next-line no-console
    console.error('[mediaControls] thumbar skipped — icons missing/empty in', ICON_DIR);
    return;
  }
  const state = hub.latest || {};
  const isPlaying = !!(state.hasSong && !state.isPaused);
  const key = isPlaying ? 'playing' : 'paused';
  if (!force && key === lastKey) return;

  try {
    const ok = win.setThumbarButtons([
      { tooltip: 'Previous', icon: set.prev, click: () => { diag('thumbar click: previous'); hub.sendCommand('previous'); } },
      { tooltip: isPlaying ? 'Pause' : 'Play', icon: isPlaying ? set.pause : set.play, click: () => { diag('thumbar click: playPause'); hub.sendCommand('playPause'); } },
      { tooltip: 'Next', icon: set.next, click: () => { diag('thumbar click: next'); hub.sendCommand('next'); } },
    ]);
    lastKey = key;
    // eslint-disable-next-line no-console
    console.log(`[mediaControls] thumbar applied=${ok} isPlaying=${isPlaying} visible=${win.isVisible()} min=${win.isMinimized()}`);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[mediaControls] thumbar failed:', err.message);
  }
}

function init(win) {
  winRef = win;
  registerShortcuts();

  const force = () => applyThumbar(true);
  // Apply the moment the window has (or gains) a taskbar button.
  if (win.isVisible()) force();
  win.once('ready-to-show', force);
  win.on('show', force);
  win.on('restore', force);
  // Windows occasionally drops the thumbar buttons when the taskbar button is
  // recreated; re-assert them a beat after first paint as a belt-and-braces.
  setTimeout(force, 1500);

  // Keep the middle button's icon/tooltip in lockstep with play/pause.
  hub.on('state', () => applyThumbar(false));
  config.on('change', () => registerShortcuts());
}

module.exports = { init, registerShortcuts };
