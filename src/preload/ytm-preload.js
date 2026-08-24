'use strict';

// Injected into the music.youtube.com WebContentsView. Its job: expose a clean,
// stable player-state stream + accept commands — WITHOUT depending on YouTube
// Music's private JavaScript objects. We read the <video> element and
// navigator.mediaSession (both stable Chromium/standard APIs). When Google
// reshuffles their UI, this keeps working where YTMDesktop's "PlayerProxy" hook
// breaks.

const { ipcRenderer } = require('electron');

// Opt-in diagnostic (CADENCE_DIAG=1) — mirrors src/shared/diag.js but inlined so
// the preload has no cross-module/asar dependency. Writes to <tmp>/cadence-diag.log.
const DIAG = process.env.CADENCE_DIAG === '1';
function diagFile(msg) {
  if (!DIAG) return;
  try {
    const p = require('path').join(require('os').tmpdir(), 'cadence-diag.log');
    require('fs').appendFileSync(p, `[${new Date().toISOString()}] preload: ${msg}\n`);
  } catch {}
}

const IPC = {
  STATE: 'ytm:state',
  READY: 'ytm:ready',
  LOG: 'ytm:log',
  COMMAND: 'ytm:command',
  TOGGLE_LYRICS: 'app:toggleLyrics', // handled by hub.js, same as our own windows
};

const LIKE = { LIKE: 'LIKE', DISLIKE: 'DISLIKE', INDIFFERENT: 'INDIFFERENT' };

function log(msg) {
  try {
    ipcRenderer.send(IPC.LOG, String(msg));
  } catch {
    /* main may be gone during teardown */
  }
}

// ---- robust DOM helpers ---------------------------------------------------

// Try a list of selectors and return the first match, so a single YTM rename
// can't break a control.
function pick(selectors) {
  for (const sel of selectors) {
    const el = document.querySelector(sel);
    if (el) return el;
  }
  return null;
}

function getVideo() {
  return document.querySelector('video');
}

function clickFirst(selectors, label) {
  const el = pick(selectors);
  if (el) {
    el.click();
    diagFile(`clickFirst "${label}" -> clicked ${el.tagName}.${el.className || ''}`);
    return true;
  }
  diagFile(`clickFirst "${label}" -> NO ELEMENT for ${JSON.stringify(selectors)}`);
  log(`control "${label}" found no element`);
  return false;
}

// ---- state extraction -----------------------------------------------------

function readMetadata() {
  const meta =
    navigator.mediaSession && navigator.mediaSession.metadata
      ? navigator.mediaSession.metadata
      : null;
  if (meta && meta.title) {
    let art = '';
    if (meta.artwork && meta.artwork.length) {
      // Prefer the largest artwork.
      const sorted = [...meta.artwork].sort((a, b) => {
        const as = parseInt((a.sizes || '0').split('x')[0], 10) || 0;
        const bs = parseInt((b.sizes || '0').split('x')[0], 10) || 0;
        return bs - as;
      });
      art = sorted[0].src || '';
    }
    return {
      title: meta.title || '',
      artist: meta.artist || '',
      album: meta.album || '',
      artworkUrl: art,
    };
  }
  // DOM fallback (player bar) if mediaSession isn't populated yet.
  const title = pick(['.title.ytmusic-player-bar', 'ytmusic-player-bar .title']);
  const byline = pick(['.byline.ytmusic-player-bar', 'ytmusic-player-bar .byline']);
  const img = pick(['ytmusic-player-bar img.image', '#song-image img', 'img.ytmusic-player-bar']);
  return {
    title: title ? title.textContent.trim() : '',
    artist: byline ? byline.textContent.split('•')[0].trim() : '',
    album: '',
    artworkUrl: img ? img.src : '',
  };
}

function readLikeState() {
  const renderer = pick(['ytmusic-like-button-renderer']);
  if (renderer) {
    const status = renderer.getAttribute('like-status');
    if (status && LIKE[status]) return status;
  }
  return LIKE.INDIFFERENT;
}

function getVideoId() {
  try {
    const u = new URL(location.href);
    return u.searchParams.get('v') || '';
  } catch {
    return '';
  }
}

function snapshot() {
  const v = getVideo();
  const md = readMetadata();
  const hasSong = !!(md.title || (v && v.duration));
  return {
    hasSong,
    title: md.title,
    artist: md.artist,
    album: md.album,
    artworkUrl: md.artworkUrl,
    isPaused: v ? v.paused : true,
    currentTime: v && isFinite(v.currentTime) ? v.currentTime : 0,
    duration: v && isFinite(v.duration) ? v.duration : 0,
    volume: v ? Math.round(v.volume * 100) : 0,
    muted: v ? v.muted : false,
    liked: readLikeState(),
    videoId: getVideoId(),
    adShowing: isAdShowing(),
    ts: Date.now(),
  };
}

