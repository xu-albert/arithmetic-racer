// The vendored partysocket (public/vendor/partysocket/ws.js) carries one local
// patch: on (re)open it runs the open handlers before flushing the messages it
// queued while the socket was down. room-client.js sends `hello` from its open
// handler, and the room drops anything that arrives before `hello` has given
// the socket a seat — so with upstream's order, answers typed during an outage
// were sent and then silently lost on reconnect.
//
// `npm run vendor` copies ws.js straight out of node_modules and would undo the
// patch without a word. This test is what notices.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import ReconnectingWebSocket from '../vendor/partysocket/ws.js';

// Just enough of a browser WebSocket for ReconnectingWebSocket to drive.
class FakeWebSocket extends EventTarget {
  static instances = [];
  constructor(url) {
    super();
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }
  send(data) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
  }
  // Test-side: the server accepted the connection.
  accept() {
    this.readyState = 1;
    this.dispatchEvent(new Event('open'));
  }
}

async function nextSocket() {
  const count = FakeWebSocket.instances.length;
  // Connecting is asynchronous (a delay, then URL resolution), so poll a few
  // macrotasks for the socket the wrapper constructs.
  for (let i = 0; i < 50 && FakeWebSocket.instances.length === count; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  assert.ok(FakeWebSocket.instances.length > count, 'the wrapper opened a socket');
  return FakeWebSocket.instances.at(-1);
}

test('on a reconnect, what was queued while offline goes out after the open handlers, not before', async () => {
  const rws = new ReconnectingWebSocket('ws://room.test', undefined, {
    WebSocket: FakeWebSocket,
    // Reconnect on the next tick rather than after upstream's 1-5s backoff.
    minReconnectionDelay: 1,
    maxReconnectionDelay: 1,
  });
  try {
    // What room-client.js does: identify on every open.
    rws.addEventListener('open', () => rws.send('hello'));
    const first = await nextSocket();
    first.accept();
    assert.deepEqual(first.sent, ['hello']);

    // The connection drops; answers typed now are queued by the wrapper.
    first.readyState = 3;
    first.dispatchEvent(new Event('close'));
    rws.send('answer-1');
    rws.send('answer-2');

    const second = await nextSocket();
    assert.deepEqual(second.sent, []);
    second.accept();
    assert.deepEqual(second.sent, ['hello', 'answer-1', 'answer-2']);
  } finally {
    rws.close();
  }
});
