# Cadence

A resilient YouTube Music desktop client for Windows — built to stay up.

Cadence loads YouTube Music in a hardened Electron shell whose entire design
center is a **crash supervisor** that auto-recovers from the failure modes that
brick other desktop wrappers (renderer crashes, the Chromium audio-service
heap-crash, detached player hooks, and blank/aborted page loads). On top of that
it adds the integrations a good music client should have.

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
- Compact, always-on-top mini-player (seek, like, transport)
- Track-change desktop notifications with album art
- Discord Rich Presence (opt-in)
- Last.fm scrobbling (opt-in; credentials via environment variables, never on disk)
- Auto-skip video ads + hide promo banners
- Restore-last-track after restart or crash
- Live settings (zoom, theme, resilience tuning, integrations)

## Develop

```sh
npm install
npm start          # run from source
npm run dev        # run with --dev flag
npm run dist       # build a Windows NSIS installer into ./release
```

Requires Node 20+. Built on Electron 33 (Chromium 130).

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
    windows/           main / settings / mini-player window factories
    integrations/      notifications, discord (RPC), lastfm (scrobble)
  preload/
    ytm-preload.js     ★ player bridge — reads <video> + mediaSession
    app-preload.js     contextBridge API for our own UI windows
  renderer/            shell overlay, settings UI, mini-player UI
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
