# Changelog

All notable changes to Cadence are documented here.

## [1.0.5] — 2026-07-15

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
