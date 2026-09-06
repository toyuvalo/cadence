'use strict';

const path = require('path');
const { BrowserWindow, WebContentsView, shell, session } = require('electron');
const config = require('../config');
const { YTM_URL, YTM_ORIGIN, UA_TEMPLATE } = require('../../shared/constants');

const PARTITION = 'persist:ytm'; // persistent session => login survives restarts
const TOOLBAR_H = 40; // slim top toolbar (back/forward) reserved above the music view

let win = null; // the host BrowserWindow (our chrome + recovery overlay)
let ytmView = null; // WebContentsView hosting music.youtube.com

function userAgent() {
  return UA_TEMPLATE.replace('%CHROME%', process.versions.chrome);
}

// Allow the storage-access / media / notification permissions YTM needs. This
// directly fixes the repeated `requestStorageAccessFor: Permission denied`
// failures seen in YTMDesktop's logs.
function configureSession() {
  const ses = session.fromPartition(PARTITION);
  // Capture the genuine Electron UA BEFORE we spoof, so we can present it back
  // on Google's login flow (see the onBeforeSendHeaders block below).
  const originalUA = ses.getUserAgent();
  const ALLOW = new Set([
    'media',
    'mediaKeySystem',
    'notifications',
    'storage-access',
    'top-level-storage-access',
    'background-sync',
    'fullscreen',
  ]);
  const fromYTM = (origin) => typeof origin === 'string' && origin.startsWith(YTM_ORIGIN);

  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(ALLOW.has(permission) && fromYTM(details && details.requestingUrl ? details.requestingUrl : YTM_ORIGIN));
  });
  ses.setPermissionCheckHandler((wc, permission, origin) => {
    return ALLOW.has(permission) && fromYTM(origin);
  });
  ses.setUserAgent(userAgent());

  // --- Google "this browser may not be secure" fix --------------------------
  // We spoof a plain Chrome UA for YouTube Music itself (avoids unsupported-
  // browser nags), but Google's account login blocks an embedded browser whose
  // spoofed UA is INCONSISTENT with its real client-hints. The proven fix
  // (th-ch/youtube-music): revert to the genuine, self-consistent Electron UA
  // for requests on Google's auth domains, so the secure-browser check passes.
  const AUTH_HOSTS = [
    'https://accounts.google.com',
    'https://accounts.youtube.com',
    'https://accounts.google.ca',
  ];
  ses.webRequest.onBeforeSendHeaders((details, callback) => {
    if (AUTH_HOSTS.some((h) => details.url.startsWith(h))) {
      details.requestHeaders['User-Agent'] = originalUA;
    }
    callback({ requestHeaders: details.requestHeaders });
  });

  return ses;
}

function layoutView() {
  if (!win || !ytmView || win.isDestroyed()) return;
  const [w, h] = win.getContentSize();
  // Leave a strip at the top for the toolbar (back/forward), which lives in the
  // host page behind the view; the recovery overlay covers the whole window.
  ytmView.setBounds({ x: 0, y: TOOLBAR_H, width: w, height: Math.max(0, h - TOOLBAR_H) });
}

