# Changelog

All notable changes to Cadence are documented here.

## [1.4.1] — 2026-08-25

### Fixed
- **The lyrics panel really does stay above Cadence only now.** 1.3.3 changed the
  default to "don't float above other apps", but that fix never reached anyone
  who had already run 1.2.0–1.3.x: `deepMerge` lets the value stored on disk win
  over the default, which is right for genuine user choices and wrong for a bad
  default. Added a one-time config migration (`state.migrationsApplied`) that
  clears the persisted `true` exactly once.
- **The Float above all apps toggle now applies immediately**, instead of only
  when the lyrics window is next opened. Turning it off re-parents the panel to
  the main window; turning it on detaches and pins it. Previously, clearing
  `alwaysOnTop` without restoring the parent could leave the panel as a plain
  window that Cadence itself covered.

## [1.4.0] — 2026-08-25

### Added
- **A second lyrics source, for the songs LRCLIB doesn't have.** Lookups now fall
  through a provider chain: **LRCLIB** first (open, purpose-built for synced
  lyrics), then **NetEase**, whose catalogue is far deeper on obscure, regional
  and non-English releases. NetEase stores standard LRC, so the existing parser
  handles it unchanged, and the same duration-proximity rule applies — a cover or
  a live cut still can't be mistaken for the studio version.
