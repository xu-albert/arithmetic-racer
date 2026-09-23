// The lobby's race-handoff gate, over the real attachLobby and the real room
// client. Only the browser is stubbed: PartySocket (the transport), the DOM and
// localStorage. Everything that decides *when* a race screen opens is the
// shipped code.
//
// This exists because that decision is one `&&` in lobby.js, and getting it
// wrong is not a small bug: the server pushes a `state` on connect, before
// `hello` proves which seat this socket owns, so the first snapshot a reloading
// player receives says `racing` with `youAre: null`. Handing that to the race
// screen aliases nobody to 'player' and attachRaceUI throws on that racer's
// score — after the screen has already been swapped in. The runner/UI tests
// inject `youAre` directly and cannot see it.

import { test, describe, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

const ME = 'p-2';

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

function installDom() {
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
  globalThis.location = { host: 'localhost', search: '', assign: () => {} };
  globalThis.history = { replaceState: () => {} };
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  globalThis.crypto ??= { randomUUID: () => '11111111-2222-4333-8444-555555555555' };
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

function racingState(extra = {}) {
  return {
    roomId: 'a-b-c',
    state: 'racing',
    raceLength: 3,
    difficulty: 'medium',
    players: [
      { id: 'p-1', handle: 'Hp-1', isGuest: false, score: 1, finishMs: null, dropped: false, dnf: false },
      { id: ME, handle: 'Hp-2', isGuest: false, score: 2, finishMs: null, dropped: false, dnf: false },
    ],
    problemSequence: [
      { problem: '1 + 1', answer: 2 },
      { problem: '2 + 2', answer: 4 },
      { problem: '3 + 3', answer: 6 },
    ],
    raceStartedAt: 10_000,
    countdownN: null,
    ...extra,
  };
}

describe('the lobby decides when a race screen may open', () => {
  let handoffs;

  beforeEach(() => {
    sockets.length = 0;
    installDom();
    handoffs = [];
  });

  function open({ mode } = {}) {
    const screens = { 'lobby-room': fakeEl(), race: fakeEl(), results: fakeEl() };
    attachLobby({
      roomId: 'a-b-c',
      screens,
      onRaceStart: (arg) => handoffs.push(arg),
      mode,
      deviceId: 'dev-1',
    });
    return sockets[sockets.length - 1];
  }

  for (const mode of [undefined, 'public']) {
    const label = mode === 'public' ? 'quick match' : 'private room';

    test(`${label}: the pre-hello snapshot does not open a race screen`, () => {
      const ws = open({ mode });
      // What the server sends on connect, before it knows whose seat this is.
      ws.push({ type: 'state', state: racingState(), youAre: null });
      assert.deepEqual(handoffs, [], 'no seat id, no race screen');
    });

    test(`${label}: the snapshot after hello opens it, exactly once`, () => {
      const ws = open({ mode });
      ws.push({ type: 'state', state: racingState(), youAre: null });
      ws.push({ type: 'state', state: racingState(), youAre: ME });
      ws.push({ type: 'state', state: racingState(), youAre: ME });

      assert.equal(handoffs.length, 1, 'handed off once');
      assert.equal(handoffs[0].youAre, ME);
      assert.equal(handoffs[0].initialState.state, 'racing');
    });

    test(`${label}: a countdown snapshot is gated on the seat id too`, () => {
      const ws = open({ mode });
      const counting = racingState({ state: 'countdown', countdownN: 2 });
      ws.push({ type: 'state', state: counting, youAre: null });
      assert.deepEqual(handoffs, []);
      ws.push({ type: 'state', state: counting, youAre: ME });
      assert.equal(handoffs.length, 1);
    });
  }
});

test('private lobby renders all ten seats and hands the complete roster to the race screen', () => {
  sockets.length = 0;
  const els = installDom();
  const handoffs = [];
  const cleanup = attachLobby({
    roomId: 'ten-racer-room',
    screens: { 'lobby-room': fakeEl(), race: fakeEl(), results: fakeEl() },
    onRaceStart: (args) => handoffs.push(args),
    deviceId: 'ten-device',
  });
  const ws = sockets.at(-1);
  const players = Array.from({ length: 10 }, (_, i) => ({
    id: `p-${i + 1}`, handle: `Racer${i + 1}`, isCreator: i === 0,
    score: 0, finishMs: null, dropped: false, dnf: false,
  }));
  const state = racingState({ players, state: 'lobby' });
  ws.push({ type: 'state', state, youAre: 'p-1' });
  const rows = els.get('room-players').children;
  assert.equal(rows.length, 10);
  assert.deepEqual(rows.map((row) => row.dataset.playerId), players.map((p) => p.id));
  assert.equal(els.get('start-race-btn').disabled, false);
  ws.push({ type: 'state', state: { ...state, state: 'countdown', countdownN: 3 }, youAre: 'p-1' });
  assert.equal(handoffs.length, 1);
  assert.deepEqual(handoffs[0].initialState.players, players);
  cleanup.detach();
});
