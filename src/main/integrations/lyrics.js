'use strict';

// Time-synced ("karaoke") lyrics for the currently playing track.
//
// Source: LRCLIB (https://lrclib.net) — an open, community lyrics database with
// no account, no API key and no rate-limit gymnastics. It returns LRC-format
// synced lyrics when a contributor has timed the track, plain text otherwise.
// We never scrape YouTube Music's own lyrics tab: that markup is unstable, and
// the timing data we need for sing-along simply isn't in it.
//
// Design notes:
//   • Lookups only run while a consumer is ACTIVE (the lyrics window is open),
//     so the feature costs zero network traffic when nobody is using it.
//   • Every response is keyed and cached by videoId, including negative results,
//     so skipping back and forth in a playlist never re-hits the API.
//   • A monotonically increasing request token makes late responses for an
//     already-changed track impossible to render.

const { net } = require('electron');
const { hub } = require('../hub');
const config = require('../config');
const {
  APP_NAME,
  APP_VERSION,
  LYRICS_STATUS,
  EMPTY_LYRICS,
} = require('../../shared/constants');

const DEFAULT_API = 'https://lrclib.net/api';

// Configurable so a blocked endpoint isn't a dead end: LRCLIB is self-hostable,
// and some networks (ISP "safe browsing" filters, school/office gateways) block
// lrclib.net outright — see classifyNetworkError below.
function apiBase() {
  const custom = String(config.get('features.lyricsApiBase', '') || '').trim();
  return (custom || DEFAULT_API).replace(/\/+$/, '');
}
// LRCLIB asks clients to identify themselves so they can contact maintainers of
// misbehaving apps rather than blanket-blocking.
const UA = `${APP_NAME}/${APP_VERSION} (https://github.com/toyuvalo/cadence)`;
const TIMEOUT_MS = 8000;
const CACHE_MAX = 150;
const RETRY_MS = 6000; // one automatic retry after a network failure

const cache = new Map(); // key -> LyricsState (successes AND misses)
let active = false; // is anything actually displaying lyrics right now?
let token = 0; // request generation; stale responses are dropped
let currentKey = null;
let retryTimer = null;

// ---- LRC parsing ----------------------------------------------------------

// Leading timestamps only: `[mm:ss.xx]`, possibly several per line for repeated
// refrains. Anything after the last leading stamp is the line's text.
const STAMP = /\[(\d{1,3}):(\d{1,2}(?:[.:]\d{1,3})?)\]/g;

function parseLrc(raw) {
  const out = [];
  let fileOffset = 0; // seconds, from an `[offset:±ms]` tag if present
  for (const line of String(raw || '').split(/\r?\n/)) {
    const off = /^\s*\[offset:\s*([+-]?\d+)\s*\]\s*$/i.exec(line);
    if (off) {
      // LRC convention: a positive offset means the lyrics should appear EARLIER.
      fileOffset = parseInt(off[1], 10) / 1000;
      continue;
    }
    STAMP.lastIndex = 0;
    const stamps = [];
    let m;
    let end = 0;
    while ((m = STAMP.exec(line))) {
      if (m.index !== end) break; // a stamp mid-text is lyric content, not timing
      end = STAMP.lastIndex;
      const secs = parseInt(m[1], 10) * 60 + parseFloat(m[2].replace(':', '.'));
      if (isFinite(secs)) stamps.push(secs);
    }
    if (!stamps.length) continue;
    const text = line.slice(end).trim();
    for (const t of stamps) out.push({ time: Math.max(0, t - fileOffset), text });
  }
  out.sort((a, b) => a.time - b.time);
  return out;
}

// ---- query shaping --------------------------------------------------------

// YTM titles carry release-clutter that LRCLIB's exact matcher chokes on.
function cleanTitle(t) {
  return String(t || '')
    .replace(
      /\s*[([][^)\]]*(official|lyric[s]?|video|audio|visuali[sz]er|remaster(ed)?|explicit|hd|hq|4k|m\/?v)[^)\]]*[)\]]/gi,
      ''
    )
    .replace(/\s*-\s*(official\s+)?(music\s+)?(video|audio)$/i, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

// "Artist - Topic" is YouTube's auto-generated channel suffix; and for the
// fuzzy search pass we only want the lead artist.
function cleanArtist(a) {
  return String(a || '')
    .replace(/\s*-\s*topic$/i, '')
    .split(/\s*(?:,|&|;|\bfeat\.?\b|\bft\.?\b|\bwith\b)\s*/i)[0]
    .trim();
}

function qs(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    sp.set(k, String(v));
  }
  return sp.toString();
}

