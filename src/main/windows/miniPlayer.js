'use strict';

const path = require('path');
const { BrowserWindow, screen } = require('electron');
const { hub } = require('../hub');

let winRef = null;

function open() {
  if (winRef && !winRef.isDestroyed()) {
    winRef.show();
    winRef.focus();
    return winRef;
  }
  const display = screen.getPrimaryDisplay();
  const { width: sw } = display.workAreaSize;

  winRef = new BrowserWindow({
    width: 340,
    height: 120,
    x: sw - 360,
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
