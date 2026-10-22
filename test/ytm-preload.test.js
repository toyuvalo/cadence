/* global require, __dirname, console, URL */
'use strict';

// Runs ytm-preload.js in a vm against a fake page: a fake document, a fake
// ipcRenderer and a manual clock, so the heartbeat and the transport commands
// are exercised for real rather than grepped.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'ytm-preload.js'), 'utf8');

function load({ elements = {} } = {}) {
  const sent = [];
  const handlers = {};
  const keys = [];
  const clicks = [];
  const timers = new Map();
  let nextId = 1;
  let now = 0;

  const video = { paused: false, currentTime: 0, duration: 200, volume: 1, muted: false, addEventListener() {} };
  const el = (name) => ({ tagName: 'BUTTON', className: '', click: () => clicks.push(name), getAttribute: () => null });
  const document = {
    readyState: 'complete',
    visibilityState: 'visible',
    body: { appendChild() {} },
    head: { appendChild() {} },
    documentElement: {},
    addEventListener() {},
    getElementById: () => null,
    createElement: () => ({ style: {}, appendChild() {}, addEventListener() {} }),
    createElementNS: () => ({ setAttribute() {}, appendChild() {} }),
    querySelector: (sel) => (sel === 'video' ? video : elements[sel] ? el(elements[sel]) : null),
    querySelectorAll: () => [],
    dispatchEvent: (e) => keys.push(e.key),
  };
  const ipcRenderer = {
    send: (ch, payload) => sent.push({ ch, payload }),
    on: (ch, fn) => (handlers[ch] = fn),
    invoke: () => Promise.resolve({}),
  };
  const sandbox = {
    require: (m) => (m === 'electron' ? { ipcRenderer } : require(m)),
    document,
    navigator: {},
    location: { href: 'https://music.youtube.com/watch?v=x' },
    process: { env: {}, argv: [] },
    console,
    URL,
    KeyboardEvent: class { constructor(type, init) { Object.assign(this, init, { type }); } },
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    Date: { now: () => now },
    setTimeout: (fn, ms) => { const id = nextId++; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
    setInterval: () => 0,
    clearInterval() {},
  };
  sandbox.window = sandbox;
  vm.runInNewContext(src, sandbox);

  const advance = (ms) => {
    const end = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = end;
  };
  const command = (action) => handlers['ytm:command'](null, { action });
  const states = () => sent.filter((s) => s.ch === 'ytm:state').length;
  return { advance, command, states, keys, clicks };
}

test('heartbeat keeps ticking while playing (supervisor must not see a silent bridge)', () => {
  const page = load();
  const before = page.states();
  page.advance(10000);
  assert.ok(page.states() - before >= 9, `expected ~10 beats in 10s, got ${page.states() - before}`);
});

test('next/previous click the redesigned ytmusic-wiz-player-controls buttons', () => {
  const page = load({
    elements: {
      'ytmusic-wiz-player-controls button[title="Next"]': 'next',
      'ytmusic-wiz-player-controls button[title="Previous"]': 'previous',
    },
  });
  page.command('next');
  page.command('previous');
  assert.deepEqual(page.clicks, ['next', 'previous']);
  assert.deepEqual(page.keys, []);
});

test('next/previous fall back to YTM hotkeys j/k when no button matches', () => {
  const page = load();
  page.command('next');
  page.command('previous');
  assert.deepEqual(page.keys, ['j', 'k']);
});
