'use strict';

const path = require('path');
const { app, BrowserWindow, nativeTheme } = require('electron');

const config = require('./config');
const { hub } = require('./hub');
const Supervisor = require('./supervisor');
const mainWindow = require('./windows/mainWindow');
const settingsWindow = require('./windows/settingsWindow');
const miniPlayer = require('./windows/miniPlayer');
const tray = require('./tray');
const mediaControls = require('./mediaControls');
const notifications = require('./integrations/notifications');
const discord = require('./integrations/discord');
const lastfm = require('./integrations/lastfm');
const { APP_NAME, APP_VERSION } = require('../shared/constants');

// --- single instance --------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = mainWindow.getWindow();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
  bootstrap();
}

// A couple of conservative stability switches. We deliberately do NOT disable
// hardware acceleration (it hurts playback); instead we keep audio resilient via
// the supervisor's audio-service handler below.
app.commandLine.appendSwitch('disable-features', 'HardwareMediaKeyHandling');
// HardwareMediaKeyHandling off => our globalShortcut media keys win, and Chrome's
// built-in handler can't fight us for MediaPlayPause.

function bootstrap() {
  app.setAppUserModelId('ca.dvlce.cadence'); // correct Windows toast/grouping
  app.name = APP_NAME;

  app.whenReady().then(() => {
    nativeTheme.themeSource = config.get('appearance.theme', 'system');

    const { win } = mainWindow.create();
    hub.wire();

    const supervisor = new Supervisor({
      getWebContents: () => mainWindow.getYtmWebContents(),
      onStatus: (status, detail) => hub.pushSupervisorStatus(status, detail),
      onReloaded: () => {
        mainWindow.setYtmVisible(true);
        // Persist the URL we successfully landed on so restore-last-track works.
        const wc = mainWindow.getYtmWebContents();
        if (wc && !wc.isDestroyed()) {
          try {
            config.set('state.lastUrl', wc.getURL());
          } catch {}
        }
      },
    });
    supervisor.start();

    // While recovering, hide the YTM view so the host page's overlay shows.
    hub.on('status', ({ status }) => {
      const recovering = ['recovering', 'unresponsive', 'error', 'fatal'].includes(status);
      mainWindow.setYtmVisible(!recovering);
    });

    hub.setRefs({
      getYtmWebContents: () => mainWindow.getYtmWebContents(),
      supervisor,
      onOpenSettings: () => settingsWindow.open(),
      onToggleMini: () => miniPlayer.toggle(),
    });

    // Register our own host window + integrations as state consumers.
    hub.registerUI(win);

    tray.create();
    mediaControls.init(win);
    notifications.init();
    discord.init();
    lastfm.init();

    // --- the audio-service crash that bricked YTMDesktop --------------------
    // Electron surfaces it as an app-level child-process-gone for the Utility
    // process named "Audio Service". The supervisor re-syncs playback.
    app.on('child-process-gone', (_e, details) => {
      // eslint-disable-next-line no-console
      console.error('[main] child-process-gone:', JSON.stringify(details));
      if (
        details &&
        (details.serviceName === 'audio.mojom.AudioService' ||
          details.name === 'Audio Service' ||
          (details.type === 'Utility' && /audio/i.test(details.serviceName || '')))
      ) {
        supervisor.onAudioServiceGone(details);
      }
    });

    // Apply zoom/theme live when settings change.
    config.on('change', (cfg) => {
      mainWindow.applyZoom(cfg.appearance.zoom);
      nativeTheme.themeSource = cfg.appearance.theme || 'system';
    });

    // --- close / minimize behaviour -----------------------------------------
    // Minimize now ALWAYS stays in the taskbar (we no longer hide-to-tray on
    // minimize) so the taskbar-thumbnail media controls — Previous / Play-Pause
    // / Next, set up in mediaControls.js — are reachable on hover.
    //
    // Pressing ✕:
    //   • music playing   -> shrink into the mini player and keep audio alive
    //     (as long as `closeToTray` is on, which is the default).
    //   • nothing playing -> quit for real.
    win.on('close', (e) => {
      if (app.isQuitting) return; // an explicit Quit is already underway
      const st = hub.latest || {};
      const isPlaying = !!(st.hasSong && !st.isPaused);
      if (isPlaying && config.get('general.closeToTray', true)) {
        e.preventDefault();
        win.hide();
        miniPlayer.open();
      } else {
        app.isQuitting = true;
        app.quit();
      }
    });

    // eslint-disable-next-line no-console
    console.log(`[main] ${APP_NAME} ${APP_VERSION} ready (Electron ${process.versions.electron}, Chrome ${process.versions.chrome})`);
  });

  app.on('window-all-closed', () => {
    // We keep running in the tray on Windows; only quit explicitly.
    if (process.platform === 'darwin') return;
    if (app.isQuitting) app.quit();
  });

  app.on('before-quit', () => {
    app.isQuitting = true;
  });

  app.on('will-quit', () => {
    const { globalShortcut } = require('electron');
    globalShortcut.unregisterAll();
  });
}
