# Cadence lyrics mirror

A Cloudflare Worker that mirrors the [LRCLIB](https://lrclib.net) lookup API for
Cadence users whose network blocks `lrclib.net`.

## Why

Some networks filter `lrclib.net` — ISP "safe browsing" / "advanced security"
products, router content filters, DNS blockers. The failure is misleading: DNS
still resolves to the correct address, plain HTTP gets a `302` to a warning
page, and HTTPS has its TLS handshake torn down mid-flight. The client sees
`ERR_SSL_*` / `SEC_E_INVALID_TOKEN`, which looks like a certificate bug rather
than a policy decision.

Requests to this mirror carry a different hostname, so a filter matching on the
SNI has nothing to match on.

**Allowlisting `lrclib.net` is the better fix**, and the one Cadence recommends
first — one change, every app on the network benefits, nothing sits between the
user and LRCLIB. This exists for the cases where that isn't possible: managed
corporate or campus networks, ISP filters with no self-serve allowlist, or a
filter whose allowlist grant silently expires.

## Design constraints

- **Read-only.** `GET`/`HEAD` only, and only `/get`, `/get-cached` and `/search`.
  LRCLIB's `/publish` and every other path are refused, not forwarded. This is
  deliberately *not* a general-purpose open proxy — an unrestricted one would be
  abused quickly and get the hostname blocklisted itself, defeating the point.
- **Edge-cached**, 24h for a hit and 1h for a miss. LRCLIB is a free,
  donation-funded community service; identical lookups collapse to one upstream
  request per PoP per TTL rather than being forwarded verbatim.
- **Anonymous.** A fresh request is constructed upstream with only a
  `User-Agent` and `Accept`. No client headers, cookies, auth or IP are
  forwarded, and nothing is logged or stored. The mirror sees a track title and
  an artist name; it has no idea who asked.
- **Response-shape identical to LRCLIB's**, so the client's provider code is
  unaware it is talking to a mirror.

## Endpoints

| Path | Behaviour |
|---|---|
| `/` | Service description JSON (this hostname will get pasted into browsers). |
| `/health` | `{"ok":true}` |
| `/api/get` | Proxies `https://lrclib.net/api/get` |
| `/api/search` | Proxies `https://lrclib.net/api/search` |
| anything else | `404` |

A bare `/get` / `/search` works too, so the mirror is valid whether configured
as `https://host/api` or `https://host`.

`X-Cadence-Cache: HIT|MISS` reports the edge cache outcome. A `404` from LRCLIB
(a clean "no such track") passes through as a `404` so the client can tell "no
lyrics exist" from "the lookup failed".

## Deploy

```sh
wrangler deploy
```

Bound to `lyrics.dvlce.ca` as a custom domain (see `wrangler.toml`).

## Verify

```sh
curl -s "https://lyrics.dvlce.ca/api/search?track_name=Creep&artist_name=Radiohead" | head -c 200
curl -sI "https://lyrics.dvlce.ca/api/search?track_name=Creep&artist_name=Radiohead" | grep X-Cadence-Cache
curl -so /dev/null -w '%{http_code}\n' -X POST "https://lyrics.dvlce.ca/api/get"   # 405
curl -so /dev/null -w '%{http_code}\n' "https://lyrics.dvlce.ca/api/publish"       # 404
```
