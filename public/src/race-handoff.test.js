// The reload-mid-race path, driven end to end: the real handoff latch, the real
// remote runner and the real race screen, against a DOM small enough to run on
// `node --test` (docs/testing.md).
//
// The sequence under test is the one a browser actually sees when a player
// reloads during a race, and its first message is the trap: the server pushes
// `state` from `onConnect`, before `hello` has identified the seat, so that
// snapshot says `racing` and `youAre: null` at the same time. Handing it
// straight to the race screen builds a runner with nobody aliased to 'player',
// and attachRaceUI reads that racer's score before it subscribes to anything —
// so the screen throws with the answer input still disabled and no way to retry.
//
// What is stubbed here is the browser, not our code.

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRaceHandoffLatch } from './race-handoff.js';
import { createRemoteRunner } from './remote-runner.js';
import { attachRaceUI } from './ui.js';

const ME = 'p-2';
const SEQ = [
  { problem: '1 + 1', answer: 2 },
  { problem: '2 + 2', answer: 4 },
  { problem: '3 + 3', answer: 6 },
];

// --- a DOM small enough to run on node --test -------------------------------

function fakeEl(tag = 'div') {
  const classes = new Set();
  const selectorCache = new Map();
  const el = {
    tag,
    children: [],
    dataset: {},
    className: '',
    value: '',
    disabled: false,
    focusCount: 0,
    offsetHeight: 20,
    style: { props: {}, setProperty: (k, v) => { el.style.props[k] = v; } },
    classList: {
      add: (...cs) => cs.forEach((c) => classes.add(c)),
      remove: (...cs) => cs.forEach((c) => classes.delete(c)),
      contains: (c) => classes.has(c),
      toggle: (c, on) => {
        const want = on === undefined ? !classes.has(c) : on;
        if (want) classes.add(c); else classes.delete(c);
        return want;
      },
    },
    append: (...kids) => el.children.push(...kids),
    addEventListener: () => {},
    removeEventListener: () => {},
    focus: () => { el.focusCount += 1; },
    // The only element asked for descendants by selector is #problem-queue
    // ('.queue-item'), and it wants the ones it was just appended.
    querySelectorAll: () => el.children,
    querySelector: (sel) => {
      if (!selectorCache.has(sel)) selectorCache.set(sel, fakeEl());
      return selectorCache.get(sel);
    },
  };
  let text = '';
  Object.defineProperty(el, 'textContent', { get: () => text, set: (v) => { text = v; } });
  Object.defineProperty(el, 'innerHTML', { get: () => '', set: () => { el.children.length = 0; } });
  Object.defineProperty(el, 'childElementCount', { get: () => el.children.length });
  return el;
}

let dom;
beforeEach(() => {
  const byId = new Map();
  dom = {
    byId,
    el(id) {
      if (!byId.has(id)) byId.set(id, fakeEl());
      return byId.get(id);
    },
  };
  globalThis.document = {
    getElementById: (id) => dom.el(id),
    createElement: (tag) => fakeEl(tag),
    // No bug-report link and no open modal in this harness.
    querySelector: () => null,
    querySelectorAll: () => [],
    body: fakeEl('body'),
    activeElement: null,
  };
  globalThis.window = { addEventListener: () => {}, removeEventListener: () => {} };
});
afterEach(() => {
  delete globalThis.document;
  delete globalThis.window;
});

// --- the room, as the server puts it on the wire ----------------------------

function player(id, extra = {}) {
  return { id, handle: `H${id}`, isGuest: false, score: 0, finishMs: null, dropped: false, dnf: false, ...extra };
}

function racingState(extra = {}) {
  return {
    raceLength: SEQ.length,
    state: 'racing',
    players: [player('p-1', { score: 2 }), player(ME, { score: 1 })],
    problemSequence: SEQ,
    raceStartedAt: 10_000,
    ...extra,
  };
}

/**
 * The page, minus its lobby chrome: a socket, the real handoff gate wired the
 * way lobby.js wires it, and main.js's handleRoomRaceStart on the other side.
 */