// ---- ad handling ----------------------------------------------------------

function isAdShowing() {
  const player = pick(['#movie_player', '.html5-video-player']);
  return !!(player && player.classList.contains('ad-showing'));
}

let adWatcher = null;
function startAdHandling() {
  if (adWatcher) return;
  adWatcher = setInterval(() => {
    try {
      // Click any visible "Skip" button.
      const skip = pick([
        '.ytp-ad-skip-button',
        '.ytp-ad-skip-button-modern',
        '.ytp-skip-ad-button',
      ]);
      if (skip) {
        skip.click();
        return;
      }
      // Unskippable ad: jump to the end + mute so it passes instantly.
      if (isAdShowing()) {
        const v = getVideo();
        if (v && isFinite(v.duration) && v.duration > 0) {
          v.muted = true;
          v.currentTime = v.duration;
          v.playbackRate = 16;
        }
      } else {
        const v = getVideo();
        if (v && v.playbackRate === 16) v.playbackRate = 1; // restore after ad
      }
    } catch {
      /* never let ad logic throw into YTM */
    }
  }, 500);
}

const AD_HIDE_CSS = `
  ytmusic-mealbar-promo-renderer,
  ytmusic-popup-container tp-yt-paper-dialog:has(ytmusic-mealbar-promo-renderer),
  .ad-showing .video-ads,
  ytmusic-statement-banner-renderer { display: none !important; }
`;

function injectAdCss() {
  const style = document.createElement('style');
  style.id = 'cadence-ad-hide';
  style.textContent = AD_HIDE_CSS;
  (document.head || document.documentElement).appendChild(style);
}

// ---- lyrics button --------------------------------------------------------
// This button has to be injected INTO the YouTube Music page rather than drawn
// in our own shell: the music view is a WebContentsView, which composites ABOVE
// the host page, so anything we render there below the toolbar strip is hidden
// behind the player. Injecting puts it in the only layer that is actually on
// top at the bottom-right of the window.

const LYRICS_BTN_ID = 'cadence-lyrics-btn';
let btnErrorLogged = false;

const LYRICS_BTN_CSS = `
  #${LYRICS_BTN_ID} {
    position: fixed; right: 20px; z-index: 2147483000;
    display: flex; align-items: center; gap: 7px;
    height: 38px; padding: 0 15px 0 13px; border: 0; border-radius: 999px;
    background: linear-gradient(135deg, #ff2d55, #7a1fff); color: #fff;
    font-family: "Segoe UI", system-ui, sans-serif; font-size: 12.5px; font-weight: 600;
    letter-spacing: .01em; cursor: pointer; box-shadow: 0 6px 22px rgba(0,0,0,.45);
    opacity: .92; transition: transform .15s ease, opacity .15s ease, box-shadow .15s ease;
  }
  #${LYRICS_BTN_ID}:hover { opacity: 1; transform: translateY(-1px); box-shadow: 0 10px 28px rgba(255,45,85,.35); }
  #${LYRICS_BTN_ID}:active { transform: translateY(0); }
  #${LYRICS_BTN_ID} svg { width: 17px; height: 17px; fill: currentColor; }
`;

// The player bar is fixed to the bottom of the viewport and changes height
// between normal and expanded/mini layouts, so measure it rather than guessing
// and leaving the button floating over YTM's own controls.
function playerBarHeight() {
  const bar = pick(['ytmusic-player-bar', '.ytmusic-player-bar']);
  const h = bar ? bar.getBoundingClientRect().height : 0;
  return h > 20 ? Math.round(h) : 72;
}