- **You always know where lyrics came from.** The source is named in the lyrics
  window footer, and when a fallback answers it gets a **`fallback` badge** whose
  tooltip says exactly why it was used ("No match on LRCLIB" / "LRCLIB
  unreachable"). Nothing is substituted silently.
- **Each source can be turned off independently** — Settings → Lyrics →
  *Source: LRCLIB* / *Source: NetEase*. Turn the fallback off and behaviour is
  exactly as before.
- A provider that is unreachable no longer stops the ones after it, so a blocked
  or rate-limited source degrades to "try the next one" instead of an error.

### Notes
- `scripts/transcribe-lyrics.py` is an **unwired experiment**, not a shipped
  feature (it isn't packaged into the installer). It downloads a track's audio
  and transcribes it locally with faster-whisper for the case where no database
  has the song. The transcription half works; the blocker is audio acquisition —
  YouTube returns HTTP 403 for unauthenticated media fetches, so it would need
  the app's own signed-in session cookies exported to a temp file for yt-dlp.
  See the README note before going further with it.

## [1.3.3] — 2026-08-24

### Changed
- **The Lyrics button moved to the bottom-right of the player**, where you'd
  expect it, and it is now **injected into the YouTube Music page** by
  `ytm-preload.js` rather than drawn in our own toolbar. It has to be: the music
  view is a `WebContentsView`, which composites *above* the host page, so the
  bottom-right of our shell is behind the player and can't be clicked. The button
  measures the player bar and sits clear of it, and is re-asserted on the same
  1 s heartbeat that re-finds the `<video>` (YTM is a SPA and re-renders regions
  on navigation).

### Fixed
- **The lyrics window no longer floats over every other application.** It was
  created with `alwaysOnTop` at the `screen-saver` level, so it sat above
  unrelated apps. It is now a **child window of the main window**: above Cadence,
  behind whatever you switch to. Floating over everything is still available, but
  it is now opt-in via Settings → Lyrics → **Float above all apps** (default off).
- **"Could not reach the lyrics service" now says what is actually wrong.**
  Transport failures are classified: DNS failure, offline, timeout, and — the
  case that prompted this — **network-level filtering**. An ISP/router "safe
  browsing" filter blocking `lrclib.net` injects an HTTP redirect to a warning
  page, but on HTTPS it can only tear down the TLS handshake, which surfaces as
  `ERR_SSL_*` / `SEC_E_INVALID_TOKEN` and looks nothing like "blocked". The UI now
  names it and tells you to allowlist the domain on your gateway. A filtered
  domain also no longer triggers the retry loop — it fails identically every time.
- **Settings → Lyrics → Lyrics server** lets you point at a self-hosted LRCLIB
  instance when the public one is unreachable.

## [1.3.0] — 2026-08-24

### Added
- **Auto-update.** Cadence now checks its own GitHub releases in the background,
  downloads new versions, and installs them **on quit** — never mid-song. This
  closes the gap that made it necessary: the installed app sat at **1.0.6 from
  2026-07-15** while the repo shipped 1.1.0 and 1.2.x, and the only symptom was a
  feature quietly not being there. (`electron-updater` 6.8.9, `build.publish` →
  GitHub provider; the public repo needs no token on the client side.)
  - A staged update surfaces as a pill in the toolbar (`Cadence x.y.z ready` →
    Restart / Later) and as a live status line in the tray menu and Settings.
    Checking and downloading stay silent by design — only a *ready* update is
    worth interrupting anyone for.
  - The pill lives inside the 40 px toolbar strip because the music view is a
    `WebContentsView` and composites **above** the host page; anything drawn
    below y=40 would be hidden behind the player.
  - New **Updates** settings group: auto-check, auto-download, install-on-quit,
    and the check interval. Running from source reports "updates apply to the
    installed app only" rather than a meaningless error.
  - First check is delayed 25 s after launch so it never competes with loading
    YTM, restoring the last track, and attaching the bridge.
- `npm run release` — build and publish the installer + `latest.yml` in one step.

### Fixed
- **Version drift, structurally.** `APP_VERSION` is now derived from
  `package.json` instead of being re-declared in `src/shared/constants.js`. The
  two had to be hand-synced after every release and silently diverged whenever
  the version was bumped in one place only — fixed by hand in `646c078` and
  `54200df`, and drifted again at 1.2.1. There is now exactly one source.

## [1.2.0] — 2026-08-24

### Added
- **Sing-along lyrics.** A new always-on-top lyrics window shows time-synced
  lyrics for the current track and highlights the line being sung, karaoke-style.
  - **Source: [LRCLIB](https://lrclib.net)** — open database, no account, no API
    key, no credentials to store. YouTube Music's own lyrics tab is deliberately
    *not* scraped: its markup is unstable and it carries no timing data.
  - **Matching** escalates through four attempts — exact match on
    title + artist + album + duration, then without the album, then on cleaned
    strings (release clutter like `(Official Video)` and the `- Topic` channel
    suffix stripped), then a fuzzy search. Search hits are ranked by duration
    proximity so a cover or live cut can't be mistaken for the studio version.
  - **Timing is interpolated per animation frame** from the last player snapshot
    (`currentTime` + elapsed wall-clock since its `ts`). The bridge only pushes
    state ~1×/s, which is far too coarse for karaoke; extrapolating gives smooth
    line-to-line highlighting without increasing the push rate.
  - Click any line to seek to it. `Shift+←` / `Shift+→` nudge the timing offset
    ±250 ms (persisted), `A−` / `A+` size the text, `Space` toggles playback,
    `Esc` closes. Hand-scrolling suspends auto-centring for 4 s.
  - Tracks with lyrics but no timings render as a plain scrollable sheet;
    instrumentals say so instead of showing an empty pane.
  - Opened from the toolbar's lyrics button, the tray menu, or an optional global
    shortcut (`shortcuts.lyrics`).
  - **Lookups only run while the lyrics window is open**, and every result —
    including misses — is cached per video id, so the feature costs no network
    traffic when unused and none on replay.
- Settings gained a **Lyrics** group: enable/disable, auto-scroll, always-on-top,
  timing offset, and text size.
- The `shortcuts.miniPlayer` accelerator is now actually registered (it was in
  the config schema but never bound).

## [1.1.0] — 2026-08-21

### Security
- **Electron `33.4.11` → `39.8.10`** (Chromium 130 → 142). This is the dedicated
  major-version upgrade deferred in 1.0.8 and it closes **47** open Dependabot
  advisories — CVE-2026-70597…70612, CVE-2026-34764…34781, and CVE-2025-55305 —
  spanning high, medium, and low severity.
- Raised the `fast-uri` `overrides` pin from `3.1.4` to `3.1.5`, closing
  CVE-2026-18446 (high). This one **is** shipped at runtime: it reaches the
  packaged `app.asar` through `electron-store → conf → ajv → fast-uri`.

### Notes
- No source changes were required for the upgrade. The main process was already
  on the modern APIs the 34→39 breaking changes target — `WebContentsView`
  (never `BrowserView`, removed in 37) and `webContents.navigationHistory`.
- The Electron 36 `app.commandLine` change lowercases switch *names*, not
  *values*, so `appendSwitch('disable-features', 'HardwareMediaKeyHandling')`
  still reaches Chromium intact and the media-key handling is unaffected.
  Verified by reading the value back at runtime under 39.8.10.
- Verified by launching the app: YTM loads and renders logged-in, the preload
  bridge attaches to `<video>`, the OS media keys drive play/pause through
  `globalShortcut`, audio plays continuously across a track change, and the
  tray, taskbar thumbnail toolbar, mini player, and settings window all work.
- `extract-zip` (CVE-2026-56876, high) has no upstream fix on the 39 line and
  stays open (dismissed as `not_used`). It is reached only via the `electron` npm
  package's install-time downloader and is **not** present in the packaged
  `app.asar`.
  A future Electron upgrade resolves it outright, but the replacement with
  `@electron-internal/extract-zip` was backported **per release line and out of
  order**, so the target must be pinned by exact version, not by major. Boundaries
  below are from an exhaustive check of all 119 stable releases in lines 39–43:
  - clean from: **`40.10.3`**, **`41.7.2`**, **`42.4.0`**, **`43.0.0`**
  - still vulnerable: all of 39.x (incl. tip `39.8.10`), `40.0.0`–`40.10.2`,
    `41.0.0`–`41.7.1`, and **`42.0.0`–`42.3.3`**

  Each line is monotonic once it turns clean, so a `^` range at or above a
  boundary is safe. Recommended target: **43.x** (`latest`, and inside Electron's
  supported window of the newest three majors). Landing anywhere in
  `42.0.0`–`42.3.3` would keep the CVE open — note that range post-dates the
  already-clean `41.7.2`, so a higher version is not necessarily a safer one.
  Verify the exact intended version with
  `npm view electron@<version> dependencies` before upgrading.

## [1.0.8] — 2026-08-03

### Security
- Bumped `electron-builder` (build-time only, not shipped in the app) from
  `25.1.8` to `26.15.7`, which pulls in patched `app-builder-lib` (26.15.0+)
  and `builder-util-runtime` (9.7.0+), resolving high-severity advisories.
- Resolved transitive `tar` and `brace-expansion` advisories via the
  `electron-builder` bump.
- Added an `overrides` pin for `fast-uri` (3.1.4) to close a host-confusion
  advisory in the `ajv` dependency chain.
- `electron` itself remains on the 33.x line pending a dedicated major-version
  upgrade with full QA — see repo security notes for the list of outstanding
  advisories that require an Electron major bump.

## [1.0.6] — 2026-07-15

### Changed
- **Minimize stays in the taskbar.** Minimizing no longer hides Cadence to the
  system tray, so the Windows taskbar-thumbnail media controls (Previous /
  Play-Pause / Next) are now reachable by hovering the taskbar button. The
  separate "Minimize to tray" setting has been removed. (This was the real
  reason the hover controls "didn't work" — a hidden window has no taskbar
  button to hover.)
- **Smarter ✕ (close) behaviour.** Pressing ✕ while music is playing now shrinks
  Cadence into the always-on-top mini player and keeps audio going; pressing ✕
  while nothing is playing quits the app for good. The "Close to tray" toggle is
  now "Shrink to mini player on close" and gates this behaviour.

### Fixed
- **Thumbnail-toolbar buttons are now applied reliably.** The prev/play-pause/
  next buttons are (re)asserted on window show / restore (plus a one-shot after
  first paint) and the icons are cached, so they no longer thrash the taskbar on
  every playback tick — only the middle button flips when play/pause changes.

### Notes
- **Thumbnail-toolbar buttons need Cadence to run at the same integrity level as
  Explorer.** If Cadence is launched *elevated* ("Run as administrator", or from
  an elevated shell), Windows UIPI blocks the (Medium-integrity) taskbar from
  delivering the button-click messages — the buttons render but do nothing.
  Launch Cadence normally (Medium integrity) and they work. This is a Windows
  security rule, not something the app can override from JavaScript.
- Added an opt-in diagnostic log: launch with the env var `CADENCE_DIAG=1` to
  append a command trace to `%TEMP%\cadence-diag.log`. No-op otherwise.

## [1.0.3] — 2026-07-02

### Added
- Back / forward buttons in a slim top toolbar (also Alt+← / Alt+→) to move
  through YouTube Music's navigation history.

### Changed
- Internal cleanup ahead of the public release; Discord Rich Presence now uses a
  user-supplied application id (none is bundled).

## [1.0.2] — 2026-07-02

### Fixed
- **Music view revealed only after it's loaded.** The YouTube Music view now
  stays hidden behind the animated loading overlay until `did-finish-load`, so
  the app no longer shows a half-loaded, non-interactive page where clicks don't
  register on launch. The animated logo (pulsing equalizer mark) now shows during
  startup, not just during crash recovery.

### Notes
- The Windows app/taskbar icon shows the default Electron logo only when running
  from source (`npm start`) — the packaged NSIS installer embeds `icon.ico`, so
  the installed app displays the Cadence icon correctly.

## [1.0.1] — 2026-06-30

### Fixed
- **Google sign-in "This browser or app may not be secure".** YouTube Music
  browsing still presents a spoofed Chrome UA, but requests to Google's auth
  domains (`accounts.google.com` / `.youtube.com` / `.google.ca`) now revert to
  the genuine, self-consistent Electron User-Agent via `onBeforeSendHeaders`.
  Google's secure-browser check blocks a UA that's inconsistent with the real
  client-hints; presenting the honest UA for the login flow passes it. (Same
  approach as th-ch/youtube-music.)

## [1.0.0] — 2026-06-30

Initial release. A resilient YouTube Music desktop client built to survive the
exact failure modes that brick YTMDesktop.

### Resilience (the reason this exists)
- **Crash supervisor** auto-recovers from `render-process-gone`, `unresponsive`,
  and fatal `did-fail-load` with exponential backoff and a manual-retry fallback.
- **Audio-service recovery** — handles the `audio.mojom.AudioService` heap-crash
  (`child-process-gone`) that silently kills sound in YTMDesktop, and re-syncs
  playback automatically.
- **Watchdog** detects a hung/blank renderer or a detached player bridge and
  revives it instead of leaving a dead window.
- **Player bridge reads ground truth** — the `<video>` element +
  `navigator.mediaSession` (stable APIs), not YouTube Music's private player
  object, so a YTM frontend change can't detach controls.
- **Permission handler** grants the storage-access/media permissions YTM needs,
  eliminating the repeated `requestStorageAccessFor: Permission denied` errors.
- Corrupt settings, missing icons, and dead integration pipes can never crash
  startup (defensive fallbacks throughout).

### Features
- System tray with now-playing + transport controls.
- Global media keys (configurable accelerators) + Windows taskbar thumbnail
  toolbar buttons; native SMTC now-playing card comes free via MediaSession.
- Compact, always-on-top **mini-player** with seek + like.
- Track-change desktop notifications with album art.
- Discord Rich Presence (opt-in; bring your own Discord app id).
- Last.fm scrobbling (opt-in; credentials injected at runtime from OneCLI — never
  stored on disk).
- Auto-skip / fast-forward video ads + hide promo banners.
- Restore-last-track after restart or crash.
- Live settings window (zoom, theme, resilience tuning, integrations).