function openPage() {
  const listeners = new Set();
  const sent = [];
  const roomClient = {
    on(handler) { listeners.add(handler); return () => listeners.delete(handler); },
    send(msg) { sent.push(msg); },
  };
  const screens = { race: fakeEl(), results: fakeEl() };
  const startEvents = [];
  let runner = null;
  let cleanup = null;

  const raceHandoff = createRaceHandoffLatch({
    onRaceStart: (state, youAre) => {
      if (cleanup) { cleanup(); cleanup = null; }
      runner = createRemoteRunner({ roomClient, initialState: state, youAre });
      // Observe the stream attachRaceUI actually receives rather than
      // subscribing alongside it: a start owed from before anybody was
      // listening is paid to the *first* subscriber, so a second listener
      // ahead of the race screen would take it away from the race screen.
      const observed = {
        ...runner,
        on: (handler) => runner.on((event, data) => {
          if (event === 'start') startEvents.push(event);
          handler(event, data);
        }),
      };
      cleanup = attachRaceUI({ runner: observed, raceLength: state.raceLength, screens });
    },
  });
  roomClient.on((msg) => {
    if (msg.type === 'state') raceHandoff.handle(msg.state, msg.youAre);
  });

  return {
    sent,
    screens,
    startEvents,
    raceHandoff,
    get runner() { return runner; },
    get raceScreenAttached() { return cleanup != null; },
    get input() { return dom.el('answer-input'); },
    get score() { return dom.el('score').textContent; },
    receive(msg) { for (const l of [...listeners]) l(msg); },
  };
}

describe('reloading during a race', () => {
  test('the pre-hello snapshot is not the handoff; the keyed one that follows is', () => {
    const page = openPage();

    // 1. onConnect: the room is racing, but this socket has not proved its seat.
    page.receive({ type: 'state', state: racingState(), youAre: null });
    assert.equal(page.raceScreenAttached, false, 'race screen must wait for a seat id');
    assert.equal(page.startEvents.length, 0);

    // 2. hello reattaches the seat; the server broadcasts state again, keyed.
    page.receive({ type: 'hello-ack', playerId: ME, handle: `H${ME}` });
    page.receive({ type: 'state', state: racingState(), youAre: ME });

    // 3. A live, playable race: input enabled, cars and score off zero.
    assert.equal(page.raceScreenAttached, true);
    assert.deepEqual(page.startEvents, ['start']);
    assert.equal(page.input.disabled, false, 'the answer input must be typeable');
    assert.equal(page.score, `1 / ${SEQ.length}`);
    assert.deepEqual(page.runner.currentProblemFor('player'), SEQ[1]);
  });

  test('the snapshots that keep arriving do not start the race a second time', () => {
    const page = openPage();
    page.receive({ type: 'state', state: racingState(), youAre: null });
    page.receive({ type: 'state', state: racingState(), youAre: ME });
    const firstRunner = page.runner;

    page.receive({ type: 'state', state: racingState({ players: [player('p-1', { score: 3 }), player(ME, { score: 1 })] }), youAre: ME });

    assert.deepEqual(page.startEvents, ['start']);
    assert.equal(page.runner, firstRunner, 'the race screen is rebuilt at most once per race');
    assert.equal(page.input.disabled, false);
  });

  test('a visitor the room refuses mid-race is left in the lobby, not on a broken race screen', () => {
    // hello from a browser with no seat here is answered with BAD_STATE, so no
    // keyed snapshot ever arrives and youAre stays null for this socket.
    const page = openPage();
    page.receive({ type: 'state', state: racingState(), youAre: null });
    page.receive({ type: 'error', code: 'BAD_STATE', message: 'Race already in progress' });
    page.receive({ type: 'state', state: racingState(), youAre: null });

    assert.equal(page.raceScreenAttached, false);
    assert.equal(page.startEvents.length, 0);
  });

  test('the countdown handoff waits for the seat id too', () => {
    const page = openPage();
    const countdown = racingState({ state: 'countdown', countdownN: 2, players: [player('p-1'), player(ME)] });
    page.receive({ type: 'state', state: countdown, youAre: null });
    assert.equal(page.raceScreenAttached, false);

    page.receive({ type: 'state', state: countdown, youAre: ME });
    assert.equal(page.raceScreenAttached, true);
    // Still counting down: nothing to type into yet.
    assert.equal(page.input.disabled, true);
  });
});

describe('the handoff latch', () => {
  test('re-arming after a rematch hands off to the next race', () => {
    const page = openPage();
    page.receive({ type: 'state', state: racingState(), youAre: ME });
    const firstRunner = page.runner;

    // Rematch: the room returns to lobby, and lobby.js re-arms.
    page.raceHandoff.rearm();
    page.receive({ type: 'state', state: racingState({ players: [player('p-1'), player(ME)] }), youAre: ME });

    assert.notEqual(page.runner, firstRunner);
    assert.deepEqual(page.startEvents, ['start', 'start']);
    assert.equal(page.score, `0 / ${SEQ.length}`);
  });

  test('lobby and finished snapshots are not a handoff', () => {
    const handled = [];
    const latch = createRaceHandoffLatch({ onRaceStart: (s) => handled.push(s.state) });
    assert.equal(latch.handle({ state: 'lobby' }, ME), false);
    assert.equal(latch.handle({ state: 'finished' }, ME), false);
    assert.equal(latch.handle({ state: 'racing' }, ME), true);
    assert.deepEqual(handled, ['racing']);
  });
});
