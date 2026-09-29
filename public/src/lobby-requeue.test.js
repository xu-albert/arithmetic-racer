// Quick-match dead-end refusals, over the real attachLobby and room client.
//
// A hello can be refused because the router's pointer outlived the room
// (MATCH_OVER: started/finished; ROOM_FULL: six humans already seated). The
// room re-attempts its router release as it refuses, so the player's own next
// Find Match mints a fresh room — the lobby itself never re-runs matchmaking
// or navigates. Whether the page was never seated (a fresh join) or held a
// seat it has since lost (reconnect or reload past the grace), the refusal is
// an ordinary error toast and the player stays put, with Find Another Match
// and Leave still on screen. Only the browser is stubbed: PartySocket, the
// DOM, fetch and location.assign.

import { test, describe, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

// --- browser stubs ----------------------------------------------------------

function fakeEl() {
  const classes = new Set();
  const el = {
    children: [],
    dataset: {},
    className: '',
    value: '',
    disabled: false,
    textContent: '',
    hidden: false,
    classList: {
      add: (...c) => c.forEach((x) => classes.add(x)),
      remove: (...c) => c.forEach((x) => classes.delete(x)),
      contains: (c) => classes.has(c),
      toggle: (c, on) => {
        const want = on === undefined ? !classes.has(c) : on;
        if (want) classes.add(c); else classes.delete(c);
        return want;
      },
    },
    append: (...k) => el.children.push(...k),
    addEventListener: () => {},
    removeEventListener: () => {},
    focus: () => {},
    remove: () => {},
    querySelector: () => null,
    querySelectorAll: () => [],
    nextSibling: null,
    set innerHTML(_) { el.children.length = 0; },
    get innerHTML() { return ''; },
  };
  // Quick Match inserts its own controls next to the lobby buttons.
  el.parentNode = { insertBefore: (node) => el.children.push(node) };
  return el;
}

let assigns;
let fetches;

function installDom({ search = '' } = {}) {
  const els = new Map();
  globalThis.document = {
    getElementById: (id) => {
      if (!els.has(id)) els.set(id, fakeEl());
      return els.get(id);
    },
    querySelectorAll: () => [],
    querySelector: () => null,
    createElement: () => fakeEl(),
    body: fakeEl(),
    addEventListener: () => {},
  };
  assigns = [];
  globalThis.location = { host: 'localhost', search, assign: (url) => assigns.push(url) };
  globalThis.history = { replaceState: () => {} };
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  globalThis.crypto ??= { randomUUID: () => '11111111-2222-4333-8444-555555555555' };
  fetches = [];
  globalThis.fetch = async (url) => {
    fetches.push(url);
    return { ok: true, status: 200, json: async () => ({ roomId: 'm-fresh-room', difficulty: 'easy' }) };
  };
  return els;
}

// One fake socket per createRoomClient; the test drives it like the room would.
const sockets = [];
class FakePartySocket {
  constructor(opts) {
    this.opts = opts;
    this.listeners = {};
    this.sent = [];
    sockets.push(this);
  }
  addEventListener(kind, fn) { (this.listeners[kind] ||= []).push(fn); }
  removeEventListener() {}
  send(raw) { this.sent.push(JSON.parse(raw)); }
  close() {}
  /** Deliver a server frame. */
  push(obj) { for (const fn of this.listeners.message ?? []) fn({ data: JSON.stringify(obj) }); }
}

mock.module('partysocket', { defaultExport: FakePartySocket });

const { attachLobby } = await import('./lobby.js');

const ROOM_URL = '?room=m-old-room&mode=public&difficulty=easy';

/** Let anything async the error handler might start run to completion. */
async function flush(times = 5) {
  for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
}

function open({ mode = 'public', difficulty = 'easy' } = {}) {
  const els = installDom({ search: ROOM_URL });
  attachLobby({
    roomId: 'm-old-room',
    screens: { 'lobby-room': fakeEl(), race: fakeEl(), results: fakeEl() },
    mode,
    difficulty,
    deviceId: 'dev-1',
  });
  return { ws: sockets[sockets.length - 1], els };
}

function assertStaysPut(els, message) {
  assert.equal(fetches.length, 0);
  assert.equal(assigns.length, 0);
  assert.equal(els.get('error-toast').textContent, message);
}

const FINISHED = {
  state: 'finished',
  difficulty: 'easy',
  raceLength: 10,
  lastRace: { difficulty: 'easy', raceLength: 10 },
  problemSequence: [],
  players: [{ id: 'p-1', handle: 'Me', score: 10, finishMs: 9000, isGuest: true }],
};

describe('quick-match dead-end refusals are plain error toasts', () => {
  beforeEach(() => {
    sockets.length = 0;
  });

  for (const code of ['MATCH_OVER', 'ROOM_FULL']) {
    test(`${code} on a fresh join: toast, no matchmaking, no navigation`, async () => {
      const { ws, els } = open();
      ws.push({ type: 'state', state: { ...FINISHED, players: [] }, youAre: null });
      ws.push({ type: 'error', code, message: 'dead end' });
      await flush();

      assertStaysPut(els, 'dead end');
    });

    test(`${code} after this page held a seat: the finisher stays on the scoreboard`, async () => {
      const { ws, els } = open();
      ws.push({ type: 'hello-ack', playerId: 'p-1', handle: 'Me' });
      ws.push({ type: 'state', state: FINISHED, youAre: 'p-1' });

      // Socket away past the grace: the seat is gone, the reconnect's
      // snapshot names nobody, and the new hello is refused.
      ws.push({ type: 'state', state: { ...FINISHED, players: [] }, youAre: null });
      ws.push({ type: 'error', code, message: 'This match has ended; find a new match.' });
      await flush();

      assertStaysPut(els, 'This match has ended; find a new match.');
    });
  }

  test('a reload mid-race past the grace is not moved either', async () => {
    const { ws, els } = open();
    ws.push({ type: 'state', state: { ...FINISHED, state: 'racing', players: [] }, youAre: null });
    ws.push({ type: 'error', code: 'MATCH_OVER', message: 'This race already started; find a new match.' });
    await flush();

    assertStaysPut(els, 'This race already started; find a new match.');
  });
});