// Generic JSON GET with a hard timeout, shared by every provider.
async function getJson(url, extraHeaders) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await net.fetch(url, {
      headers: { 'User-Agent': UA, Accept: 'application/json', ...(extraHeaders || {}) },
      signal: ctrl.signal,
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function apiGet(pathAndQuery) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await net.fetch(`${apiBase()}${pathAndQuery}`, {
      headers: { 'User-Agent': UA, Accept: 'application/json' },
      signal: ctrl.signal,
    });
    if (res.status === 404) return null; // a clean "no such track", not an error
    if (!res.ok) throw new Error(`LRCLIB HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// Prefer a synced record whose duration matches what we're actually playing —
// covers/live versions share titles, and the wrong one desyncs immediately.
function pickBest(candidates, duration) {
  const list = (Array.isArray(candidates) ? candidates : []).filter(Boolean);
  if (!list.length) return null;
  const score = (c) => {
    let s = 0;
    if (c.syncedLyrics) s -= 1000; // synced always wins over plain
    if (duration && c.duration) s += Math.abs(c.duration - duration);
    else s += 30; // unknown duration: mild penalty, still usable
    return s;
  };
  const ranked = [...list].sort((a, b) => score(a) - score(b));
  const best = ranked[0];
  // Reject a wildly different runtime — that's a different recording.
  if (duration && best.duration && Math.abs(best.duration - duration) > 15) {
    const near = ranked.find((c) => c.duration && Math.abs(c.duration - duration) <= 15);
    return near || null;
  }
  return best;
}

// Four escalating attempts: exact (with album + duration) → exact (no album) →
// exact on the cleaned strings → fuzzy search. First hit with timings wins.
async function lookup(track) {
  const duration = track.duration > 0 ? Math.round(track.duration) : undefined;
  const title = cleanTitle(track.title);
  const artist = cleanArtist(track.artist);

  const exact = [
    { track_name: track.title, artist_name: track.artist, album_name: track.album, duration },
    { track_name: track.title, artist_name: track.artist, duration },
    { track_name: title, artist_name: artist },
  ];
  for (const params of exact) {
    if (!params.track_name || !params.artist_name) continue;
    const hit = await apiGet(`/get?${qs(params)}`);
    if (hit && (hit.syncedLyrics || hit.plainLyrics || hit.instrumental)) return hit;
  }

  const found = await apiGet(`/search?${qs({ track_name: title, artist_name: artist })}`);
  let best = pickBest(found, duration);
  if (!best && title) {
    // Last resort: title-only search (handles a mis-tagged / localized artist).
    best = pickBest(await apiGet(`/search?${qs({ q: `${title} ${artist}`.trim() })}`), duration);
  }
  return best;
}

// ---- provider: NetEase ----------------------------------------------------
// Fallback for what LRCLIB doesn't have. Its catalogue is far deeper on obscure,
// regional and non-English releases, and it stores standard LRC, so the same
// parser handles it. Public read-only endpoints — no account, no key.

const NETEASE = 'https://music.163.com/api';
const NETEASE_HEADERS = { Referer: 'https://music.163.com/', Cookie: 'appver=2.0.2' };

async function neteaseLookup(track) {
  const query = `${cleanTitle(track.title)} ${cleanArtist(track.artist)}`.trim();
  if (!query) return null;

  const found = await getJson(
    `${NETEASE}/search/get?${qs({ s: query, type: 1, limit: 8, offset: 0 })}`,
    NETEASE_HEADERS
  );
  const songs = (found && found.result && found.result.songs) || [];
  if (!songs.length) return null;

  // Same duration-proximity rule as LRCLIB, so a cover or a live cut can't win.
  const wanted = track.duration > 0 ? Math.round(track.duration) : 0;
  const scored = songs
    .map((s) => ({ s, delta: wanted && s.duration ? Math.abs(s.duration / 1000 - wanted) : 999 }))
    .sort((a, b) => a.delta - b.delta);
  const best = wanted ? scored.find((c) => c.delta <= 15) : scored[0];
  if (!best) return null;

  const detail = await getJson(
    `${NETEASE}/song/lyric?${qs({ id: best.s.id, lv: 1, kv: 1, tv: -1 })}`,
    NETEASE_HEADERS
  );
  if (!detail || detail.nolyric || detail.uncollected) return null;
  const lrc = (detail.lrc && detail.lrc.lyric) || '';
  if (!lrc.trim()) return null;

  // Shaped like an LRCLIB record so the rest of the pipeline is provider-blind.
  return { syncedLyrics: lrc, plainLyrics: '', instrumental: false };
}

// ---- provider chain -------------------------------------------------------

// Try each enabled source in order and report WHICH one answered, so the UI can
// always tell the user where a set of lyrics came from and why.
async function resolve(track) {
  const providers = [
    { name: 'LRCLIB', enabled: config.get('features.lyricsSourceLrclib', true), run: lookup },
    { name: 'NetEase', enabled: config.get('features.lyricsSourceNetease', true), run: neteaseLookup },
  ].filter((p) => p.enabled);

  let primaryFailed = '';
  for (let i = 0; i < providers.length; i++) {
    const p = providers[i];
    try {
      const record = await p.run(track);
      if (record) {
        return {
          record,
          source: p.name,
          fallback: i > 0,
          reason: i > 0 ? primaryFailed || `No match on ${providers[0].name}` : '',
        };
      }
      if (i === 0) primaryFailed = `No match on ${p.name}`;
    } catch (err) {
      // A provider being unreachable must not stop the ones after it.
      // eslint-disable-next-line no-console
      console.error(`[lyrics] ${p.name} failed:`, err.message);
      if (i === 0) primaryFailed = `${p.name} unreachable`;
      // If every provider fails, the last error decides the message the user
      // sees, so re-throw only once nothing is left to try.
      if (i === providers.length - 1) throw err;
    }
  }
  return { record: null, source: '', fallback: false, reason: primaryFailed };
}

// ---- state machine --------------------------------------------------------

// Turn a transport failure into something the user can actually act on.
//
// The case that prompted this: a network-level web filter (safebrowse.io at the
// gateway) blocks lrclib.net. On plain HTTP it injects a 302 to a warning page;
// on HTTPS it can't, so it tears down the TLS handshake instead — which surfaces
// as ERR_SSL_* / SEC_E_INVALID_TOKEN rather than anything resembling "blocked".
// Reporting that as "could not reach the server" sends people hunting for an app
// bug when the fix is to allowlist the domain on their router.
function classifyNetworkError(msg) {
  const m = String(msg || '');
  if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/i.test(m)) {
    return {
      message: 'Can’t resolve the lyrics server — DNS lookup failed.',
      hint: 'Check your connection, or set a custom lyrics server in Settings.',
    };
  }
  if (/ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED/i.test(m)) {
    return { message: 'You appear to be offline.', hint: 'Lyrics will load once you reconnect.' };
  }
  // Electron's net stack reports net::ERR_*; SEC_E_*/schannel forms show up if a
  // request ever goes through a Windows-native path. Both mean the same thing
  // here: the handshake was torn down by something in the middle.
  if (
    /ERR_SSL|ERR_CERT|ERR_CONNECTION_CLOSED|ERR_CONNECTION_RESET|ERR_CONNECTION_ABORTED|ERR_EMPTY_RESPONSE|ERR_TUNNEL|ERR_PROXY|SEC_E_|schannel|SSL|TLS|handshake/i.test(
      m
    )
  ) {
    return {
      // Deliberately specific: a broken TLS handshake to a host that resolves
      // fine is almost always in-path filtering, not a server outage.
      message: 'The lyrics server is being blocked on this network.',
      hint:
        'lrclib.net resolves but the secure connection is cut mid-handshake — ' +
        'usually an ISP or router “safe browsing” filter. Allowlist lrclib.net ' +
        'on your gateway, or point Settings at another lyrics server.',
    };
  }
  if (/abort/i.test(m)) {
    return { message: 'The lyrics server timed out.', hint: 'It may be busy — Cadence will retry.' };
  }
  return { message: 'Lyrics lookup failed.', hint: 'See the log for details.' };
}

function keyFor(state) {
  return state.videoId || `${state.title} ${state.artist}`;
}

function toLyricsState(state, record, meta) {
  const m = meta || {};
  const base = {
    ...EMPTY_LYRICS,
    videoId: state.videoId || '',
    title: state.title || '',
    artist: state.artist || '',
    source: m.source || '',
    fallback: !!m.fallback,
    reason: m.reason || '',
  };
  if (!record) {
    return {
      ...base,
      status: LYRICS_STATUS.NOT_FOUND,
      message: 'No lyrics found for this track on any enabled source.',
    };
  }
  if (record.instrumental) {
    return { ...base, status: LYRICS_STATUS.OK, instrumental: true, message: 'Instrumental' };
  }
  const lines = parseLrc(record.syncedLyrics);
  if (lines.length) return { ...base, status: LYRICS_STATUS.OK, synced: true, lines };
  const plain = String(record.plainLyrics || '').trim();
  if (plain) {
    return {
      ...base,
      status: LYRICS_STATUS.OK,
      synced: false,
      plain,
      lines: plain.split(/\r?\n/).map((text) => ({ time: -1, text })),
      message: 'Unsynced lyrics — no timings available for this track.',
    };
  }
  return { ...base, status: LYRICS_STATUS.NOT_FOUND, message: 'No lyrics found for this track.' };
}

function remember(key, value) {
  cache.set(key, value);
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value); // FIFO trim
}

async function fetchFor(state, { bypassCache = false } = {}) {
  const key = keyFor(state);
  const mine = ++token;
  clearTimeout(retryTimer);

  if (!bypassCache && cache.has(key)) {
    hub.pushLyrics(cache.get(key));
    return;
  }

  hub.pushLyrics({
    ...EMPTY_LYRICS,
    status: LYRICS_STATUS.LOADING,
    videoId: state.videoId || '',
    title: state.title || '',
    artist: state.artist || '',
  });

  try {
    const { record, source, fallback, reason } = await resolve(state);
    if (mine !== token) return; // track changed while we were waiting
    const next = toLyricsState(state, record, { source, fallback, reason });
    remember(key, next);
    hub.pushLyrics(next);
  } catch (err) {
    if (mine !== token) return;
    // eslint-disable-next-line no-console
    console.error('[lyrics] lookup failed:', err.message);
    const { message, hint } = classifyNetworkError(err.message);
    const blocked = /blocked on this network/.test(message);
    hub.pushLyrics({
      ...EMPTY_LYRICS,
      status: LYRICS_STATUS.ERROR,
      videoId: state.videoId || '',
      title: state.title || '',
      artist: state.artist || '',
      message,
      hint,
    });
    // A filtered domain will fail identically every time — retrying just burns
    // cycles and re-flashes the error, so only transient failures get a retry.
    if (!blocked) {
      retryTimer = setTimeout(() => {
        if (active && mine === token) fetchFor(hub.latest, { bypassCache: true });
      }, RETRY_MS);
    }
  }
}

function onState(state) {
  if (!active || !config.get('features.lyricsEnabled', true)) return;
  if (!state || !state.hasSong || !state.title || state.adShowing) {
    if (currentKey !== null) {
      currentKey = null;
      token++;
      hub.pushLyrics({ ...EMPTY_LYRICS });
    }
    return;
  }
  const key = keyFor(state);
  if (key === currentKey) return;
  currentKey = key;
  fetchFor(state);
}

// Called by the lyrics window when it opens (true) and closes (false).
function setActive(on) {
  active = !!on;
  if (!active) {
    token++;
    currentKey = null;
    clearTimeout(retryTimer);
    return;
  }
  currentKey = null;
  onState(hub.latest);
}

// Manual re-lookup (the "Try again" / "Search again" button), optionally with a
// user-supplied title/artist when the automatic match is wrong.
function refetch(query) {
  if (!active) return;
  const state = hub.latest || {};
  const override = {
    ...state,
    title: (query && query.title) || state.title,
    artist: (query && query.artist) || state.artist,
    album: query && query.title ? '' : state.album, // a manual title invalidates the album match
  };
  currentKey = keyFor(state);
  fetchFor(override, { bypassCache: true });
}

function init() {
  hub.on('state', onState);
  hub._onLyricsRefetch = refetch;
  config.on('change', (cfg) => {
    if (cfg.features && cfg.features.lyricsEnabled === false && active) {
      token++;
      currentKey = null;
      hub.pushLyrics({ ...EMPTY_LYRICS, message: 'Lyrics are turned off in Settings.' });
    } else if (active && !cache.size) {
      onState(hub.latest);
    }
  });
}

module.exports = {
  init,
  setActive,
  refetch,
  parseLrc,
  cleanTitle,
  cleanArtist,
  classifyNetworkError,
};
