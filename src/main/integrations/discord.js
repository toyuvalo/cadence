'use strict';

// Discord Rich Presence over Discord's local IPC pipe, using only Node's `net`.
// Register an application at https://discord.com/developers/applications and set
// its id as integrations.discordClientId in settings; without one this no-ops.

const net = require('net');
const { hub } = require('../hub');
const config = require('../config');

// Discord exposes \\?\pipe\discord-ipc-0 .. -9 while running; we use the first.
const PIPE_BASE = '\\\\?\\pipe\\discord-ipc-';
const PIPE_COUNT = 10;
const PIPE_PROBE_TIMEOUT_MS = 1500;

// Frame opcodes (uint32 LE header).
const OP_HANDSHAKE = 0;
const OP_FRAME = 1;
const OP_CLOSE = 2;
const OP_PING = 3;
const OP_PONG = 4;

const ACTIVITY_TYPE_LISTENING = 2;
const FIELD_MAX = 128;
const FIELD_MIN = 2; // Discord rejects details/state shorter than this
const ACTIVITY_THROTTLE_MS = 2000; // Discord rate-limits ~5 updates / 20s
const BACKOFF_INITIAL_MS = 2000;
const BACKOFF_CAP_MS = 60000;

let socket = null;
let isReady = false; // true once Discord sends its READY dispatch
let isConnecting = false;
let backoffMs = BACKOFF_INITIAL_MS;
let backoffTimer = null;
let readBuf = Buffer.alloc(0);
let lastSendTime = 0;
let lastSentKey = '';
let throttleTimer = null;
let pendingState = null;
let nonceCounter = 0;

function makeNonce() {
  nonceCounter += 1;
  return `${process.pid}-${Date.now()}-${nonceCounter}`;
}

// details/state must be 2..128 chars; fall back if too short.
function sanitizeField(str, fallback) {
  const s = (str || '').trim();
  if (s.length < FIELD_MIN) return (fallback || 'YouTube Music').slice(0, FIELD_MAX);
  return s.slice(0, FIELD_MAX);
}

// Frame = uint32 LE opcode + uint32 LE payload length + UTF-8 JSON.
function buildFrame(opcode, payload) {
  const json = Buffer.from(JSON.stringify(payload), 'utf8');
  const frame = Buffer.allocUnsafe(8 + json.length);
  frame.writeUInt32LE(opcode, 0);
  frame.writeUInt32LE(json.length, 4);
  json.copy(frame, 8);
  return frame;
}

function writeFrame(opcode, payload) {
  if (!socket || socket.destroyed) return;
  try {
    socket.write(buildFrame(opcode, payload));
  } catch (err) {
    console.error('[discord] write failed:', err.message);
  }
}

// Probe the pipes in order; resolve with the first that connects.
function tryConnectPipes() {
  return new Promise((resolve, reject) => {
    let idx = 0;
    const attempt = () => {
      if (idx >= PIPE_COUNT) {
        reject(new Error('no Discord IPC pipe found (is Discord running?)'));
        return;
      }
      const sock = net.createConnection(PIPE_BASE + idx);
      idx += 1;
      const timer = setTimeout(() => {
        sock.destroy();
        attempt();
      }, PIPE_PROBE_TIMEOUT_MS);
      sock.once('connect', () => {
        clearTimeout(timer);
        resolve(sock);
      });
      sock.once('error', () => {
        clearTimeout(timer);
        sock.destroy();
        attempt();
      });
    };
    attempt();
  });
}

function clientId() {
  return config.get('integrations.discordClientId', '') || '';
}

async function connect() {
  if (isConnecting || socket || !isEnabled()) return;
  const id = clientId();
  if (!id) {
    console.log('[discord] set integrations.discordClientId to enable Rich Presence');
    return;
  }
  isConnecting = true;
  try {
    const sock = await tryConnectPipes();
    socket = sock;
    isReady = false;
    readBuf = Buffer.alloc(0);
    sock.on('data', onData);
    sock.on('error', (err) => {
      console.error('[discord] socket error:', err.message);
      handleDisconnect();
    });
    sock.on('close', handleDisconnect);
    // Discord replies with a READY dispatch once it accepts the handshake.
    writeFrame(OP_HANDSHAKE, { v: 1, client_id: id });
  } catch (err) {
    console.error('[discord] connect failed:', err.message);
    scheduleReconnect();
  } finally {
    isConnecting = false;
  }
}

function handleDisconnect() {
  if (socket) {
    try {
      socket.destroy();
    } catch {}
    socket = null;
  }
  isReady = false;
  if (isEnabled()) scheduleReconnect();
}

function scheduleReconnect() {
  if (backoffTimer || !isEnabled()) return;
  console.error(`[discord] reconnecting in ${backoffMs}ms`);
  backoffTimer = setTimeout(() => {
    backoffTimer = null;
    backoffMs = Math.min(backoffMs * 2, BACKOFF_CAP_MS);
    connect().catch((err) => console.error('[discord] reconnect error:', err.message));
  }, backoffMs);
}

function cancelReconnect() {
  if (backoffTimer) {
    clearTimeout(backoffTimer);
    backoffTimer = null;
  }
}

