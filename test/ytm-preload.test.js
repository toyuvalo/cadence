/* global require, __dirname, console, URL */
'use strict';

// Execute the real preload with a fake page and a manual clock. No Electron,
// network, or wall-clock timers are needed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const src = fs.readFileSync(path.join(__dirname, '..', 'src', 'preload', 'ytm-preload.js'), 'utf8');

function load({ paused = false, elements = {} } = {}) {
  const sent = [];
  const handlers = {};
  const videoHandlers = {};
  const keys = [];
  const clicks = [];
  const timers = new Map();
  let nextId = 1;
  let now = 0;

  const video = {
    paused, currentTime: 0, duration: 200, volume: 1, muted: false,
    addEventListener(event, fn) { (videoHandlers[event] ||= []).push(fn); },
  };
  const emit = (event) => {
    if (event === 'play') video.paused = false;
    if (event === 'pause') video.paused = true;
    for (const fn of videoHandlers[event] || []) fn();
  };
  const nodes = Object.fromEntries(Object.entries(elements).map(([selector, config]) => {
    const name = typeof config === 'string' ? config : config.name || selector;
    const attrs = typeof config === 'string' ? {} : config.attrs || {};
    return [selector, {
      tagName: 'BUTTON', className: '',
      click: () => clicks.push(name),
      getAttribute: (attribute) => attrs[attribute] ?? null,
    }];
  }));
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
    querySelector: (selector) => selector === 'video' ? video : nodes[selector] || null,
    querySelectorAll: () => [],
    dispatchEvent: (event) => { keys.push(event); return true; },
  };
  const ipcRenderer = {
    send: (channel, payload) => sent.push({ channel, payload }),
    on: (channel, fn) => { handlers[channel] = fn; },
    invoke: () => Promise.resolve({}),
  };
  const sandbox = {
    require: (name) => {
      assert.equal(name, 'electron', 'the sandbox harness permits only Electron');
      return { ipcRenderer };
    },
    document,
    navigator: {},
    location: { href: 'https://music.youtube.com/watch?v=test' },
    process: { env: {}, argv: [] },
    console,
    URL,
    KeyboardEvent: class {
      constructor(type, init) { Object.assign(this, init, { type }); }
    },
    MutationObserver: class { observe() {} disconnect() {} },
    ResizeObserver: class { observe() {} disconnect() {} },
    Date: { now: () => now },
    setTimeout: (fn, delay) => {
      const id = nextId++;
      timers.set(id, { fn, at: now + delay });
      return id;
    },
    clearTimeout: (id) => timers.delete(id),
    setInterval: () => 0,
    clearInterval() {},
  };
  sandbox.window = sandbox;
  vm.runInNewContext(src, sandbox);

  const advance = (milliseconds) => {
    const end = now + milliseconds;
    let fired = 0;
    for (;;) {
      const due = [...timers.entries()]
        .filter(([, timer]) => timer.at <= end)
        .sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      assert.ok(++fired < 10000, 'timer loop must make progress');
      timers.delete(due[0]);
      now = due[1].at;
      due[1].fn();
    }
    now = end;
  };
  const stateMessages = () => sent.filter(({ channel }) => channel === 'ytm:state');
  return {
    advance, emit, clicks, keys,
    command: (action) => handlers['ytm:command'](null, { action }),
    stateMessages,
    latestState: () => {
      const latest = stateMessages().at(-1);
      assert.ok(latest, 'expected a state snapshot after a command or timer tick');
      return latest.payload;
    },
  };
}

// Ignore the initial attachment snapshot. Each subsequent timer must produce
// exactly one state at its deadline, with no early state or missing beat.
function expectTicks(page, period, count) {
  for (let i = 0; i < count; i += 1) {
    const before = page.stateMessages().length;
    page.advance(period - 1);
    assert.equal(page.stateMessages().length, before, 'no early or duplicate beat');
    page.advance(1);
    assert.equal(page.stateMessages().length, before + 1, 'one state per deadline');
  }
}

