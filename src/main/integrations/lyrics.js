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
  LYRICS_DEFAULT_API,
} = require('../../shared/constants');

const DEFAULT_API = LYRICS_DEFAULT_API;

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

// NetEase ships production credits as real timestamped LRC lines at ~00:00 —
// `[00:00.05] 编曲 : Queen`, `[00:01.30]Writers：…`. They are indistinguishable
// from lyrics to a parser, so without this the first thing you see on an English
// track is a screen of Chinese credit labels.
const NETEASE_CREDIT =
  /^(?:作词|作曲|编曲|制作人|出品人|出品|发行|监制|混音|母带|录音|和声|配唱|吉他|贝斯|鼓|键盘|弦乐|策划|统筹|企划|词|曲|OP|SP|Produced\s+by|Producer|Writers?|Composer|Lyricist|Arranger|Mixing|Mastering|Samples?|Vocals?|Recorded|Engineer)\s*[:：]/i;

// A `Samples：` block continues over unlabelled lines — `Stomp(1996)—Three 6
// Mafia`. Only ever applied inside the leading credit block.
const NETEASE_CREDIT_CONT = /\(\d{4}\)\s*[—–-]/;

// Karaoke / instrumental / tribute farms upload renditions whose runtime tracks
// the original to within a second or two, so a duration-only match picks them
// happily. Reject them — unless the user is genuinely playing one.
const NETEASE_IMPOSTOR =
  /\b(instrumental|karaoke|backing track|originally performed|made popular by|tribute|in the style of)\b/i;

// Strip credits from the TOP of an LRC only. A colon later in a song is far more
// likely to be a real lyric than a credit, so the scan stops at the first line
// that doesn't look like one.
function stripNeteaseCredits(raw) {
  const lines = String(raw || '').split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const text = lines[i].replace(/\[[^\]]*\]/g, '').trim();
    if (text === '' || NETEASE_CREDIT.test(text) || NETEASE_CREDIT_CONT.test(text)) { i++; continue; }
    break;
  }
  return lines.slice(i).join('\n');
}

const normName = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9一-鿿]+/g, '');

// Loose containment both ways: "Travis Scott" should match "Travis Scott", and
// a NetEase entry crediting "Travis Scott, Drake" should match "Travis Scott".
function neteaseArtistMatches(song, wantArtist) {
  const want = normName(wantArtist);
  if (!want) return false;
  return (song.artists || []).some((a) => {
    const n = normName(a.name);
    return n && (n.includes(want) || want.includes(n));
  });
}

async function neteaseLookup(track) {
  const query = `${cleanTitle(track.title)} ${cleanArtist(track.artist)}`.trim();
  if (!query) return null;

  const found = await getJson(
    `${NETEASE}/search/get?${qs({ s: query, type: 1, limit: 8, offset: 0 })}`,
    NETEASE_HEADERS
  );
  const songs = (found && found.result && found.result.songs) || [];
  if (!songs.length) return null;

  const wantTitle = cleanTitle(track.title);
  const wantArtist = cleanArtist(track.artist);
  const wanted = track.duration > 0 ? Math.round(track.duration) : 0;
  // Only treat "instrumental"/"karaoke" as disqualifying if the track being
  // played isn't itself one.
  const wantsImpostor = NETEASE_IMPOSTOR.test(`${wantTitle} ${wantArtist}`);

  const scored = songs
    .filter((s) => {
      if (wantsImpostor) return true;
      const label = `${s.name} ${(s.artists || []).map((a) => a.name).join(' ')}`;
      return !NETEASE_IMPOSTOR.test(label);
    })
    .map((s) => ({
      s,
      delta: wanted && s.duration ? Math.abs(s.duration / 1000 - wanted) : 999,
      artistOk: neteaseArtistMatches(s, wantArtist),
    }))
    // Duration proximity alone will pick a same-length unrelated track, so a
    // real artist match outranks a marginally closer runtime.
    .sort((a, b) => (a.artistOk === b.artistOk ? a.delta - b.delta : a.artistOk ? -1 : 1));

  const best = wanted ? scored.find((c) => c.delta <= 15) : scored[0];
  if (!best) return null;

  const detail = await getJson(
    `${NETEASE}/song/lyric?${qs({ id: best.s.id, lv: 1, kv: 1, tv: -1 })}`,
    NETEASE_HEADERS
  );
  if (!detail || detail.nolyric || detail.uncollected) return null;
  const lrc = stripNeteaseCredits((detail.lrc && detail.lrc.lyric) || '');
  // Credits-only entries exist (instrumentals with production notes). After the
  // strip there is nothing to sing, so report a miss rather than a blank pane.
  if (!lrc.trim()) return null;

  // Shaped like an LRCLIB record so the rest of the pipeline is provider-blind.
  return { syncedLyrics: lrc, plainLyrics: '', instrumental: false };
}

