// The quick-match dead-end requeue, over the real attachLobby and room client.
//
// A hello can be refused because the router's pointer outlived the room
// (MATCH_OVER: started/finished; ROOM_FULL: six humans already seated). The
// room re-attempts its router release as it refuses, so the lobby re-runs
// matchmaking on its own and navigates to the fresh room — bounded by the
// `rq` counter in the URL, because entering a room is a full-page navigation
// and a pointer that stays stale anyway must not loop forever. Only the
// browser is stubbed: PartySocket, the DOM, fetch and location.assign.

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
  globalThis.fetch = async (url, opts) => {
    fetches.push({ url, body: JSON.parse(opts.body) });
    return {
      ok: true,
      status: 200,
      json: async () => ({ roomId: 'm-fresh-room', mode: 'public', difficulty: 'medium' }),
    };
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

/** Let the async requeue (fetch + navigation) run to completion. */
async function flush(times = 5) {
  for (let i = 0; i < times; i++) await new Promise((r) => setImmediate(r));
}

function open({ mode, difficulty = 'easy', search } = {}) {
  const els = installDom({ search });
  attachLobby({
    roomId: 'm-old-room',
    screens: { 'lobby-room': fakeEl(), race: fakeEl(), results: fakeEl() },
    mode,
    difficulty,
    deviceId: 'dev-1',
  });
  return { ws: sockets[sockets.length - 1], els };
}

describe('quick-match dead-end errors re-run matchmaking', () => {
  beforeEach(() => {
    sockets.length = 0;
  });

  for (const code of ['MATCH_OVER', 'ROOM_FULL']) {
    test(`${code}: requeues once and navigates to the fresh room with rq bumped`, async () => {
      const { ws } = open({ mode: 'public', difficulty: 'easy' });
      ws.push({ type: 'error', code, message: 'dead end' });
      await flush();

      assert.equal(fetches.length, 1);
      assert.equal(fetches[0].url, '/api/matchmake/join');
      assert.deepEqual(fetches[0].body, { difficulty: 'easy', device_id: 'dev-1' });
      assert.equal(assigns.length, 1);
      assert.equal(
        assigns[0],
        '/?room=m-fresh-room&mode=public&difficulty=medium&rq=1',
      );
    });
  }

  test('the rq counter in the URL survives navigation and bounds the loop', async () => {
    const { ws } = open({ mode: 'public', search: '/?room=m-old-room&mode=public&difficulty=easy&rq=1' });
    ws.push({ type: 'error', code: 'MATCH_OVER', message: 'This match has ended' });
    await flush();

    assert.equal(fetches.length, 1);
    assert.match(assigns[0], /&rq=2$/);
  });

  test('at the requeue cap the error is surfaced instead of looping', async () => {
    const { ws, els } = open({ mode: 'public', search: '/?room=m-newer&mode=public&difficulty=easy&rq=2' });
    ws.push({ type: 'error', code: 'MATCH_OVER', message: 'This match has ended; find a new match.' });
    await flush();

    assert.equal(fetches.length, 0);
    assert.equal(assigns.length, 0);
    assert.equal(els.get('error-toast').textContent, 'This match has ended; find a new match.');
  });

  test('a failed requeue (rate limited) shows the error rather than navigating', async () => {
    const { ws, els } = open({ mode: 'public' });
    globalThis.fetch = async () => ({ ok: false, status: 429, json: async () => ({}) });
    ws.push({ type: 'error', code: 'ROOM_FULL', message: 'This room is full' });
    await flush();

    assert.equal(assigns.length, 0);
    assert.equal(els.get('error-toast').textContent, 'Slow down — too many queue attempts');
  });

  test('private rooms never requeue: the same error is a plain toast', async () => {
    const { ws, els } = open({ mode: undefined });
    ws.push({ type: 'error', code: 'MATCH_OVER', message: 'some error' });
    await flush();

    assert.equal(fetches.length, 0);
    assert.equal(assigns.length, 0);
    assert.equal(els.get('error-toast').textContent, 'some error');
  });

  test('other error codes in quick match stay plain toasts', async () => {
    const { ws, els } = open({ mode: 'public' });
    ws.push({ type: 'error', code: 'BAD_DIFFICULTY', message: 'locked' });
    await flush();

    assert.equal(fetches.length, 0);
    assert.equal(els.get('error-toast').textContent, 'locked');
  });
});
