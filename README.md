# Cadence

A resilient YouTube Music desktop client for Windows — built to stay up.

Cadence loads YouTube Music in a hardened Electron shell whose entire design
center is a **crash supervisor** that auto-recovers from the failure modes that
brick other desktop wrappers (renderer crashes, the Chromium audio-service
heap-crash, detached player hooks, and blank/aborted page loads). On top of that
it adds the integrations a good music client should have — including
**time-synced sing-along lyrics**, which no other YouTube Music desktop wrapper
ships.

## Install

Grab **`Cadence-Setup-<version>.exe`** from the
[latest release](https://github.com/toyuvalo/cadence/releases/latest) and run it.
It installs per-user (no admin needed) and adds Start menu + desktop shortcuts.

Cadence is a standalone app: closing the window sends it to the system tray and
music keeps playing. To exit fully, right-click the tray icon → **Quit Cadence**.

> `npm start` is for development only — it ties the app's lifetime to the
> terminal that launched it. For everyday listening, use the installed app.

## Why it exists

Diagnosed from a real YTMDesktop `main.log`, three unrecovered failures:

| Failure in YTMDesktop | What you saw | How Cadence handles it |
|---|---|---|
| `audio.mojom.AudioService … killed` | music "plays" but no sound | app-level audio-service handler re-syncs playback |
| `PlayerProxy error creating global callback` | media keys / now-playing go dead | bridge reads `<video>` + `mediaSession`, not Google's private player |
| `did-fail-load` / `requestStorageAccessFor: denied` | blank window | permission handler + supervisor reload with a friendly overlay |

## Features

- Crash supervisor + watchdog with automatic recovery and manual-retry fallback
- System tray with now-playing and transport controls
- Global media keys + Windows taskbar thumbnail toolbar buttons
- **Time-synced sing-along lyrics** — karaoke-style, with click-to-seek ([below](#sing-along-lyrics))
- Compact, always-on-top mini-player (seek, like, transport)
- Automatic updates — checks its own releases, installs on quit, never mid-song
- Track-change desktop notifications with album art
- Discord Rich Presence (opt-in)
- Last.fm scrobbling (opt-in; credentials via environment variables, never on disk)
- Auto-skip video ads + hide promo banners
- Restore-last-track after restart or crash
- Live settings (zoom, theme, resilience tuning, integrations)

## Sing-along lyrics

**This is the thing other YouTube Music desktop wrappers don't do.** They give you
a window, a tray icon and media keys — Cadence gives you the words, in time with
the music, so you can actually sing along.

Hit the **Lyrics** button at the bottom-right of the player and a karaoke panel
opens: the current line lit up, the next one queued, the rest dimmed, scrolling
itself as the song moves.

**How it works**

- **Source: [LRCLIB](https://lrclib.net)** — an open, community-maintained lyrics
  database. No account, no API key, no telemetry. YouTube Music's own lyrics tab
  is deliberately *not* scraped: its markup is unstable, and it carries no timing
  data at all, which is the entire point here.
- **Matching escalates four ways** — exact match on title + artist + album +
  duration, then without the album, then on cleaned strings (release clutter like
  `(Official Video)` and the `- Topic` channel suffix stripped), then a fuzzy
  search whose hits are ranked by how close their runtime is to what's actually
  playing. A live cut or a cover can't be mistaken for the studio version.
- **Timing is interpolated per animation frame.** The player bridge reports state
  about once a second — far too coarse for karaoke — so the lyrics view
  extrapolates the playhead from the last snapshot plus the wall-clock time since
  it arrived. You get smooth line-to-line highlighting without hammering the
  bridge for updates.
- **Click any line to jump to it.** `Shift`+`←`/`→` nudges the timing offset
  ±250 ms and remembers it, `A−`/`A+` sizes the text, `Space` plays/pauses,
  `Esc` closes. Scrolling by hand pauses auto-centring for a few seconds.
- Tracks with lyrics but no timings fall back to a plain scrollable sheet;
  instrumentals say so rather than showing an empty pane.
- **Lookups only run while the lyrics window is open**, and every result —
  including misses — is cached per track. The feature costs nothing when you're
  not using it.

The panel floats above Cadence but goes behind when you switch apps; flip
**Float above all apps** in Settings if you want it over everything (second
monitor, karaoke night).

> Some ISP/router "safe browsing" filters block `lrclib.net`. If lyrics report
> that the server is blocked, allowlist the domain on your gateway — or point
> **Settings → Lyrics → Lyrics server** at your own LRCLIB instance.

## Updates

Cadence checks its own GitHub releases in the background, downloads new versions,
and installs them **when you quit** — never in the middle of a song. A staged
update shows up as a pill in the toolbar and a status line in the tray menu; you
can also hit **Check now** in Settings. Turn any of it off in Settings → Updates.

## Develop

```sh
npm install
npm start          # run from source
npm run dev        # run with --dev flag
npm run dist       # build a Windows NSIS installer into ./release
```

Requires Node 20+. Built on Electron 39 (Chromium 142).

`npm run release` builds the installer and publishes it (plus the `latest.yml`
update manifest) to GitHub Releases, which is what existing installs update from.

## Architecture

```
src/
  main/                Electron main process
    main.js            orchestration, audio-service handler, close-to-tray
    supervisor.js      ★ crash recovery watchdog — the reason this app exists
    hub.js             central state fan-out + command router
    config.js          crash-proof settings store (electron-store)
    tray.js            system tray
    mediaControls.js   global shortcuts + taskbar thumbnail buttons
    updater.js         auto-update: check, download, install on quit
    windows/           main / settings / mini-player / lyrics window factories
    integrations/      notifications, discord (RPC), lastfm (scrobble),
                       lyrics (LRCLIB lookup + LRC parsing)
  preload/
    ytm-preload.js     ★ player bridge — reads <video> + mediaSession,
                       injects the bottom-right Lyrics button
    app-preload.js     contextBridge API for our own UI windows
  renderer/            shell overlay, settings UI, mini-player UI, lyrics view
  shared/constants.js  single source of truth: version, URLs, IPC contract
```

## Integrations setup

- **Discord Rich Presence** — register an app at the Discord Developer Portal and
  put its client id in Settings (`integrations.discordClientId`). Off by default.
- **Last.fm** — set `LASTFM_API_KEY`, `LASTFM_API_SECRET`, and `LASTFM_SESSION_KEY`
  as environment variables (e.g. from your secrets manager). They are never
  written to disk or config, and scrobbling stays off unless all three are set.

## License

MIT © 2026 DVLCE
