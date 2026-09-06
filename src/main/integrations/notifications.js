'use strict';

const https = require('https');
const { Notification, nativeImage } = require('electron');
const { hub } = require('./../hub');
const config = require('./../config');
const { APP_NAME } = require('../../shared/constants');

// Desktop notification on track change, with album art. Pure Electron + https —
// no third-party dependency.

let lastNotifiedId = '';

// A Windows toast icon is displayed at roughly 48–64px, so there is no reason
// to hold the full-size art the preload hands us (it deliberately picks the
// LARGEST MediaSession artwork, which is commonly 544px or more).
const ICON_PX = 128;
const ART_CACHE_MAX = 10;

// LRU, not "first N wins". The previous `artCache.size < 50` guard was both a
// memory cost and a bug: fifty decoded full-size images are ~50–60 MiB of raw
// pixels retained for the life of the process, and once the cache filled it
// stopped admitting anything, so every later track re-downloaded its art
// forever while the fifty stale entries were never released.
const artCache = new Map(); // url -> nativeImage (insertion order = LRU order)

function cacheGet(url) {
  if (!artCache.has(url)) return undefined;
  const img = artCache.get(url);
  artCache.delete(url); // re-insert to mark as most recently used
  artCache.set(url, img);
  return img;
}

function cacheSet(url, img) {
  artCache.set(url, img);
  while (artCache.size > ART_CACHE_MAX) {
    artCache.delete(artCache.keys().next().value); // evict least recently used
  }
}

function fetchImage(url) {
  return new Promise((resolve) => {
    if (!url) return resolve(null);
    const hit = cacheGet(url);
    if (hit !== undefined) return resolve(hit);
    try {
      https
        .get(url, (res) => {
          if (res.statusCode !== 200) {
            res.resume();
            return resolve(null);
          }
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            try {
              const img = nativeImage.createFromBuffer(Buffer.concat(chunks));
              if (img.isEmpty()) return resolve(null);
              // Downscale before caching so what we retain is the toast-sized
              // icon, not the original artwork.
              const small = img.resize({ width: ICON_PX, height: ICON_PX, quality: 'good' });
              const out = small.isEmpty() ? img : small;
              cacheSet(url, out);
              resolve(out);
            } catch {
              resolve(null);
            }
          });
        })
        .on('error', () => resolve(null));
    } catch {
      resolve(null);
    }
  });
}

async function onState(state) {
  if (!config.get('integrations.notificationsOnTrackChange', true)) return;
  if (!Notification.isSupported()) return;
  if (!state.hasSong || !state.videoId) return;
  if (state.videoId === lastNotifiedId) return;
  lastNotifiedId = state.videoId;

  const icon = await fetchImage(state.artworkUrl);
  try {
    const n = new Notification({
      title: state.title || APP_NAME,
      body: [state.artist, state.album].filter(Boolean).join(' • '),
      icon: icon || undefined,
      silent: true,
    });
    n.show();
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[notifications] failed:', err.message);
  }
}

function init() {
  hub.on('state', (state) => {
    onState(state).catch(() => {});
  });
}

module.exports = { init };
