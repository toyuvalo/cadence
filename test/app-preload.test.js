/* global require, __dirname */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const preloadPath = path.join(__dirname, '..', 'src', 'preload', 'app-preload.js');
const ytmPreloadPath = path.join(__dirname, '..', 'src', 'preload', 'ytm-preload.js');
const constants = require('../src/shared/constants');

// Cadence's own windows run sandboxed, and a sandboxed preload's `require` can
// only load 'electron' and a few Node built-ins. A relative require anywhere in
// a preload kills the whole script before contextBridge runs — that is exactly
// how window.cadence went missing from 1.4.4 to 1.4.12.
for (const file of [preloadPath, ytmPreloadPath]) {
  test(`${path.basename(file)} has no relative or file requires`, () => {
    const src = fs.readFileSync(file, 'utf8');
    const requires = [...src.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    assert.ok(requires.length > 0, 'expected at least the electron require');
    const bad = requires.filter((r) => r.startsWith('.') || r.startsWith('/') || /^[A-Za-z]:/.test(r));
    assert.deepEqual(bad, [], `sandbox-unsafe requires: ${bad.join(', ')}`);
  });
}

test('app-preload inlined lyrics API constants match src/shared/constants.js', () => {
  const src = fs.readFileSync(preloadPath, 'utf8');
  const pick = (name) => {
    const m = src.match(new RegExp(`const ${name} = '([^']+)'`));
    assert.ok(m, `${name} must be inlined as a string literal`);
    return m[1];
  };
  assert.equal(pick('LYRICS_DEFAULT_API'), constants.LYRICS_DEFAULT_API);
  assert.equal(pick('LYRICS_MIRROR_API'), constants.LYRICS_MIRROR_API);
});