function ensureLyricsButton() {
  if (document.getElementById(LYRICS_BTN_ID)) {
    // Keep it clear of the player bar even when YTM changes its layout.
    document.getElementById(LYRICS_BTN_ID).style.bottom = playerBarHeight() + 18 + 'px';
    return;
  }
  if (!document.body) return;

  if (!document.getElementById('cadence-lyrics-btn-css')) {
    const style = document.createElement('style');
    style.id = 'cadence-lyrics-btn-css';
    style.textContent = LYRICS_BTN_CSS;
    (document.head || document.documentElement).appendChild(style);
  }

  const btn = document.createElement('button');
  btn.id = LYRICS_BTN_ID;
  btn.title = 'Sing along — time-synced lyrics';
  btn.style.bottom = playerBarHeight() + 18 + 'px';

  // Built with DOM APIs rather than innerHTML on purpose: YouTube Music enforces
  // Trusted Types (`require-trusted-types-for 'script'`), under which any
  // innerHTML assignment throws — which silently cost us the whole button.
  const SVG_NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M12 3v10.6a3.5 3.5 0 1 0 2 3.15V7h5V3h-7z');
  svg.appendChild(path);
  const label = document.createElement('span');
  label.textContent = 'Lyrics';
  btn.appendChild(svg);
  btn.appendChild(label);
  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      ipcRenderer.send(IPC.TOGGLE_LYRICS);
    } catch (err) {
      log('lyrics toggle failed: ' + err.message);
    }
  });
  document.body.appendChild(btn);
  log('lyrics button injected');
}

// ---- commands -------------------------------------------------------------

function handleCommand(_e, payload) {
  const { action, value } = payload || {};
  const v = getVideo();
  diagFile(`recv ${action} (video=${!!v}, paused=${v ? v.paused : 'n/a'})`);
  try {
    switch (action) {
      case 'play':
        if (v) v.play();
        break;
      case 'pause':
        if (v) v.pause();
        break;
      case 'playPause':
        if (v) (v.paused ? v.play() : v.pause());
        else clickFirst(['#play-pause-button', '.play-pause-button'], 'playPause');
        break;
      case 'next':
        clickFirst(
          ['.next-button.ytmusic-player-bar', 'tp-yt-paper-icon-button.next-button', '.next-button'],
          'next'
        );
        break;
      case 'previous':
        clickFirst(
          [
            '.previous-button.ytmusic-player-bar',
            'tp-yt-paper-icon-button.previous-button',
            '.previous-button',
          ],
          'previous'
        );
        break;
      case 'seek':
        if (v && isFinite(value)) v.currentTime = Math.max(0, value);
        break;
      case 'seekBy':
        if (v && isFinite(value)) v.currentTime = Math.max(0, v.currentTime + value);
        break;
      case 'volume':
        if (v && isFinite(value)) {
          v.volume = Math.max(0, Math.min(1, value / 100));
          v.muted = false;
        }
        break;
      case 'muteToggle':
        if (v) v.muted = !v.muted;
        break;
      case 'like':
        clickFirst(
          ['ytmusic-like-button-renderer #button-shape-like button', '#button-shape-like button'],
          'like'
        );
        break;
      case 'dislike':
        clickFirst(
          [
            'ytmusic-like-button-renderer #button-shape-dislike button',
            '#button-shape-dislike button',
          ],
          'dislike'
        );
        break;
      default:
        log('unknown command: ' + action);
    }
  } catch (err) {
    log('command "' + action + '" threw: ' + err.message);
  }
  // Push a fresh snapshot right after acting for snappy UI.
  pushState();
}

// ---- wiring ---------------------------------------------------------------

function pushState() {
  try {
    ipcRenderer.send(IPC.STATE, snapshot());
  } catch (err) {
    log('pushState error: ' + err.message);
  }
}

let attachedVideo = null;
function attachVideoEvents() {
  const v = getVideo();
  if (!v || v === attachedVideo) return;
  attachedVideo = v;
  ['play', 'pause', 'loadedmetadata', 'volumechange', 'ratechange', 'ended'].forEach((evt) =>
    v.addEventListener(evt, pushState)
  );
  log('attached to <video>');
  pushState();
}

function boot() {
  injectAdCss();
  startAdHandling();

  ipcRenderer.on(IPC.COMMAND, handleCommand);

  // Heartbeat: re-find the video (survives navigation), keep state fresh, and
  // act as the "bridge alive" ping the supervisor's watchdog looks for.
  setInterval(() => {
    attachVideoEvents();
    // YTM is a SPA that re-renders whole regions on navigation, so the button
    // is re-asserted on the same heartbeat that re-finds the <video>.
    try {
      ensureLyricsButton();
    } catch (err) {
      // Never let our chrome throw into YTM — but never swallow it silently
      // either: a swallowed Trusted-Types error is exactly how the button went
      // missing with no trace. Reported once so the log stays readable.
      if (!btnErrorLogged) {
        btnErrorLogged = true;
        log('lyrics button failed: ' + err.message);
      }
    }
    pushState();
  }, 1000);

  ipcRenderer.send(IPC.READY, { url: location.href });
  log('bridge ready on ' + location.href);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}