// ---- provider chain -------------------------------------------------------

// Try each enabled source in order and report WHICH one answered, so the UI can
// always tell the user where a set of lyrics came from and why.
async function resolve(track) {
  // Name the LRCLIB provider for where it is actually pointed, so a user on a
  // mirror or a self-hosted instance can always see that from the source badge
  // rather than wondering why "LRCLIB" is answering on a network that blocks it.
  const lrclibName = apiBase() === DEFAULT_API ? 'LRCLIB' : 'LRCLIB (mirror)';
  const providers = [
    { name: lrclibName, enabled: config.get('features.lyricsSourceLrclib', true), run: lookup },
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
// The case that prompted this: a network-level "safe browsing" web filter
// blocks lrclib.net. On plain HTTP it injects a 302 to a warning page; on HTTPS
// it can't, so it tears down the TLS handshake instead — which surfaces as
// ERR_SSL_* / SEC_E_INVALID_TOKEN rather than anything resembling "blocked".
// DNS stays clean throughout, so the domain resolves perfectly and then simply
// refuses to connect. Reporting that as "could not reach the server" sends
// people hunting for an app bug when the fix is a one-line allowlist entry.
function classifyNetworkError(msg) {
  const m = String(msg || '');
  if (/ERR_NAME_NOT_RESOLVED|ENOTFOUND|EAI_AGAIN/i.test(m)) {
    // A filter that works at the DNS layer looks exactly like this too, so the
    // same walkthrough applies — the domain just needs to be allowed through.
    return {
      code: 'blocked',
      message: 'Can’t resolve the lyrics server — the lookup was refused.',
      hint: 'Usually a DNS-level filter (router, Pi-hole/AdGuard, or your ISP).',
    };
  }
  if (/ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED/i.test(m)) {
    return {
      code: 'offline',
      message: 'You appear to be offline.',
      hint: 'Lyrics will load once you reconnect.',
    };
  }
  // Electron's net stack reports net::ERR_*; SEC_E_*/schannel forms show up if a
  // request ever goes through a Windows-native path. Both mean the same thing
  // here: the handshake was torn down by something in the middle.
  // The list is long on purpose: the SAME block surfaces with wildly different
  // wording depending on which stack reports it. Chromium says `ERR_SSL_*`,
  // Windows/schannel says `SEC_E_INVALID_TOKEN` or "corrupted frame was
  // received", and a POSIX socket just says "broken pipe" / ECONNRESET. Every
  // one of these was observed from a single filtered domain on one network.
  if (
    /ERR_SSL|ERR_CERT|ERR_CONNECTION_CLOSED|ERR_CONNECTION_RESET|ERR_CONNECTION_ABORTED|ERR_EMPTY_RESPONSE|ERR_TUNNEL|ERR_PROXY|ERR_QUIC|SEC_E_|schannel|SSL|TLS|handshake|corrupted frame|frame size|broken pipe|ECONNRESET|EPIPE/i.test(
      m
    )
  ) {
    return {
      // Deliberately specific: a broken TLS handshake to a host that resolves
      // fine is almost always in-path filtering, not a server outage.
      code: 'blocked',
      message: 'The lyrics server is being blocked on this network.',
      hint:
        'The connection is cut mid-handshake, which is what a “safe browsing” ' +
        'filter looks like — not a problem with Cadence or with the server.',
    };
  }
  if (/abort/i.test(m)) {
    return {
      code: 'timeout',
      message: 'The lyrics server timed out.',
      hint: 'It may be busy — Cadence will retry.',
    };
  }
  return { code: 'unknown', message: 'Lyrics lookup failed.', hint: 'See the log for details.' };
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
    const { code, message, hint } = classifyNetworkError(err.message);
    const blocked = code === 'blocked';
    hub.pushLyrics({
      ...EMPTY_LYRICS,
      status: LYRICS_STATUS.ERROR,
      videoId: state.videoId || '',
      title: state.title || '',
      artist: state.artist || '',
      code,
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
  stripNeteaseCredits,
  neteaseArtistMatches,
};
