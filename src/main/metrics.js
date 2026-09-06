'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { app } = require('electron');

// Opt-in performance sampler (CADENCE_METRICS=1). Exists so a claim like
// "this change reduced idle CPU" can be checked instead of asserted.
//
// Appends one CSV row per sample to <tmp>/cadence-metrics.csv:
//   iso,elapsedSec,type,pid,cpuPercent,workingSetMB,label
//
// Notes on the numbers:
//   • cpuPercent comes from app.getAppMetrics() and is Chromium's own
//     accounting, expressed per single CPU core — it can exceed 100 on a
//     multi-core box.
//   • workingSetMB is memory.workingSetSize (reported in KB). privateBytes
//     would be the better figure — it does not double-count the pages Chromium
//     shares between its processes — but Electron 44 no longer populates it
//     (measured: it reports 0.0-0.4MB per process, which is obviously not
//     real). So treat the SUM of this column as an upper bound on real usage,
//     and only ever compare it against another run measured the same way.
//
// Compare runs with the same label in the same state (foreground / minimized /
// lyrics open) on the same track — anything else is noise.

const SAMPLE_MS = 5000;

let timer = null;
let startedAt = 0;
let outPath = '';

function label() {
  return process.env.CADENCE_METRICS_LABEL || 'unlabelled';
}

function sample() {
  let rows;
  try {
    rows = app.getAppMetrics();
  } catch {
    return; // metrics are diagnostics; never let them affect the app
  }
  const iso = new Date().toISOString();
  const elapsed = Math.round((Date.now() - startedAt) / 1000);
  const lines = rows.map((m) => {
    const cpu = m.cpu && typeof m.cpu.percentCPUUsage === 'number' ? m.cpu.percentCPUUsage : 0;
    const wsKb = m.memory && typeof m.memory.workingSetSize === 'number' ? m.memory.workingSetSize : 0;
    return [
      iso,
      elapsed,
      m.type || '?',
      m.pid,
      cpu.toFixed(2),
      (wsKb / 1024).toFixed(1),
      label(),
    ].join(',');
  });
  try {
    fs.appendFileSync(outPath, lines.join('\n') + '\n');
  } catch {
    /* disk trouble must not take the player down */
  }
}

function init() {
  if (process.env.CADENCE_METRICS !== '1') return;
  outPath = path.join(os.tmpdir(), 'cadence-metrics.csv');
  startedAt = Date.now();
  try {
    if (!fs.existsSync(outPath)) {
      fs.writeFileSync(outPath, 'iso,elapsedSec,type,pid,cpuPercent,workingSetMB,label\n');
    }
  } catch {
    return;
  }
  timer = setInterval(sample, SAMPLE_MS);
  if (timer.unref) timer.unref();
  // eslint-disable-next-line no-console
  console.log(`[metrics] sampling every ${SAMPLE_MS}ms -> ${outPath} (label="${label()}")`);
}

function stop() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

module.exports = { init, stop };
