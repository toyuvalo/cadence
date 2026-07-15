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
