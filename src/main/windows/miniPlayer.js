'use strict';

const path = require('path');
const { BrowserWindow, screen } = require('electron');
const { hub } = require('../hub');

let winRef = null;

// Sized to the card's content: 82px art/meta + 18px seek row + 54px transport,
// plus the 12px shadow margin. The window used to be 120px tall while the card
// alone asked for 132px, so the transport row was clipped off the bottom.
const MINI_W = 380;
const MINI_H = 172;

function open() {
  if (winRef && !winRef.isDestroyed()) {
    winRef.show();
    winRef.focus();
    return winRef;
  }
  const display = screen.getPrimaryDisplay();
  const { width: sw } = display.workAreaSize;

  winRef = new BrowserWindow({
    width: MINI_W,
    height: MINI_H,
    x: sw - (MINI_W + 20),
    y: 24,
    frame: false,
    resizable: false,
    alwaysOnTop: true,
    skipTaskbar: true,
    transparent: true,
    backgroundColor: '#00000000',
    title: 'Cadence Mini',
    webPreferences: {
      preload: path.join(__dirname, '..', '..', 'preload', 'app-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  winRef.setAlwaysOnTop(true, 'screen-saver');
  winRef.loadFile(path.join(__dirname, '..', '..', 'renderer', 'miniplayer', 'miniplayer.html'));
  hub.registerUI(winRef);
  winRef.on('closed', () => {
    winRef = null;
  });
  return winRef;
}

function toggle() {
  if (winRef && !winRef.isDestroyed() && winRef.isVisible()) {
    winRef.close();
    winRef = null;
    return;
  }
  open();
}

module.exports = { open, toggle };
