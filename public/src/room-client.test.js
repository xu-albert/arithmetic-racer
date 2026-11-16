// The real room client over stubbed browser parts: PartySocket, location,
// localStorage and the page the pagehide/pageshow events fire on.
//
// Back/forward cache: following a link mid-race froze the page with its socket
// open, so the room never got a close: the seat stayed connected, its
// reconnect grace never started, and a racer who had left was never dropped.
//
// Names: the hello offers the one guest name solo also uses, and a username
// the room seats a signed-in player under is never kept as that guest name.

import { test, describe, beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';

const sockets = [];
class FakePartySocket {
  constructor(opts) {
    this.opts = opts;
    this.listeners = {};
    this.sent = [];
    this.closes = 0;
    this.reconnects = 0;
    sockets.push(this);
  }
  addEventListener(kind, fn) { (this.listeners[kind] ||= []).push(fn); }
  removeEventListener() {}
  send(raw) { this.sent.push(JSON.parse(raw)); }
  close() { this.closes++; }
  reconnect() { this.reconnects++; }
  opened() { for (const fn of this.listeners.open ?? []) fn(); }
  push(obj) { for (const fn of this.listeners.message ?? []) fn({ data: JSON.stringify(obj) }); }
}

mock.module('partysocket', { defaultExport: FakePartySocket });

const { createRoomClient } = await import('./room-client.js');

function installBrowser() {
  globalThis.location = { host: 'localhost' };
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
  };
  globalThis.crypto ??= { randomUUID: () => '11111111-2222-4333-8444-555555555555' };
}

function openClient() {
  const page = new EventTarget();
  const client = createRoomClient({ roomId: 'a-b-c', page });
  const fire = (type, persisted) => {
    const e = new Event(type);
    e.persisted = persisted;
    page.dispatchEvent(e);
  };
  return { client, ws: sockets[sockets.length - 1], fire };
}

describe('the room socket and the back/forward cache', () => {
  beforeEach(() => {
    sockets.length = 0;
    installBrowser();
  });

  test('entering the cache closes the socket, so the room starts the seat\'s grace', () => {
    const { ws, fire } = openClient();
    fire('pagehide', true);
    assert.equal(ws.closes, 1);
  });

  test('coming back out reconnects, which reclaims the seat through hello', () => {
    const { ws, fire } = openClient();
    fire('pagehide', true);
    fire('pageshow', true);
    assert.equal(ws.reconnects, 1);
  });

  test('a page that is really unloading, or an ordinary first show, is left to the browser', () => {
    const { ws, fire } = openClient();
    fire('pageshow', false);
    fire('pagehide', false);
    fire('pageshow', true);
    assert.equal(ws.closes, 0);
    assert.equal(ws.reconnects, 0);
  });

  test('a room this page closed on purpose stays closed after a trip through the cache', () => {
    // Refusal, expiry and Leave all close the client; restoring the page must
    // not reopen a room the lobby already walked away from.
    const { client, ws, fire } = openClient();
    client.close();
    fire('pagehide', true);
    fire('pageshow', true);
    assert.equal(ws.closes, 1);
    assert.equal(ws.reconnects, 0);
  });
});

describe('the name the room client offers and keeps', () => {
  beforeEach(() => {
    sockets.length = 0;
    installBrowser();
  });

  test('a guest who raced solo first is offered to the room under that same name', () => {
    localStorage.setItem('anonHandle', 'ZestyHare');
    const { ws } = openClient();
    ws.opened();
    assert.equal(ws.sent[0].type, 'hello');
    assert.equal(ws.sent[0].handle, 'ZestyHare');
  });

  test('a room-issued guest handle is kept, and is what solo races under next', async () => {
    const { getGuestHandle } = await import('./identity.js');
    const { ws } = openClient();
    ws.opened();
    ws.push({ type: 'hello-ack', playerId: 'p-1', handle: 'JollyHeron', handleFromAccount: false });
    assert.equal(localStorage.getItem('racerHandle'), 'JollyHeron');
    assert.equal(getGuestHandle(), 'JollyHeron');
  });

  test('a username the room seated this player under is not kept as the guest name', () => {
    localStorage.setItem('racerHandle', 'JollyHeron');
    const { ws } = openClient();
    ws.opened();
    ws.push({ type: 'hello-ack', playerId: 'p-1', handle: 'RealRacer', handleFromAccount: true });
    assert.equal(localStorage.getItem('racerHandle'), 'JollyHeron');
  });
});