function disconnect() {
  cancelReconnect();
  if (throttleTimer) {
    clearTimeout(throttleTimer);
    throttleTimer = null;
  }
  pendingState = null;
  if (socket) {
    if (isReady) {
      writeFrame(OP_FRAME, {
        cmd: 'SET_ACTIVITY',
        args: { pid: process.pid, activity: null },
        nonce: makeNonce(),
      });
    }
    try {
      socket.destroy();
    } catch {}
    socket = null;
  }
  isReady = false;
  backoffMs = BACKOFF_INITIAL_MS;
}

// Frames are length-prefixed, so we can slice complete ones out of the buffer.
function onData(chunk) {
  try {
    readBuf = Buffer.concat([readBuf, chunk]);
    while (readBuf.length >= 8) {
      const payloadLen = readBuf.readUInt32LE(4);
      if (readBuf.length < 8 + payloadLen) break;
      const opcode = readBuf.readUInt32LE(0);
      const payload = readBuf.slice(8, 8 + payloadLen);
      readBuf = readBuf.slice(8 + payloadLen);
      handleFrame(opcode, payload);
    }
  } catch (err) {
    console.error('[discord] read error:', err.message);
  }
}

function handleFrame(opcode, payload) {
  try {
    if (opcode === OP_PING) {
      if (socket && !socket.destroyed) {
        const pong = Buffer.allocUnsafe(8 + payload.length);
        pong.writeUInt32LE(OP_PONG, 0);
        pong.writeUInt32LE(payload.length, 4);
        payload.copy(pong, 8);
        socket.write(pong);
      }
      return;
    }
    if (opcode === OP_CLOSE) {
      handleDisconnect();
      return;
    }
    if (opcode === OP_FRAME) {
      let msg;
      try {
        msg = JSON.parse(payload.toString('utf8'));
      } catch {
        return;
      }
      // We must wait for READY before sending activity or Discord drops it.
      if (msg && msg.cmd === 'DISPATCH' && msg.evt === 'READY') {
        isReady = true;
        backoffMs = BACKOFF_INITIAL_MS;
        if (pendingState !== null) {
          const s = pendingState;
          pendingState = null;
          sendActivity(s);
        }
      }
    }
  } catch (err) {
    console.error('[discord] frame error:', err.message);
  }
}

// null activity = clear the presence.
function buildActivity(state) {
  if (!state || !state.hasSong || state.adShowing) return null;
  const activity = {
    type: ACTIVITY_TYPE_LISTENING,
    details: sanitizeField(state.title, 'YouTube Music'),
    state: sanitizeField(`by ${state.artist || ''}`, 'YouTube Music'),
    assets: { large_image: 'logo', large_text: sanitizeField(state.album, 'YouTube Music') },
    instance: false,
  };
  // Only add a progress bar while playing — a frozen counter when paused is
  // misleading.
  if (!state.isPaused) {
    const now = Date.now();
    const currentMs = (state.currentTime || 0) * 1000;
    const durationMs = (state.duration || 0) * 1000;
    activity.timestamps = { start: Math.round(now - currentMs), end: Math.round(now + (durationMs - currentMs)) };
  }
  return activity;
}

// Fingerprint of the fields that actually change the presence, so we skip
// redundant updates (e.g. volume changes Discord wouldn't show).
function stateKey(state) {
  if (!state || !state.hasSong || state.adShowing) return '__no_song__';
  return `${state.title}||${state.artist}||${state.isPaused ? 'paused' : 'playing'}`;
}

function sendActivity(state) {
  if (!socket || socket.destroyed || !isReady) return;
  const key = stateKey(state);
  if (key === lastSentKey) return;
  lastSentKey = key;
  lastSendTime = Date.now();
  writeFrame(OP_FRAME, {
    cmd: 'SET_ACTIVITY',
    args: { pid: process.pid, activity: buildActivity(state) },
    nonce: makeNonce(),
  });
}

// Throttle to one update per ACTIVITY_THROTTLE_MS; the latest state wins.
function scheduleActivity(state) {
  pendingState = state;
  if (!isReady) return; // flushed on READY
  const elapsed = Date.now() - lastSendTime;
  if (elapsed >= ACTIVITY_THROTTLE_MS) {
    if (throttleTimer) {
      clearTimeout(throttleTimer);
      throttleTimer = null;
    }
    pendingState = null;
    sendActivity(state);
  } else if (!throttleTimer) {
    throttleTimer = setTimeout(() => {
      throttleTimer = null;
      const s = pendingState;
      pendingState = null;
      sendActivity(s);
    }, ACTIVITY_THROTTLE_MS - elapsed);
  }
}

function isEnabled() {
  try {
    return !!config.get('integrations.discordRPC', false);
  } catch {
    return false;
  }
}

function onState(state) {
  try {
    if (!isEnabled()) return;
    if (!socket || !isReady) {
      pendingState = state; // sent once connected/READY
      return;
    }
    scheduleActivity(state);
  } catch (err) {
    console.error('[discord] state handler error:', err.message);
  }
}

function onConfigChange() {
  try {
    if (isEnabled()) {
      if (!socket && !isConnecting && !backoffTimer) {
        backoffMs = BACKOFF_INITIAL_MS;
        connect().catch((err) => console.error('[discord] connect error:', err.message));
      }
    } else {
      disconnect();
      lastSentKey = '';
    }
  } catch (err) {
    console.error('[discord] config handler error:', err.message);
  }
}

function init() {
  hub.on('state', onState);
  config.on('change', onConfigChange);
  if (isEnabled()) connect().catch((err) => console.error('[discord] init error:', err.message));
}

module.exports = { init };