test('playing heartbeat continues every second beyond the watchdog window', () => {
  const page = load();
  page.advance(1000); // First heartbeat attaches video listeners.
  assert.equal(page.latestState().isPaused, false);
  expectTicks(page, 1000, 120);
});

test('paused heartbeat starts at five seconds and continues at that period', () => {
  const page = load({ paused: true });
  page.advance(4999);
  assert.equal(page.stateMessages().length, 0);
  page.advance(1); // Attachment and heartbeat may both send a snapshot.
  assert.equal(page.latestState().isPaused, true);
  expectTicks(page, 5000, 24);
});

test('play and pause replace the old deadline without accumulating heartbeats', () => {
  const page = load();
  page.advance(1000);
  for (let i = 0; i < 20; i += 1) {
    page.advance(250); // Switch between beats, while a timer is pending.
    page.emit('pause');
    assert.equal(page.latestState().isPaused, true);
    expectTicks(page, 5000, 2); // The old one-second deadline must be cancelled.
    page.advance(250);
    page.emit('play');
    assert.equal(page.latestState().isPaused, false);
    expectTicks(page, 1000, 6); // Cross the cancelled five-second deadline too.
  }
});

for (const paused of [false, true]) {
  test(`repeated ${paused ? 'pause' : 'play'} events do not defer or multiply beats`, () => {
    const page = load({ paused });
    const period = paused ? 5000 : 1000;
    page.advance(period);
    for (let i = 0; i < 20; i += 1) {
      page.advance(period / 25);
      page.emit(paused ? 'pause' : 'play');
    }
    const before = page.stateMessages().length;
    page.advance(period / 5 - 1);
    assert.equal(page.stateMessages().length, before);
    page.advance(1);
    assert.equal(page.stateMessages().length, before + 1);
    expectTicks(page, period, 5);
  });
}

for (const attribute of ['title', 'aria-label']) {
  test(`next/previous click redesigned ${attribute} buttons without hotkeys`, () => {
    const page = load({
      elements: {
        [`ytmusic-wiz-player-controls button[${attribute}="Next"]`]: 'next',
        [`ytmusic-wiz-player-controls button[${attribute}="Previous"]`]: 'previous',
      },
    });
    page.command('next');
    page.command('previous');
    assert.deepEqual(page.clicks, ['next', 'previous']);
    assert.deepEqual(page.keys, []);
  });
}

test('next/previous dispatch bubbling j/k keydowns when no button matches', () => {
  const page = load();
  page.command('next');
  page.command('previous');
  assert.deepEqual(page.clicks, []);
  assert.deepEqual(page.keys.map(({ type, key, code, keyCode, which, bubbles }) =>
    ({ type, key, code, keyCode, which, bubbles })), [
    { type: 'keydown', key: 'j', code: 'KeyJ', keyCode: 74, which: 74, bubbles: true },
    { type: 'keydown', key: 'k', code: 'KeyK', keyCode: 75, which: 75, bubbles: true },
  ]);
});

for (const legacy of [
  { next: '.next-button.ytmusic-player-bar', previous: '.previous-button.ytmusic-player-bar' },
  { next: 'tp-yt-paper-icon-button.next-button', previous: 'tp-yt-paper-icon-button.previous-button' },
  { next: '.next-button', previous: '.previous-button' },
]) {
  test(`legacy transport ${legacy.next} takes precedence over redesigned controls`, () => {
    const page = load({ elements: {
      [legacy.next]: 'legacy-next',
      [legacy.previous]: 'legacy-previous',
      'ytmusic-wiz-player-controls button[title="Next"]': 'new-next',
      'ytmusic-wiz-player-controls button[title="Previous"]': 'new-previous',
    } });
    page.command('next');
    page.command('previous');
    assert.deepEqual(page.clicks, ['legacy-next', 'legacy-previous']);
    assert.deepEqual(page.keys, []);
  });
}

