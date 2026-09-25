// What room-client.js puts on the wire across a reconnect. Two things in the
// room can silently eat a message: it drops anything a socket sends before
// `hello` has seated it, and its per-socket limiter drops anything past
// MAX_MESSAGES_PER_WINDOW. A reconnect after typing through an outage is the
// one moment a client can hit both, so that is what these drive.
//
// PartySocket is stubbed with upstream's own queueing (buffer while closed,
// flush on open *ahead of* the open handlers), and the verdict on each
// connection's frames comes from the room's real limiter on the mocked clock.

import { test, mock, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createSocketLimiter, MAX_MESSAGES_PER_WINDOW, WINDOW_MS } from '../../server/socket-limit.js';

let socket = null;
class FakePartySocket {
  static OPEN = 1;
  constructor() {
    this.readyState = 0;
    this.listeners = {};
    this.queue = [];
    this.connections = [];
    socket = this;
  }
  addEventListener(kind, fn) { (this.listeners[kind] ||= []).push(fn); }
  send(raw) {
    if (this.readyState !== FakePartySocket.OPEN) { this.queue.push(raw); return; }
    this.connections.at(-1).push({ at: Date.now(), msg: JSON.parse(raw) });
  }
  close() { this.readyState = 3; }
  /** The room accepted a (re)connection. */
  open() {
    this.readyState = FakePartySocket.OPEN;
    this.connections.push([]);
    for (const raw of this.queue.splice(0)) this.send(raw);
    for (const fn of this.listeners.open ?? []) fn({});
  }
  /** The connection died. */
  drop() {
    this.readyState = 3;
    for (const fn of this.listeners.close ?? []) fn({});
  }
}

mock.module('partysocket', { defaultExport: FakePartySocket });

const { createRoomClient, SEND_BUDGET } = await import('./room-client.js');

/**
 * What the room would handle of one connection's frames, in order. Delivery is
 * TCP-ordered, so `latency` can hold a frame back but never reorder it.
 */
function handledByRoom(frames, latency = () => 0) {
  let arrival = -Infinity;
  const limiter = createSocketLimiter({ now: () => arrival });
  const handled = [];
  for (const f of frames) {
    arrival = Math.max(arrival, f.at + latency(f));
    if (limiter.allow('conn')) handled.push(f.msg);
  }
  return handled;
}

/** Most frames sent inside any WINDOW_MS that starts at a frame. */
function busiestWindow(frames) {
  return Math.max(...frames.map((f) => frames.filter((g) => g.at >= f.at && g.at < f.at + WINDOW_MS).length));
}

// mock.timers.tick only fires timers already due, not one a callback chains.
function walk(ms, step = 50) {
  for (let t = 0; t < ms; t += step) mock.timers.tick(step);
}

const answers = (from, to) =>
  Array.from({ length: to - from }, (_, i) => ({ type: 'answer', value: String(from + i) }));

let client = null;
beforeEach(() => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  globalThis.location = { host: 'room.test' };
  client = createRoomClient({ roomId: 'a-b-c', deviceId: 'dev-1' });
});

afterEach(() => {
  client.close();
  mock.timers.reset();
});

test('a reconnect sends hello, then everything typed offline, in order, paced so the room drops none of it', () => {
  socket.open();
  socket.drop();
  const offline = answers(0, 45);
  for (const msg of offline) client.send(msg);

  socket.open();
  walk(10 * WINDOW_MS);

  const frames = socket.connections[1];
  assert.equal(frames[0].msg.type, 'hello');
  assert.deepEqual(frames.slice(1).map((f) => f.msg), offline);
  assert.ok(SEND_BUDGET < MAX_MESSAGES_PER_WINDOW);
  assert.ok(busiestWindow(frames) <= SEND_BUDGET, `at most ${SEND_BUDGET} frames per window`);
  assert.deepEqual(handledByRoom(frames), frames.map((f) => f.msg));
  // Two of the client's windows landing in one of the room's: the first burst
  // held back until just before the second one goes out.
  const first = frames[0].at;
  assert.deepEqual(
    handledByRoom(frames, (f) => (f.at === first ? WINDOW_MS - 1 : 0)),
    frames.map((f) => f.msg),
  );

  // Once drained, a live answer goes straight out.
  client.send({ type: 'answer', value: 'live' });
  assert.deepEqual(frames.at(-1), { at: Date.now(), msg: { type: 'answer', value: 'live' } });
});

test('a connection that dies mid-flush hands what it had not sent to the next one, behind that one\'s hello', () => {
  socket.open();
  socket.drop();
  const offline = answers(0, 25);
  for (const msg of offline) client.send(msg);

  socket.open();
  socket.drop();
  mock.timers.tick(300);
  socket.open();
  walk(5 * WINDOW_MS);

  const [, cut, resumed] = socket.connections;
  assert.equal(cut[0].msg.type, 'hello');
  assert.equal(resumed[0].msg.type, 'hello');
  assert.deepEqual(
    [...cut.slice(1), ...resumed.slice(1)].map((f) => f.msg),
    offline,
  );
  assert.deepEqual(handledByRoom(resumed), resumed.map((f) => f.msg));
});
