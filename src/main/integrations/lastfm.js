'use strict';

const https = require('https');
const crypto = require('crypto');
const querystring = require('querystring');
const { hub } = require('./../hub');
const config = require('./../config');

const LASTFM_API_URL = 'https://ws.audioscrobbler.com/2.0/';
const MIN_TRACK_DURATION = 30; // Last.fm won't scrobble tracks shorter than this
const MAX_SCROBBLE_SECS = 240; // scrobble no later than 4 minutes in

// Credentials come from the environment only — never from disk or config, so a
// public build ships no keys. Set LASTFM_API_KEY / LASTFM_API_SECRET /
// LASTFM_SESSION_KEY (e.g. from your secrets manager). Missing any = no-op.
const API_KEY = process.env.LASTFM_API_KEY;
const API_SECRET = process.env.LASTFM_API_SECRET;
const SESSION_KEY = process.env.LASTFM_SESSION_KEY;
const envsPresent = !!(API_KEY && API_SECRET && SESSION_KEY);

if (!envsPresent) {
  console.log('[lastfm] disabled: set LASTFM_API_KEY / LASTFM_API_SECRET / LASTFM_SESSION_KEY to enable');
}

// Last.fm signs each authenticated call: sort params by key, concat as
// key+value with no separators, append the shared secret, md5 the result.
// `format` is excluded from the signature.
function buildSig(params) {
  const sigStr =
    Object.keys(params)
      .filter((k) => k !== 'format')
      .sort()
      .reduce((acc, k) => acc + k + params[k], '') + API_SECRET;
  return crypto.createHash('md5').update(sigStr, 'utf8').digest('hex');
}

// POST params (plus format=json). Rejects on network error or an API error body.
function apiPost(params) {
  return new Promise((resolve, reject) => {
    const body = querystring.stringify({ ...params, format: 'json' });
    const req = https.request(
      LASTFM_API_URL,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(body),
        },
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (json.error) reject(new Error(`API error ${json.error}: ${json.message}`));
            else resolve(json);
          } catch (err) {
            reject(err);
          }
        });
      }
    );
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function callUpdateNowPlaying(track) {
  const params = {
    method: 'track.updateNowPlaying',
    api_key: API_KEY,
    sk: SESSION_KEY,
    track: track.title,
    artist: track.artist,
    duration: String(Math.round(track.duration)),
  };
  if (track.album) params.album = track.album;
  params.api_sig = buildSig(params);
  try {
    await apiPost(params);
    console.log(`[lastfm] now playing: "${track.title}" — ${track.artist}`);
  } catch (err) {
    console.error(`[lastfm] now-playing failed: ${err.message}`);
  }
}

// track.startedAt is the unix time the track began, so the timestamp stays
// correct even if we picked it up mid-song.
async function callScrobble(track) {
  const params = {
    method: 'track.scrobble',
    api_key: API_KEY,
    sk: SESSION_KEY,
    track: track.title,
    artist: track.artist,
    timestamp: String(track.startedAt),
    duration: String(Math.round(track.duration)),
  };
  if (track.album) params.album = track.album;
  params.api_sig = buildSig(params);
  try {
    await apiPost(params);
    console.log(`[lastfm] scrobbled: "${track.title}" — ${track.artist}`);
  } catch (err) {
    console.error(`[lastfm] scrobble failed: ${err.message}`);
  }
}

// Per-track tracking. State events arrive ~1/sec; we accumulate wall-clock
// listen time (skipping pauses and ads) and scrobble once past the threshold.
let currentTrack = null;
let playedSeconds = 0;
let lastPingWallMs = 0;
let scrobbled = false;
let nowPlayingSent = false;

function isEnabled() {
  return envsPresent && config.get('integrations.lastFmEnabled', false);
}

// Scrobble once we've heard min(scrobblePercent% of the track, 4 minutes).
function scrobbleThreshold(duration) {
  const pct = config.get('lastfm.scrobblePercent', 50);
  return Math.min(duration * (pct / 100), MAX_SCROBBLE_SECS);
}

function maybeScrobble() {
  if (!currentTrack || scrobbled) return;
  if (!currentTrack.duration || currentTrack.duration < MIN_TRACK_DURATION) return;
  if (playedSeconds >= scrobbleThreshold(currentTrack.duration)) {
    scrobbled = true; // set before the async POST so re-entrant pings can't double-fire
    callScrobble(currentTrack);
  }
}

function resetTrackState() {
  currentTrack = null;
  playedSeconds = 0;
  lastPingWallMs = Date.now();
  scrobbled = false;
  nowPlayingSent = false;
}

function onState(state, prev) {
  if (!isEnabled()) return;
  const now = Date.now();

  // Count the gap since the last ping as listen time only if we were actively
  // playing the same track then (not paused, not an ad). The 10s clamp absorbs
  // sleep/startup bursts.
  if (
    currentTrack &&
    prev &&
    prev.hasSong &&
    !prev.isPaused &&
    !prev.adShowing &&
    prev.videoId === currentTrack.videoId
  ) {
    const elapsed = (now - lastPingWallMs) / 1000;
    if (elapsed > 0 && elapsed < 10) playedSeconds += elapsed;
  }
  lastPingWallMs = now;

  const videoIdChanged = state.hasSong && (!currentTrack || state.videoId !== currentTrack.videoId);
  const songStopped = !state.hasSong && currentTrack !== null;

  if (videoIdChanged || songStopped) {
    maybeScrobble(); // scrobble the outgoing track first

    if (state.hasSong && !state.adShowing) {
      const startedAt = Math.floor(Date.now() / 1000) - Math.floor(state.currentTime);
      currentTrack = {
        videoId: state.videoId,
        title: state.title,
        artist: state.artist,
        album: state.album || '',
        duration: state.duration,
        startedAt,
      };
      playedSeconds = 0;
      scrobbled = false;
      nowPlayingSent = false;
      if (!state.isPaused) {
        nowPlayingSent = true;
        callUpdateNowPlaying(currentTrack);
      }
    } else {
      resetTrackState();
    }
    return;
  }

  // Same track: an ad or a stall interrupted it — keep the track alive across
  // ads, but scrobble if it already qualified.
  if (!state.hasSong || state.adShowing) {
    maybeScrobble();
    if (!state.adShowing) resetTrackState();
    return;
  }

  // Fire now-playing on the first unpause if we hadn't sent it yet.
  if (!nowPlayingSent && !state.isPaused && prev && prev.isPaused) {
    nowPlayingSent = true;
    callUpdateNowPlaying(currentTrack);
  }
  if (!scrobbled) maybeScrobble();
}

function init() {
  if (!envsPresent) return;

  hub.on('state', (state, prev) => {
    try {
      onState(state, prev);
    } catch (err) {
      console.error(`[lastfm] state handler error: ${err.message}`);
    }
  });

  config.on('change', () => {
    // Re-reading isEnabled() on every state event already gates scrobbling;
    // just drop in-flight tracking if the user turned it off.
    if (!config.get('integrations.lastFmEnabled', false)) resetTrackState();
  });
}

module.exports = { init };
