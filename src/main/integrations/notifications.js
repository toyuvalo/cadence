'use strict';

const https = require('https');
const { Notification, nativeImage } = require('electron');
const { hub } = require('./../hub');
const config = require('./../config');
const { APP_NAME } = require('../../shared/constants');

// Desktop notification on track change, with album art. Pure Electron + https —
// no third-party dependency.

let lastNotifiedId = '';
const artCache = new Map(); // url -> nativeImage

function fetchImage(url) {
  return new Promise((resolve) => {
    if (!url) return resolve(null);
    if (artCache.has(url)) return resolve(artCache.get(url));
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
              const out = img.isEmpty() ? null : img;
              if (out && artCache.size < 50) artCache.set(url, out);
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
