// The race screen, driven by a real remote runner over a DOM small enough to
// run on `node --test` (docs/testing.md). What is stubbed here is the browser,
// not our code.
//
// The cases that matter are the ones only a reconnect reaches. `attachRaceUI`
// paints from zero — input disabled, every car at the line, score 0/N — and
// then reacts to events; on the live path those events arrive in the order the
// race happens in, and several of its assumptions quietly ride on that. A
// runner built from a mid-race snapshot replays them all at once instead, which
// is where "the newest finisher is in first place" and "a lane is live until a
// `drop` arrives" stop being true.
//
// Coverage note: `attachLobby` is what decides *when* to build that runner, and
// it is not exercised here — it needs the full lobby DOM and a real PartySocket.
// Its gate is the `youAre` condition in public/src/lobby.js.

import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
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
    classes,
    children: [],
    dataset: {},
    className: '',
    value: '',
    disabled: false,
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
    focus: () => {},
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
  mock.timers.reset();
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

/** What main.js's handleRoomRaceStart does once the lobby hands a snapshot over. */
function openRaceScreen(state, youAre = ME) {
  const listeners = new Set();
  const roomClient = {
    on: (h) => { listeners.add(h); return () => listeners.delete(h); },
    send: () => {},
  };
  const screens = { race: fakeEl(), results: fakeEl() };
  const runner = createRemoteRunner({ roomClient, initialState: state, youAre });
  const cleanup = attachRaceUI({ runner, raceLength: state.raceLength, screens });
  const laneFor = (racerId) => dom.el('track').children.find((l) => l.dataset.racerId === racerId);
  return {
    runner,
    cleanup,
    // What the room would push over the socket.
    receive: (msg) => { for (const l of [...listeners]) l(msg); },
    input: dom.el('answer-input'),
    score: dom.el('score'),
    banner: dom.el('finish-banner'),
    bannerPlace: dom.el('finish-banner').querySelector('.finish-banner-place'),
    bannerTime: dom.el('finish-banner').querySelector('.finish-banner-time'),
    laneFor,
    // Each lane holds a handle, the car and the finish line; the car is what
    // carries --progress and the victory class.
    carFor: (racerId) => laneFor(racerId).children.find((c) => c.className.startsWith('car')),
  };
}

describe('a race screen opened from a mid-race snapshot', () => {
  test('lands the player on a live, typeable race with the cars where the room left them', () => {
    const screen = openRaceScreen(racingState());

    assert.equal(screen.input.disabled, false, 'the answer input must be typeable');
    assert.equal(screen.score.textContent, `1 / ${SEQ.length}`);
    assert.deepEqual(screen.runner.currentProblemFor('player'), SEQ[1]);
    assert.equal(screen.carFor('p-1').style.props['--progress'], String(2 / SEQ.length));
  });

  test('a player the room already dropped gets a read-only screen, not a dead input', () => {
    // Their socket died and the 30s grace expired, so the seat is kept but
    // dropped; the server ignores its answers and so does submitAnswer.
    const screen = openRaceScreen(racingState({
      players: [player('p-1', { score: 2 }), player(ME, { score: 1, dropped: true })],
    }));

    assert.equal(screen.input.disabled, true, 'typing into a dropped seat does nothing');
    assert.equal(screen.laneFor('player').classList.contains('dropped'), true);
    // The car still shows where they got to.
    assert.equal(screen.score.textContent, `1 / ${SEQ.length}`);
  });

  test("a dropped opponent's lane is greyed out on the first paint", () => {
    const screen = openRaceScreen(racingState({
      players: [player('p-1', { score: 2, dropped: true }), player(ME, { score: 1 })],
    }));

    assert.equal(screen.laneFor('p-1').classList.contains('dropped'), true);
    assert.equal(screen.laneFor('player').classList.contains('dropped'), false);
    assert.equal(screen.input.disabled, false, 'an opponent dropping does not end your race');
  });
});

describe('the finish banner', () => {
  test('reports the place the player actually finished in, not how many have finished since', () => {
    // You won at 5s; B finished at 6s; C is still racing, so the room is still
    // `racing` when you reload at 7s.
    const screen = openRaceScreen(racingState({
      players: [
        player(ME, { score: SEQ.length, finishMs: 5_000 }),
        player('p-1', { score: SEQ.length, finishMs: 6_000 }),
        player('p-3', { score: 1 }),
      ],
    }));

    assert.equal(screen.bannerPlace.textContent, '1st place');
    assert.equal(screen.banner.classList.contains('first-place'), true);
    assert.equal(screen.carFor('player').classList.contains('victory'), true);
  });

  test('still reports the place correctly when the player finished behind someone', () => {
    const screen = openRaceScreen(racingState({
      players: [
        player('p-1', { score: SEQ.length, finishMs: 4_000 }),
        player(ME, { score: SEQ.length, finishMs: 5_000 }),
        player('p-3', { score: 1 }),
      ],
    }));

    assert.equal(screen.bannerPlace.textContent, '2nd place');
    assert.equal(screen.banner.classList.contains('first-place'), false);
  });

  test('settles on the place and time the room measured, not this browser\'s clock', () => {
    // Live path, no reconnect. The room started the race at 10_000 on its own
    // clock and this browser's is 10s behind it, so the elapsed the browser
    // computes for the player (-3s) sorts them ahead of an opponent who
    // really beat them to the line.
    mock.timers.enable({ apis: ['Date'], now: 7_000 });
    const screen = openRaceScreen(racingState({
      players: [player('p-1'), player(ME, { score: SEQ.length - 1 })],
    }));

    screen.receive({ type: 'advance', playerId: 'p-1', score: SEQ.length, finishMs: 6_000 });
    screen.runner.submitAnswer(String(SEQ[SEQ.length - 1].answer));
    screen.receive({ type: 'advance', playerId: ME, score: SEQ.length, finishMs: 7_000 });

    assert.equal(screen.bannerPlace.textContent, '2nd place');
    assert.equal(screen.bannerTime.textContent, '7.00s');
    assert.equal(screen.banner.classList.contains('first-place'), false);
    assert.equal(screen.carFor('player').classList.contains('victory'), false,
      'a win the skewed clock briefly claimed has to come back off');
  });

  test('a player who answers their way to the line still sees 1st on the live path', () => {
    const screen = openRaceScreen(racingState({
      players: [player('p-1', { score: 1 }), player(ME, { score: SEQ.length - 1 })],
    }));

    screen.runner.submitAnswer(String(SEQ[SEQ.length - 1].answer));

    assert.equal(screen.bannerPlace.textContent, '1st place');
    assert.equal(screen.input.disabled, true, 'the race is over for them');
  });
});