function create() {
  const bounds = config.get('state.windowBounds', {});
  configureSession();

  win = new BrowserWindow({
    width: bounds.width || 1280,
    height: bounds.height || 800,
    x: bounds.x,
    y: bounds.y,
    minWidth: 480,
    minHeight: 400,
    show: false,
    backgroundColor: '#030303',
    title: 'Cadence',
    icon: path.join(__dirname, '..', '..', '..', 'assets', 'icons', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, '..', '..', 'preload', 'app-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.removeMenu();
  win.loadFile(path.join(__dirname, '..', '..', 'renderer', 'shell', 'shell.html'));

  ytmView = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, '..', '..', 'preload', 'ytm-preload.js'),
      partition: PARTITION,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // backgroundThrottling is left at Chromium's default (true) on purpose.
      //
      // It used to be false, on the theory that it "keeps audio/state alive
      // when minimized". That premise is wrong: Chromium already exempts a page
      // that is PLAYING AUDIO from background timer throttling and from
      // renderer backgrounding, so the flag bought nothing during playback —
      // while costing full-rate JS for the whole YouTube Music page (its own
      // timers, its rAF, our heartbeat) whenever the window was hidden,
      // minimized, occluded, or simply paused. Electron also documents that one
      // unthrottled WebContents forces frames to be drawn and swapped for the
      // entire host window, so it was dragging the shell renderer along too.
      //
      // Two things depend on this being throttled again, and both are handled:
      // supervisor.js skips its bridge-silence check while the window is
      // hidden/minimized (a throttled heartbeat is not a dead one), and the
      // mini player extrapolates its own progress locally.
    },
  });
  win.contentView.addChildView(ytmView);
  // Stay hidden behind the animated loading overlay until YTM has actually
  // finished loading — so the user never clicks a half-loaded, non-interactive
  // page (the "clicks weren't registering" bug). Revealed on did-finish-load.
  ytmView.setVisible(false);

  const wc = ytmView.webContents;
  wc.setUserAgent(userAgent());
  applyZoom(config.get('appearance.zoom', 100));

  // Open external links (account, support, etc.) in the system browser instead
  // of hijacking the music view.
  wc.setWindowOpenHandler(({ url }) => {
    if (!url.startsWith(YTM_ORIGIN) && /^https?:/.test(url)) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  // Reveal the music view only once it has finished loading & is interactive.
  // Until then (and during any supervisor recovery) the user sees the animated
  // loading overlay instead of a blank/half-loaded page.
  wc.on('did-finish-load', () => setYtmVisible(true));

  // Alt+Left / Alt+Right navigate YTM's history (matches the toolbar buttons).
  wc.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown' || !input.alt) return;
    const nav = wc.navigationHistory;
    if (input.key === 'ArrowLeft' && nav && nav.canGoBack()) {
      nav.goBack();
      event.preventDefault();
    } else if (input.key === 'ArrowRight' && nav && nav.canGoForward()) {
      nav.goForward();
      event.preventDefault();
    }
  });

  const startUrl =
    config.get('general.restoreLastTrack', true) && config.get('state.lastUrl')
      ? config.get('state.lastUrl')
      : YTM_URL;
  wc.loadURL(startUrl, { userAgent: userAgent() });

  win.once('ready-to-show', () => {
    if (config.get('state.maximized')) win.maximize();
    if (!config.get('general.startMinimized', false)) win.show();
    layoutView();
  });

  win.on('resize', layoutView);
  win.on('maximize', layoutView);
  win.on('unmaximize', layoutView);
  win.on('enter-full-screen', layoutView);
  win.on('leave-full-screen', layoutView);

  // 'move'/'resize' fire continuously during a drag. Coalesce them into one
  // silent state write (config.setState debounces the disk hit and emits no
  // 'change', so this no longer re-registers every global shortcut per frame).
  let boundsTimer = null;
  const saveBounds = () => {
    if (boundsTimer) return;
    boundsTimer = setTimeout(() => {
      boundsTimer = null;
      if (!win || win.isDestroyed() || win.isMinimized()) return;
      config.setState({
        state: { windowBounds: win.getBounds(), maximized: win.isMaximized() },
      });
    }, 400);
    if (boundsTimer.unref) boundsTimer.unref();
  };
  win.on('resize', saveBounds);
  win.on('move', saveBounds);

  return { win, ytmView };
}

function applyZoom(percent) {
  if (ytmView && !ytmView.webContents.isDestroyed()) {
    ytmView.webContents.setZoomFactor(Math.max(0.5, Math.min(2.0, (percent || 100) / 100)));
  }
}

// Toggle YTM visibility so the host page's recovery overlay shows through.
function setYtmVisible(visible) {
  if (ytmView) ytmView.setVisible(visible);
}

function getWindow() {
  return win;
}

function getYtmWebContents() {
  return ytmView ? ytmView.webContents : null;
}

module.exports = {
  create,
  layoutView,
  applyZoom,
  setYtmVisible,
  getWindow,
  getYtmWebContents,
  userAgent,
  PARTITION,
};
