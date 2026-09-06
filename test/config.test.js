/* global require, global, structuredClone */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');

test('state writes debounce silently while settings flush and emit', (t) => {
  const configPath = require.resolve('../src/main/config');
  const originalLoad = Module._load;
  const originalSetTimeout = global.setTimeout;
  const originalClearTimeout = global.clearTimeout;
  const jobs = [];
  const cleared = new Set();
  let store;

  class FakeStore {
    constructor() {
      store = this;
      this.data = new Map([['config', {}]]);
      this.writes = [];
    }
    get(key) {
      return structuredClone(this.data.get(key));
    }
    set(key, value) {
      const copy = structuredClone(value);
      this.data.set(key, copy);
      this.writes.push(copy);
    }
  }

  global.setTimeout = (fn, delay) => {
    const handle = {
      fn,
      delay,
      unrefCalled: false,
      unref() { this.unrefCalled = true; },
    };
    jobs.push(handle);
    return handle;
  };
  global.clearTimeout = (handle) => cleared.add(handle);
  Module._load = function mockLoad(request, parent, isMain) {
    if (request === 'electron-store') return FakeStore;
    return originalLoad.call(this, request, parent, isMain);
  };
  delete require.cache[configPath];

  let config;
  try {
    config = require(configPath);
  } finally {
    Module._load = originalLoad;
  }
  t.after(() => {
    config.removeAllListeners();
    delete require.cache[configPath];
    global.setTimeout = originalSetTimeout;
    global.clearTimeout = originalClearTimeout;
  });

  let changes = 0;
  config.on('change', () => { changes += 1; });
  config.setState('state.volume', 71);
  config.setState('state.windowBounds.x', 320);

  assert.equal(changes, 0);
  assert.equal(store.writes.length, 1);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].delay, 400);
  assert.equal(jobs[0].unrefCalled, true);

  const pending = jobs[0];
  config.set('general.closeToTray', false);

  assert.equal(cleared.has(pending), true);
  assert.equal(store.writes.length, 2);
  assert.equal(store.data.get('config').state.volume, 71);
  assert.equal(store.data.get('config').state.windowBounds.x, 320);
  assert.equal(store.data.get('config').general.closeToTray, false);
  assert.equal(changes, 1);
});