/* global require, setTimeout, setInterval, clearInterval */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Loads supervisor.js with ./config stubbed so no electron / electron-store is
// needed. Returns the class plus the stubbed values it will read.
function loadSupervisor(overrides) {
  const supervisorPath = require.resolve('../src/main/supervisor');
  const configPath = require.resolve('../src/main/config');
  const originalLoad = Module._load;
  const values = { 'resilience.watchdogIntervalMs': 10, ...overrides };
  Module._load = function (request, parent, ...rest) {
    if (parent && parent.filename === supervisorPath && request === './config') {
      return { get: (key, def) => (key in values ? values[key] : def) };
    }
    return originalLoad.call(this, request, parent, ...rest);
  };
  delete require.cache[supervisorPath];
  delete require.cache[configPath];
  try {
    return require(supervisorPath);
  } finally {
    Module._load = originalLoad;
  }
}

function makeWorld() {
  const handlers = {};
  const wc = {
    isDestroyed: () => false,
    isCrashed: () => false,
    getURL: () => 'https://music.youtube.com/',
    reloadIgnoringCache: () => {},
    on: (evt, fn) => {
      handlers[evt] = fn;
    },
  };
  const win = { isDestroyed: () => false, isMinimized: () => false, isVisible: () => true };
  const statuses = [];
  return { handlers, wc, win, statuses };
}

for (const replaceWebContents of [false, true]) {
  test(`recovery completes despite beforeunload on ${replaceWebContents ? 'replacement' : 'initial'} webContents`, (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const Supervisor = loadSupervisor({ 'resilience.watchdogEnabled': false });
    let world = makeWorld();
    const statuses = [];
    let reloaded = 0;
    const sup = new Supervisor({
      getWebContents: () => world.wc,
      onStatus: (status) => statuses.push(status),
      onReloaded: () => { reloaded += 1; },
    });
    t.after(() => sup.destroy());
    sup.start();
    if (replaceWebContents) {
      world = makeWorld();
      sup.reattach();
    }

    let reloadRequests = 0;
    world.wc.reloadIgnoringCache = () => {
      reloadRequests += 1;
      // Model Electron cancelling the unload unless the supervisor overrides it.
      let allowed = false;
      world.handlers['will-prevent-unload']?.({
        preventDefault() { allowed = true; },
      });
      if (allowed) world.handlers['did-finish-load']();
    };

    for (let attempt = 1; attempt <= 2; attempt += 1) {
      world.handlers['render-process-gone']({}, { reason: 'crashed' });
      assert.equal(statuses.at(-1), 'recovering');
      t.mock.timers.tick(30000);
      assert.equal(reloadRequests, attempt, 'recovery requests one reload');
      assert.equal(reloaded, attempt, 'beforeunload must allow a completed load');
      assert.equal(statuses.at(-1), 'ok', 'a completed load clears the recovery overlay');
    }
  });
}

test('watchdog ignores a silent bridge while the page reports itself hidden', (t) => {
  // Mock clock: with real sleeps the 25 ms "grace" step could overrun the
  // 40 ms threshold on a loaded machine and fail about one run in five.
  // Non-zero start: the supervisor treats a _lastGoodLoad of 0 as "never loaded".
  t.mock.timers.enable({ apis: ['setInterval', 'Date'], now: 1_000_000 });
  const sleep = (ms) => t.mock.timers.tick(ms);
  const Supervisor = loadSupervisor();
  const { handlers, wc, win, statuses } = makeWorld();
  const sup = new Supervisor({
    getWebContents: () => wc,
    getHostWindow: () => win,
    onStatus: (s, d) => statuses.push([s, d]),
  });
  t.after(() => sup.destroy());
  sup.start();
  handlers['did-finish-load'](); // good load; ping clock starts now

  // Occluded window: Chromium hides the page, BrowserWindow.isVisible() stays
  // true, and the heartbeat goes quiet. Before the fix this reloaded the view.
  sup.notePageVisibility(true);
  sleep(120); // >> interval*4 (40ms) of bridge silence
  assert.equal(
    statuses.some(([s]) => s === 'recovering'),
    false,
    'must not schedule a reload while the page is hidden'
  );

  // Uncovered again: the ping clock restarts, so the throttled gap alone cannot
  // trip the check; only genuine silence after that does.
  sup.notePageVisibility(false);
  sleep(25);
  assert.equal(statuses.some(([s]) => s === 'recovering'), false, 'grace period after unhide');
  sleep(100);
  const rec = statuses.find(([s]) => s === 'recovering');
  assert.ok(rec, 'a visible page with a silent bridge is still recovered');
  assert.match(rec[1], /bridge-silent/);
});

test('a repeated "visible" report does not reset the ping clock', async (t) => {
  const Supervisor = loadSupervisor();
  const { handlers, wc, win, statuses } = makeWorld();
  const sup = new Supervisor({
    getWebContents: () => wc,
    getHostWindow: () => win,
    onStatus: (s, d) => statuses.push([s, d]),
  });
  t.after(() => sup.destroy());
  sup.start();
  handlers['did-finish-load']();
  // Spamming "visible" while already visible must not mask a dead bridge.
  const spam = setInterval(() => sup.notePageVisibility(false), 5);
  t.after(() => clearInterval(spam));
  await sleep(120);
  assert.ok(statuses.some(([s]) => s === 'recovering'), 'silent bridge still recovered');
});

test('did-finish-load clears the hidden flag so a fresh document is watched', async (t) => {
  const Supervisor = loadSupervisor();
  const { handlers, wc, win, statuses } = makeWorld();
  const sup = new Supervisor({
    getWebContents: () => wc,
    getHostWindow: () => win,
    onStatus: (s, d) => statuses.push([s, d]),
  });
  t.after(() => sup.destroy());
  sup.start();
  sup.notePageVisibility(true);
  handlers['did-finish-load'](); // new document; the bridge re-reports at boot
  await sleep(120);
  assert.ok(statuses.some(([s]) => s === 'recovering'), 'hidden flag did not survive the reload');
});

test('a minimized host window still suppresses the check on its own', async (t) => {
  const Supervisor = loadSupervisor();
  const { handlers, wc, win, statuses } = makeWorld();
  win.isMinimized = () => true;
  const sup = new Supervisor({
    getWebContents: () => wc,
    getHostWindow: () => win,
    onStatus: (s, d) => statuses.push([s, d]),
  });
  t.after(() => sup.destroy());
  sup.start();
  handlers['did-finish-load']();
  await sleep(120);
  assert.equal(statuses.some(([s]) => s === 'recovering'), false);
});

test('crash and blank checks run even while the page is hidden', async (t) => {
  const Supervisor = loadSupervisor();
  const { handlers, wc, win, statuses } = makeWorld();
  const sup = new Supervisor({
    getWebContents: () => wc,
    getHostWindow: () => win,
    onStatus: (s, d) => statuses.push([s, d]),
  });
  t.after(() => sup.destroy());
  sup.start();
  handlers['did-finish-load']();
  sup.notePageVisibility(true);
  wc.isCrashed = () => true;
  await sleep(40);
  const rec = statuses.find(([s]) => s === 'recovering');
  assert.ok(rec && /isCrashed/.test(rec[1]), 'crash detected regardless of visibility');
});