for (const prefix of ['ytmusic-miniplayer ', '']) {
  test(`like/dislike click ${prefix || 'unscoped '}view-model buttons`, () => {
    const page = load({ elements: {
      [`${prefix}like-button-view-model button`]: 'like',
      [`${prefix}dislike-button-view-model button`]: 'dislike',
    } });
    page.command('like');
    page.command('dislike');
    assert.deepEqual(page.clicks, ['like', 'dislike']);
    assert.deepEqual(page.keys, []);
  });
}

for (const prefix of ['ytmusic-like-button-renderer ', '']) {
  test(`legacy ${prefix || 'unscoped '}like/dislike buttons take precedence`, () => {
    const page = load({ elements: {
      [`${prefix}#button-shape-like button`]: 'old-like',
      [`${prefix}#button-shape-dislike button`]: 'old-dislike',
      'ytmusic-miniplayer like-button-view-model button': 'new-like',
      'ytmusic-miniplayer dislike-button-view-model button': 'new-dislike',
    } });
    page.command('like');
    page.command('dislike');
    assert.deepEqual(page.clicks, ['old-like', 'old-dislike']);
    assert.deepEqual(page.keys, []);
  });
}

const button = (pressed) => ({ attrs: { 'aria-pressed': pressed } });
for (const prefix of ['ytmusic-miniplayer ', '']) {
  for (const [like, dislike, expected] of [
    ['true', 'false', 'LIKE'],
    ['false', 'true', 'DISLIKE'],
    ['false', 'false', 'INDIFFERENT'],
    [undefined, undefined, 'INDIFFERENT'],
  ]) {
    test(`like state: ${prefix || 'unscoped '}buttons ${like}/${dislike} -> ${expected}`, () => {
      const page = load({ elements: {
        [`${prefix}like-button-view-model button`]: button(like),
        [`${prefix}dislike-button-view-model button`]: button(dislike),
      } });
      page.advance(1000);
      assert.equal(page.latestState().liked, expected);
    });
  }
}

for (const status of ['LIKE', 'DISLIKE', 'INDIFFERENT']) {
  test(`legacy like-status ${status} wins over conflicting view-model state`, () => {
    const page = load({ elements: {
      'ytmusic-like-button-renderer': { attrs: { 'like-status': status } },
      'like-button-view-model button': button(status === 'LIKE' ? 'false' : 'true'),
      'dislike-button-view-model button': button(status === 'LIKE' ? 'true' : 'false'),
    } });
    page.advance(1000);
    assert.equal(page.latestState().liked, status);
  });
}

for (const status of [undefined, 'UNKNOWN']) {
  test(`legacy like-status ${status} falls back to view-model state`, () => {
    const page = load({ elements: {
      'ytmusic-like-button-renderer': { attrs: { 'like-status': status } },
      'dislike-button-view-model button': button('true'),
    } });
    page.advance(1000);
    assert.equal(page.latestState().liked, 'DISLIKE');
  });
}

test('like state is INDIFFERENT when neither layout is present', () => {
  const page = load();
  page.advance(1000);
  assert.equal(page.latestState().liked, 'INDIFFERENT');
});

test('heartbeat reports like-state changes without a playback event', () => {
  const like = button('false');
  const dislike = button('false');
  const page = load({ elements: {
    'like-button-view-model button': like,
    'dislike-button-view-model button': dislike,
  } });
  page.advance(1000);
  assert.equal(page.latestState().liked, 'INDIFFERENT');

  for (const [likePressed, dislikePressed, expected] of [
    ['true', 'false', 'LIKE'],
    ['false', 'true', 'DISLIKE'],
    ['false', 'false', 'INDIFFERENT'],
  ]) {
    like.attrs['aria-pressed'] = likePressed;
    dislike.attrs['aria-pressed'] = dislikePressed;
    page.advance(1000);
    assert.equal(page.latestState().liked, expected);
  }
});
