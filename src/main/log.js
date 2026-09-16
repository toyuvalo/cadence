'use strict';

// Persistent main-process log. The packaged app has no console, so until this
// existed a crash or a silent exit left nothing on disk: no stdout, no Event
// Log entry (Crashpad swallows what WER would have recorded), no dump. This
// mirrors console.log/warn/error to <userData>/logs/main.log and asks Electron
// to write native crash dumps locally (uploadToServer: false — nothing leaves
// the machine). Costs one appendFileSync per line, which is nothing next to the
// video decode running alongside it.

const fs = require('fs');
const path = require('path');
const { app, crashReporter } = require('electron');

const MAX_BYTES = 1024 * 1024; // rotate main.log -> main.1.log past this
let file = null;
let size = 0;

function stamp() {
  return new Date().toISOString();
}

function rotateIfNeeded() {
  if (size < MAX_BYTES) return;
  try {
    fs.renameSync(file, file.replace(/\.log$/, '.1.log'));
  } catch {
    /* a failed rotation just means the file grows a little past the cap */
  }
  size = 0;
}

function write(level, args) {
  if (!file) return;
  try {
    const text = args
      .map((a) => (a instanceof Error ? a.stack || a.message : typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ');
    const line = `${stamp()} ${level} ${text}\n`;
    fs.appendFileSync(file, line);
    size += Buffer.byteLength(line);
    rotateIfNeeded();
  } catch {
    /* logging must never take the player down */
  }
}

function init() {
  try {
    const dir = path.join(app.getPath('userData'), 'logs');
    fs.mkdirSync(dir, { recursive: true });
    file = path.join(dir, 'main.log');
    try {
      size = fs.statSync(file).size;
    } catch {
      size = 0;
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[log] could not open main.log:', err.message);
    return;
  }

  // Native crash dumps (renderer, GPU, utility and the browser process itself)
  // land in <userData>/Crashpad/. Must be called before app 'ready'.
  try {
    crashReporter.start({ submitURL: '', uploadToServer: false, compress: true });
  } catch (err) {
    write('WARN', ['[log] crashReporter.start failed:', err.message]);
  }

  for (const level of ['log', 'info', 'warn', 'error']) {
    const orig = console[level].bind(console);
    console[level] = (...args) => {
      orig(...args);
      write(level.toUpperCase(), args);
    };
  }

  // Exit paths that used to be invisible.
  process.on('uncaughtException', (err) => {
    write('FATAL', ['uncaughtException', err]);
    // Re-raise so Electron still shows its error dialog instead of hiding it.
    setImmediate(() => {
      throw err;
    });
  });
  process.on('unhandledRejection', (reason) => write('ERROR', ['unhandledRejection', reason]));
  app.on('quit', (_e, code) => write('INFO', [`app quit with code ${code}`]));
  app.on('render-process-gone', (_e, wc, details) => {
    write('ERROR', ['render-process-gone', wc && wc.getURL ? wc.getURL() : '', details]);
  });

  write('INFO', [`--- ${app.name} ${app.getVersion()} starting (pid ${process.pid}) ---`]);
}

module.exports = { init, write };
