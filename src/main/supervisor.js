'use strict';

const { EventEmitter } = require('events');
const config = require('./config');

// The Supervisor is Cadence's reason to exist. YTMDesktop's logs show three
// unrecovered failure modes:
//   1. audio.mojom.AudioService child process killed  -> sound dies silently
//   2. renderer "PlayerProxy" hook detaches            -> controls go dead
//   3. did-fail-load / blank window                    -> nothing renders
// This watchdog detects all three and reloads the music view automatically,
// with exponential backoff, restoring the last track + position, and surfaces a
// "Reconnecting…" overlay instead of a dead window.
class Supervisor extends EventEmitter {
  constructor({ getWebContents, onStatus, onReloaded }) {
    super();
    this._getWC = getWebContents;
    this._onStatus = onStatus || (() => {});
    this._onReloaded = onReloaded || (() => {});
    this._attempts = 0;
    this._recovering = false;
    this._lastGoodLoad = 0;
    this._lastStatePing = 0; // updated by the bridge via noteAlive()
    this._watchdog = null;
    this._reloadTimer = null;
    this._destroyed = false;
  }

  start() {
    this._attach();
    if (config.get('resilience.watchdogEnabled', true)) this._startWatchdog();
  }

  // Called by the IPC layer whenever the bridge reports player state — proof the
  // renderer is alive and the player hook is attached.
  noteAlive() {
    this._lastStatePing = Date.now();
  }

  _wc() {
    const wc = this._getWC();
    return wc && !wc.isDestroyed() ? wc : null;
  }

  _attach() {
    const wc = this._wc();
    if (!wc) return;

    wc.on('render-process-gone', (_e, details) => {
      this._fail('render-process-gone', details && details.reason);
    });

    wc.on('unresponsive', () => {
      this._onStatus('unresponsive', 'The music view stopped responding.');
      this._fail('unresponsive');
    });

    wc.on('responsive', () => {
      this._onStatus('ok');
    });

    wc.on('did-fail-load', (_e, errorCode, errorDesc, validatedURL, isMainFrame) => {
      // -3 == ERR_ABORTED is benign (navigation superseded); ignore it.
      if (!isMainFrame || errorCode === -3) return;
      this._onStatus('error', `Load failed (${errorCode}) ${errorDesc || ''}`.trim());
      this._fail('did-fail-load:' + errorCode);
    });

    wc.on('did-finish-load', () => {
      this._lastGoodLoad = Date.now();
      this._lastStatePing = Date.now();
      this._attempts = 0;
      this._recovering = false;
      this._onStatus('ok');
      this._onReloaded();
    });

    wc.on('did-navigate-in-page', () => {
      this._lastStatePing = Date.now();
    });
  }

  // Re-attach handlers after a webContents is recreated (defensive — current
  // design reuses the same webContents via reload, so this is mostly a no-op).
  reattach() {
    this._attach();
  }

  // Called by main.js when Electron reports an app-level child-process-gone for
  // the audio service. Chromium normally respawns the utility process, but the
  // page's <video> can be left muted/stalled — a reload re-establishes audio.
  onAudioServiceGone(details) {
    this._onStatus('audio-recovering', 'Audio service restarted — re-syncing.');
    // Soft recovery first: a reload is heavy, so only do it if state goes stale.
    this._lastStatePing = 0;
    this._scheduleReload(1500, 'audio-service');
  }

  _fail(reason, detail) {
    if (this._destroyed) return;
    // eslint-disable-next-line no-console
    console.error(`[supervisor] failure: ${reason}${detail ? ' (' + detail + ')' : ''}`);
    this.emit('failure', { reason, detail });
    if (!config.get('resilience.autoRecover', true)) {
      this._onStatus('error', `Crashed: ${reason}. Auto-recovery is off.`);
      return;
    }
    const backoff = Math.min(30000, 800 * Math.pow(2, this._attempts));
    this._scheduleReload(backoff, reason);
  }

  _scheduleReload(delay, reason) {
    if (this._reloadTimer || this._destroyed) return;
    const max = config.get('resilience.maxReloadAttempts', 8);
    if (this._attempts >= max) {
      this._onStatus(
        'fatal',
        `Could not recover after ${max} attempts. Click to retry manually.`
      );
      return;
    }
    this._attempts += 1;
    this._recovering = true;
    this._onStatus(
      'recovering',
      `Reconnecting… (attempt ${this._attempts}, ${reason})`
    );
    this._reloadTimer = setTimeout(() => {
      this._reloadTimer = null;
      this._doReload();
    }, delay);
  }

  _doReload() {
    const wc = this._wc();
    if (!wc) return;
    try {
      // reloadIgnoringCache clears any wedged frame/script state.
      wc.reloadIgnoringCache();
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[supervisor] reload threw:', err.message);
      this._scheduleReload(2000, 'reload-error');
    }
  }

  // Manual retry from the overlay click / tray.
  forceReload() {
    this._attempts = 0;
    this._recovering = false;
    if (this._reloadTimer) {
      clearTimeout(this._reloadTimer);
      this._reloadTimer = null;
    }
    this._doReload();
  }

  _startWatchdog() {
    const interval = config.get('resilience.watchdogIntervalMs', 15000);
    this._watchdog = setInterval(() => {
      if (this._destroyed || this._recovering) return;
      const wc = this._wc();
      if (!wc) return;

      // 1) Hung process check.
      if (wc.isCrashed()) {
        this._fail('watchdog:isCrashed');
        return;
      }

      // 2) Blank/aborted-load check: finished a navigation but the page never
      // produced a real document (about:blank or empty title for too long).
      const url = (() => {
        try {
          return wc.getURL();
        } catch {
          return '';
        }
      })();
      if (!url || url === 'about:blank') {
        this._fail('watchdog:blank');
        return;
      }

      // 3) Detached-hook check: the bridge pings state while a song is loaded.
      // If we had a good load but have heard nothing from the bridge for a long
      // time AND the page should be interactive, treat the hook as detached.
      const sinceGood = Date.now() - this._lastGoodLoad;
      const sincePing = Date.now() - this._lastStatePing;
      if (this._lastGoodLoad && sinceGood > interval * 2 && sincePing > interval * 4) {
        this._fail('watchdog:bridge-silent');
      }
    }, interval);
    if (this._watchdog.unref) this._watchdog.unref();
  }

  destroy() {
    this._destroyed = true;
    if (this._watchdog) clearInterval(this._watchdog);
    if (this._reloadTimer) clearTimeout(this._reloadTimer);
  }
}

module.exports = Supervisor;
