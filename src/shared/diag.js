'use strict';

// Opt-in, zero-cost-when-off diagnostic log. Enabled only when the app is
// launched with CADENCE_DIAG=1 in its environment; writes one line per event to
// <tmp>/cadence-diag.log. Safe in every process (main, preload) — it only ever
// touches fs when explicitly enabled, and never throws into the caller.

const DIAG = process.env.CADENCE_DIAG === '1';

let file = null;
function target() {
  if (file) return file;
  try {
    file = require('path').join(require('os').tmpdir(), 'cadence-diag.log');
  } catch {
    file = null;
  }
  return file;
}

function diag(msg) {
  if (!DIAG) return;
  try {
    const f = target();
    if (f) require('fs').appendFileSync(f, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {
    /* diagnostics must never affect the app */
  }
}

module.exports = { diag, DIAG };
