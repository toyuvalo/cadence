'use strict';

const path = require('path');
const { BrowserWindow } = require('electron');
const { hub } = require('../hub');

let winRef = null;

function open() {
  if (winRef && !winRef.isDestroyed()) {
    winRef.show();
    winRef.focus();
    return winRef;
  }
  winRef = new BrowserWindow({
    width: 560,
    height: 720,
    resizable: true,
    minimizable: true,
    maximizable: false,
    title: 'Cadence — Settings',
    backgroundColor: '#0b0b0d',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', '..', 'preload', 'app-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  winRef.removeMenu();
  winRef.loadFile(path.join(__dirname, '..', '..', 'renderer', 'settings', 'settings.html'));
  hub.registerUI(winRef);
  winRef.on('closed', () => {
    winRef = null;
  });
  return winRef;
}

module.exports = { open };
