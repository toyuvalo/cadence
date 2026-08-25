'use strict';

const Store = require('electron-store');
const { EventEmitter } = require('events');
const { DEFAULT_CONFIG } = require('../shared/constants');

// Deep-merge helper so a partial/old on-disk config always resolves against the
// current default schema. Never mutates inputs.
function deepMerge(base, override) {
  const out = Array.isArray(base) ? base.slice() : { ...base };
  if (!override || typeof override !== 'object') return out;
  for (const key of Object.keys(override)) {
    const b = base ? base[key] : undefined;
    const o = override[key];
    if (o && typeof o === 'object' && !Array.isArray(o) && b && typeof b === 'object') {
      out[key] = deepMerge(b, o);
    } else if (o !== undefined) {
      out[key] = o;
    }
  }
  return out;
}

// One-time repairs for values that a PREVIOUS version persisted badly. Changing
// a default in DEFAULT_CONFIG is not enough on its own: deepMerge lets the
// stored value win, which is correct for real user choices but means a bad
// default keeps haunting everyone who ran the version that shipped it.
// Each migration runs once, recorded by id in state.migrationsApplied.
const MIGRATIONS = [
  {
    id: 'lyrics-float-above-all-2026-08',
    apply(data) {
      // 1.2.0–1.3.x defaulted features.lyricsAlwaysOnTop to TRUE, so the lyrics
      // panel floated above every other application, not just Cadence. The
      // default is now false; this clears the persisted true it left behind.
      // Anyone who genuinely wants it can turn it back on — the toggle applies
      // live, and this migration never runs again.
      if (data.features && data.features.lyricsAlwaysOnTop === true) {
        data.features.lyricsAlwaysOnTop = false;
        return true;
      }
      return false;
    },
  },
];

function runMigrations(data) {
  const done = new Set((data.state && data.state.migrationsApplied) || []);
  let changed = false;
  for (const m of MIGRATIONS) {
    if (done.has(m.id)) continue;
    try {
      if (m.apply(data)) changed = true;
    } catch (err) {
      // A failed migration must never prevent startup.
      // eslint-disable-next-line no-console
      console.error(`[config] migration ${m.id} failed:`, err.message);
    }
    done.add(m.id);
    changed = true;
  }
  if (changed) {
    if (!data.state) data.state = {};
    data.state.migrationsApplied = [...done];
  }
  return data;
}

function getPath(obj, dotted) {
  return dotted.split('.').reduce((acc, k) => (acc == null ? acc : acc[k]), obj);
}

function setPath(obj, dotted, value) {
  const keys = dotted.split('.');
  const last = keys.pop();
  let node = obj;
  for (const k of keys) {
    if (typeof node[k] !== 'object' || node[k] === null) node[k] = {};
    node = node[k];
  }
  node[last] = value;
}

// Thin, crash-proof wrapper around electron-store. If the store file is corrupt,
// electron-store throws on construction; we fall back to an in-memory store so
// the app still launches (resilience: bad settings must never brick startup).
class Config extends EventEmitter {
  constructor() {
    super();
    let raw = {};
    try {
      this._store = new Store({ name: 'cadence-config', clearInvalidConfig: true });
      raw = this._store.get('config') || {};
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[config] store unreadable, using in-memory defaults:', err.message);
      this._store = null;
      raw = {};
    }
    this._data = runMigrations(deepMerge(DEFAULT_CONFIG, raw));
    this._persist();
  }

  all() {
    return this._data;
  }

  get(dotted, fallback) {
    const v = getPath(this._data, dotted);
    return v === undefined ? fallback : v;
  }

  // Accepts either set('a.b', value) or set({ a: { b: value } }) for batch.
  set(dottedOrObject, value) {
    if (typeof dottedOrObject === 'string') {
      setPath(this._data, dottedOrObject, value);
    } else if (dottedOrObject && typeof dottedOrObject === 'object') {
      this._data = deepMerge(this._data, dottedOrObject);
    }
    this._persist();
    this.emit('change', this._data);
    return this._data;
  }

  _persist() {
    if (!this._store) return;
    try {
      this._store.set('config', this._data);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('[config] persist failed:', err.message);
    }
  }
}

module.exports = new Config();
