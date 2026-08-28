/**
 * Cadence lyrics proxy — a thin, cached, read-only mirror of the LRCLIB API.
 *
 * WHY THIS EXISTS
 * ---------------
 * Some networks block `lrclib.net` outright. The common culprits are ISP
 * "safe browsing" / "advanced security" products and router-level web filters,
 * which flag it as an uncategorised or high-risk domain. The block is
 * unhelpfully invisible: DNS still resolves to the correct address, plain HTTP
 * gets a 302 to a warning page, and HTTPS simply has its TLS handshake torn
 * down mid-flight. The client sees `ERR_SSL_*` / `SEC_E_INVALID_TOKEN`, which
 * looks exactly like a certificate bug rather than a policy decision.
 *
 * Allowlisting `lrclib.net` on the filter is the better fix and the one Cadence
 * recommends first — it is one change, it helps every app on the network, and
 * it keeps traffic between the user and LRCLIB with nothing in between. This
 * proxy exists for the cases where that isn't possible: managed corporate or
 * campus networks, ISP filters with no self-serve allowlist, or a filter whose
 * allowlist grant silently expires.
 *
 * Because requests arrive over a different hostname, the filter never sees the
 * `lrclib.net` SNI and has nothing to match on.
 *
 * DESIGN CONSTRAINTS
 * ------------------
 *   • Read-only. GET/HEAD only, and only the two LRCLIB lookup endpoints. This
 *     is deliberately NOT a general-purpose open proxy — an unrestricted one
 *     would be abused within days and get the hostname blocklisted itself,
 *     which would defeat the entire point.
 *   • Cached hard at the edge. LRCLIB is a free, donation-funded community
 *     service; a mirror that forwarded every keystroke would be a burden on it.
 *     Identical lookups collapse to one upstream request per PoP per TTL.
 *   • Anonymous. Client IPs, cookies and auth headers are never forwarded
 *     upstream, and nothing is logged or stored. The proxy sees a track title
 *     and an artist name; it has no idea who asked.
 *   • Response-shape identical to LRCLIB's, so Cadence's provider code is
 *     completely unaware it is talking to a mirror.
 */

const UPSTREAM = 'https://lrclib.net/api';

// The only upstream endpoints Cadence uses. Anything else is refused rather
// than forwarded — see the "not an open proxy" constraint above.
const ALLOWED_ENDPOINTS = new Set(['get', 'search', 'get-cached']);

// LRCLIB asks clients to identify themselves so maintainers can contact the
// author of a misbehaving app instead of blanket-blocking it. Honour that.
const UPSTREAM_UA = 'Cadence-LyricsProxy/1.0.0 (+https://github.com/toyuvalo/cadence)';

// Lyrics for a released track effectively never change. A long TTL is both
// kinder to upstream and faster for the user.
const CACHE_TTL_SECONDS = 60 * 60 * 24; // 24h for a hit
const CACHE_TTL_404 = 60 * 60; // 1h for a miss — a track may gain lyrics later

// A lookup is a track title + artist. Anything substantially longer is not a
// real query, so it is refused before it can reach upstream.
const MAX_QUERY_BYTES = 512;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, User-Agent',
  'Access-Control-Max-Age': '86400',
};

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...CORS,
      ...extraHeaders,
    },
  });
}

/**
 * Accepts both `/api/<endpoint>` and a bare `/<endpoint>`, so the mirror works
 * whether it is configured as `https://host/api` or `https://host`.
 */
function endpointFrom(pathname) {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length && parts[0] === 'api') parts.shift();
  if (parts.length !== 1) return null;
  return parts[0];
}

export default {
  async fetch(request, _env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return json({ error: 'This mirror is read-only. Use GET.' }, 405);
    }

    // A human (or a health check) hitting the root gets an explanation rather
    // than a bare 404 — this hostname will end up pasted into browsers.
    if (url.pathname === '/' || url.pathname === '/api' || url.pathname === '/api/') {
      return json({
        service: 'Cadence lyrics mirror',
        purpose:
          'A cached, read-only mirror of the LRCLIB API, for networks whose web filter blocks lrclib.net.',
        recommendation:
          'Prefer allowlisting lrclib.net on your network filter and using LRCLIB directly. This mirror is the fallback.',
        upstream: 'https://lrclib.net',
        endpoints: ['/api/get', '/api/search'],
        notes: 'Read-only. No logging. Client IPs and cookies are not forwarded upstream.',
      });
    }

    if (url.pathname === '/health') {
      return json({ ok: true });
    }

    const endpoint = endpointFrom(url.pathname);
    if (!endpoint || !ALLOWED_ENDPOINTS.has(endpoint)) {
      return json(
        {
          error: 'Unsupported endpoint.',
          supported: ['/api/get', '/api/search'],
        },
        404
      );
    }

    if (url.search.length > MAX_QUERY_BYTES) {
      return json({ error: 'Query too long.' }, 414);
    }

    const upstreamUrl = `${UPSTREAM}/${endpoint}${url.search}`;

    // Cache on the upstream URL, NOT the inbound request: that way the cache is
    // shared across every client regardless of which host spelling they used,
    // and no client-specific header can fragment it.
    const cacheKey = new Request(upstreamUrl, { method: 'GET' });
    const cache = caches.default;

    const cached = await cache.match(cacheKey);
    if (cached) {
      const out = new Response(cached.body, cached);
      out.headers.set('X-Cadence-Cache', 'HIT');
      for (const [k, v] of Object.entries(CORS)) out.headers.set(k, v);
      return out;
    }

    let upstreamRes;
    try {
      // A fresh Request with ONLY the headers we choose. Nothing from the
      // client — no cookies, no auth, no forwarded IP — reaches LRCLIB.
      upstreamRes = await fetch(upstreamUrl, {
        method: 'GET',
        headers: {
          'User-Agent': UPSTREAM_UA,
          Accept: 'application/json',
        },
      });
    } catch (err) {
      return json(
        {
          error: 'Could not reach the upstream lyrics database.',
          detail: String(err && err.message ? err.message : err),
        },
        502
      );
    }

    // 404 is LRCLIB's clean "no such track" and must pass through as-is so the
    // client can tell "no lyrics exist" apart from "the lookup failed".
    if (upstreamRes.status === 404) {
      const miss = json({ error: 'Not found' }, 404, {
        'Cache-Control': `public, max-age=${CACHE_TTL_404}`,
        'X-Cadence-Cache': 'MISS',
      });
      ctx.waitUntil(cache.put(cacheKey, miss.clone()));
      return miss;
    }

    if (!upstreamRes.ok) {
      return json(
        { error: `Upstream returned HTTP ${upstreamRes.status}.` },
        upstreamRes.status === 429 ? 429 : 502
      );
    }

    const body = await upstreamRes.text();
    const res = new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}`,
        'X-Cadence-Cache': 'MISS',
        ...CORS,
      },
    });

    ctx.waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  },
};
