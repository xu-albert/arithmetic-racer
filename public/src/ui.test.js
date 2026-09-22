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
// it is not exercised here. Its gate — the `youAre` condition in
// public/src/lobby.js — is covered in the sibling public/src/lobby-handoff.test.js.

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

// The bot ticker runs on requestAnimationFrame, which Node does not have:
// frames queue here and run only when a test flushes them, which is also how a
// background tab's throttling is reproduced.
let frames;
let nextFrameId;
let dom;
beforeEach(() => {
  frames = new Map();
  nextFrameId = 1;
  globalThis.requestAnimationFrame = (fn) => {
    const id = nextFrameId++;
    frames.set(id, fn);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => { frames.delete(id); };
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
  delete globalThis.requestAnimationFrame;
  delete globalThis.cancelAnimationFrame;
});

function flushFrame() {
  const pending = [...frames.values()];
  frames.clear();
  for (const fn of pending) fn();
}

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
  const laneFor = (laneId) => dom.el('track').children.find((l) => l.dataset.laneId === laneId);
  return {
    runner,
    cleanup,
    // What the room would push over the socket.
    receive: (msg) => { for (const l of [...listeners]) l(msg); },
    input: dom.el('answer-input'),
    score: dom.el('score'),
    banner: dom.el('finish-banner'),
    podium: dom.el('podium'),
    bannerPlace: dom.el('finish-banner').querySelector('.finish-banner-place'),
    bannerTime: dom.el('finish-banner').querySelector('.finish-banner-time'),
    laneFor,
    // Each lane holds a handle, the car and the finish line; the car is what
    // carries --progress and the victory class.
    carFor: (laneId) => laneFor(laneId).children.find((c) => c.className.startsWith('car')),
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

// An auto-reconnect does not build a new runner: PartySocket reattaches under
// the one already mounted, so `raceStartHandled` stays latched and the snapshot
// lands on a live screen. Everything below therefore reuses ONE runner across
// the disconnect — constructing a second one exercises the first-paint path
// instead, which is where these bugs hide.
describe('an authoritative snapshot landing on a mounted race screen', () => {
  test('rolls back a finish the room never received and reopens the input', () => {
    // 9/10 and the last answer's frame dies with the socket. The optimistic
    // client shows a finished race; the room still has the earlier score.
    mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 16_000 });
    const screen = openRaceScreen(racingState({
      players: [player('p-1'), player(ME, { score: SEQ.length - 1 })],
    }));
    screen.runner.submitAnswer(String(SEQ[SEQ.length - 1].answer));
    assert.equal(screen.input.disabled, true, 'optimistically finished');

    screen.receive({
      type: 'state',
      youAre: ME,
      state: racingState({ players: [player('p-1'), player(ME, { score: SEQ.length - 1 })] }),
    });

    assert.equal(screen.input.disabled, false, 'the race is still on; let them answer');
    assert.equal(screen.runner.racers[1].finishMs, null, 'the unacknowledged finish is revoked');
    assert.equal(screen.score.textContent, `${SEQ.length - 1} / ${SEQ.length}`);
    assert.deepEqual(screen.runner.currentProblemFor('player'), SEQ[SEQ.length - 1]);
    assert.equal(screen.banner.classList.contains('hidden'), true, 'and the banner goes with it');
    screen.cleanup();
  });

  test('repaints a place invalidated by an opponent finish missed while away', () => {
    const screen = openRaceScreen(racingState({
      players: [player('p-1'), player(ME, { score: SEQ.length, finishMs: 6_000 }), player('p-3')],
    }));
    assert.equal(screen.bannerPlace.textContent, '1st place');

    // While the socket was down p-1 finished ahead of them.
    screen.receive({
      type: 'state',
      youAre: ME,
      state: racingState({
        players: [
          player('p-1', { score: SEQ.length, finishMs: 5_000 }),
          player(ME, { score: SEQ.length, finishMs: 6_000 }),
          player('p-3'),
        ],
      }),
    });

    assert.equal(screen.bannerPlace.textContent, '2nd place');
    assert.equal(screen.carFor('player').classList.contains('victory'), false);
    assert.equal(screen.carFor('p-1').style.props['--progress'], String(1));
    screen.cleanup();
  });

  test('closes the input of a seat the room dropped while the socket was away', () => {
    const screen = openRaceScreen(racingState());
    assert.equal(screen.input.disabled, false);

    screen.receive({
      type: 'state',
      youAre: ME,
      state: racingState({
        players: [player('p-1', { score: 2 }), player(ME, { score: 1, dropped: true })],
      }),
    });

    assert.equal(screen.input.disabled, true, 'its answers are ignored on both sides');
    assert.equal(screen.laneFor('player').classList.contains('dropped'), true);
    screen.cleanup();
  });

  test('settles a race that ended on the deadline while the socket was away', () => {
    // `finish` is sent once. A socket that missed it gets a `finished`
    // snapshot instead, and that has to be the terminal transition.
    mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 80_000 });
    const screen = openRaceScreen(racingState());

    screen.receive({
      type: 'state',
      youAre: ME,
      state: racingState({
        state: 'finished',
        players: [
          player('p-1', { score: SEQ.length, finishMs: 5_000 }),
          player(ME, { score: 1, dnf: true }),
        ],
      }),
    });

    assert.equal(screen.input.disabled, true, 'the race is over');
    assert.equal(screen.runner.getState(), 'finished');
    assert.equal(screen.podium.childElementCount, 2, 'the final standings are shown');
    assert.match(screen.podium.children[0].textContent, /Hp-1/);
    screen.cleanup();
  });

  test('a settled race scores no further answers', () => {
    mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 80_000 });
    const screen = openRaceScreen(racingState());
    screen.receive({
      type: 'state',
      youAre: ME,
      state: racingState({ state: 'finished', players: [player('p-1'), player(ME, { score: 1, dnf: true })] }),
    });

    const before = screen.runner.racers[1].score;
    screen.runner.submitAnswer(String(SEQ[1].answer));
    assert.equal(screen.runner.racers[1].score, before, 'the room ignores it, so must we');
    screen.cleanup();
  });

  test('clears a banner whose finish the final result revoked', () => {
    // The deadline ended the race server-side while the last answer was in
    // flight; the room ignored it, so the authoritative result is a DNF.
    mock.timers.enable({ apis: ['Date', 'setTimeout'], now: 16_000 });
    const screen = openRaceScreen(racingState({
      players: [player('p-1'), player(ME, { score: SEQ.length - 1 })],
    }));
    screen.runner.submitAnswer(String(SEQ[SEQ.length - 1].answer));
    assert.equal(screen.banner.classList.contains('hidden'), false, 'optimistically announced');

    screen.receive({
      type: 'finish',
      rankings: [
        { id: 'p-1', score: 0, finishMs: null, dnf: true },
        { id: ME, score: SEQ.length - 1, finishMs: null, dnf: true },
      ],
    });

    assert.equal(screen.banner.classList.contains('hidden'), true, 'no finish, no banner');
    assert.equal(screen.banner.classList.contains('first-place'), false);
    assert.equal(screen.carFor('player').classList.contains('victory'), false);
    screen.cleanup();
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

  test('counts the bots that were already home when Quick Match is reloaded', () => {
    // Quick Match. The room holds every bot at score 0 / finishMs null until it
    // finalizes them, so the snapshot a reloading finisher gets shows no bot
    // ahead of them; only the timelines it ships do. Elapsed is 7s, the bot
    // crossed at 3s and the room stamped this player at 5s.
    mock.timers.enable({ apis: ['Date'], now: 17_000 });
    const screen = openRaceScreen(racingState({
      players: [
        player('bot-1', { isBot: true, tier: 'fast' }),
        player(ME, { score: SEQ.length, finishMs: 5_000 }),
        player('p-1', { score: 1 }),
      ],
      botTimelines: [[1_000, 2_000, 3_000]],
    }));

    assert.equal(screen.bannerPlace.textContent, '2nd place');
    assert.equal(screen.banner.classList.contains('first-place'), false);
    assert.equal(screen.carFor('player').classList.contains('victory'), false);
    assert.equal(screen.carFor('bot-1').style.props['--progress'], '1',
      'the bot is replayed at the line, not left at the start');
  });

  test('repaints when a finish that beat the player lands after the banner is up', () => {
    // The bot ticker runs on requestAnimationFrame, which a background tab
    // throttles hard: a bot can cross the line seconds before the frame that
    // reports it, and that frame can land after the player's own finish.
    mock.timers.enable({ apis: ['Date'], now: 10_000 });
    const screen = openRaceScreen(racingState({
      players: [player('bot-1', { isBot: true, tier: 'fast' }), player(ME, { score: SEQ.length - 1 })],
      botTimelines: [[500, 1_000, 2_000]],
    }));

    mock.timers.setTime(13_000);
    screen.runner.submitAnswer(String(SEQ[SEQ.length - 1].answer));
    assert.equal(screen.bannerPlace.textContent, '1st place', 'nothing on screen says otherwise yet');
    assert.equal(screen.carFor('player').classList.contains('victory'), true);

    flushFrame();

    assert.equal(screen.bannerPlace.textContent, '2nd place');
    assert.equal(screen.banner.classList.contains('first-place'), false);
    assert.equal(screen.carFor('player').classList.contains('victory'), false);
  });

  test('repaints when the finisher ahead of the player leaves before the race ends', () => {
    // A crossed at 5s and you at 6s, so the banner is right to say 2nd. A then
    // quits while C is still racing, which forfeits their finish — the ranking
    // the room will persist now has you first, and so does the screen.
    mock.timers.enable({ apis: ['Date'], now: 16_000 });
    const screen = openRaceScreen(racingState({
      players: [
        player('p-1', { score: SEQ.length, finishMs: 5_000 }),
        player(ME, { score: SEQ.length - 1 }),
        player('p-3', { score: 1 }),
      ],
    }));

    screen.runner.submitAnswer(String(SEQ[SEQ.length - 1].answer));
    assert.equal(screen.bannerPlace.textContent, '2nd place');
    assert.equal(screen.carFor('player').classList.contains('victory'), false);

    // Synthetic: the current server does not drop a seat that already finished
    // (see the note on the next test). This drives the banner's reaction to a
    // ranking change, which is what the assertions below are about.
    screen.receive({ type: 'drop', playerId: 'p-1' });

    assert.equal(screen.bannerPlace.textContent, '1st place');
    assert.equal(screen.banner.classList.contains('first-place'), true);
    assert.equal(screen.carFor('player').classList.contains('victory'), true);

    screen.receive({
      type: 'finish',
      rankings: [
        { id: ME, score: SEQ.length, finishMs: 6_000 },
        { id: 'p-3', score: SEQ.length, finishMs: 8_000 },
        { id: 'p-1', score: SEQ.length, finishMs: 5_000, dropped: true },
      ],
    });

    assert.equal(screen.bannerPlace.textContent, '1st place');
    assert.match(screen.podium.children[0].textContent, /\(you\)/,
      'the podium the banner sits above puts the player first');
    screen.cleanup();
  });

  test('a winner who quits keeps their finish, and the runner stays second', () => {
    // The contract current main actually implements: an earned finish survives
    // a quit or a close. p-1 finished at 5s and left; the room keeps the seat
    // with its finishMs, so the player who finishes later is still second.
    mock.timers.enable({ apis: ['Date'], now: 16_000 });
    const screen = openRaceScreen(racingState({
      players: [
        player('p-1', { score: SEQ.length, finishMs: 5_000 }),
        player(ME, { score: SEQ.length - 1 }),
      ],
    }));

    screen.runner.submitAnswer(String(SEQ[SEQ.length - 1].answer));
    assert.equal(screen.bannerPlace.textContent, '2nd place');

    // They close the tab. The server does NOT drop them — it keeps the seat and
    // its finish — so what reaches this client is a snapshot, not a `drop`.
    screen.receive({
      type: 'state',
      youAre: ME,
      state: racingState({
        players: [
          player('p-1', { score: SEQ.length, finishMs: 5_000 }),
          player(ME, { score: SEQ.length, finishMs: 6_000 }),
        ],
      }),
    });

    assert.equal(screen.bannerPlace.textContent, '2nd place', 'their finish still counts');
    assert.equal(screen.banner.classList.contains('first-place'), false);
    assert.equal(screen.carFor('player').classList.contains('victory'), false);
    screen.cleanup();
  });

  test('does not rank a dropped finisher ahead of the player', () => {
    // Synthetic ranking input, not a sequence today's server produces: it will
    // not drop a seat that already has a finishMs (server/room.js dropRacer,
    // and PublicRaceRoom holds a departed finisher's seat). Kept because
    // rankings.js tiering must stay correct for any dropped/DNF seat, and the
    // banner must read the same tiering the podium does. The behaviour the
    // current server does produce is the test below this one.
    mock.timers.enable({ apis: ['Date'], now: 16_000 });
    const screen = openRaceScreen(racingState({
      players: [
        player('p-1', { score: SEQ.length, finishMs: 5_000, dropped: true }),
        player(ME, { score: SEQ.length - 1 }),
      ],
    }));

    screen.runner.submitAnswer(String(SEQ[SEQ.length - 1].answer));
    screen.receive({ type: 'advance', playerId: ME, score: SEQ.length, finishMs: 6_000 });

    assert.equal(screen.bannerPlace.textContent, '1st place');
    assert.equal(screen.banner.classList.contains('first-place'), true);
    assert.equal(screen.carFor('player').classList.contains('victory'), true);

    screen.receive({
      type: 'finish',
      rankings: [
        { id: ME, score: SEQ.length, finishMs: 6_000 },
        { id: 'p-1', score: SEQ.length, finishMs: 5_000, dropped: true },
      ],
    });

    assert.equal(screen.bannerPlace.textContent, '1st place');
    assert.match(screen.podium.children[0].textContent, /\(you\)/,
      'the podium the banner sits above puts the player first');
    screen.cleanup();
  });

  test('agrees with the podium when the final rankings carry a finish the screen never saw', () => {
    // Quick Match in a background tab, browser clock behind the room's: the bot
    // crossed at 2s, but the frame that would report it never ran and the
    // elapsed this browser computes has not reached it either. The race ends on
    // the other human, so the room's rankings are the first thing on this
    // screen to say the bot is home — after the banner is already up.
    mock.timers.enable({ apis: ['Date'], now: 11_000 });
    const screen = openRaceScreen(racingState({
      players: [
        player('bot-1', { isBot: true, tier: 'fast' }),
        player(ME, { score: SEQ.length - 1 }),
        player('p-1', { score: 1 }),
      ],
      botTimelines: [[500, 1_000, 2_000]],
    }));

    screen.runner.submitAnswer(String(SEQ[SEQ.length - 1].answer));
    screen.receive({ type: 'advance', playerId: ME, score: SEQ.length, finishMs: 12_000 });
    assert.equal(screen.bannerPlace.textContent, '1st place', 'nothing on screen says otherwise yet');

    screen.receive({
      type: 'finish',
      rankings: [
        { id: 'bot-1', score: SEQ.length, finishMs: 2_000 },
        { id: ME, score: SEQ.length, finishMs: 12_000 },
        { id: 'p-1', score: SEQ.length, finishMs: 14_000 },
      ],
    });

    assert.equal(screen.bannerPlace.textContent, '2nd place');
    assert.equal(screen.banner.classList.contains('first-place'), false);
    assert.equal(screen.carFor('player').classList.contains('victory'), false);
    assert.match(screen.podium.children[0].textContent, /^Hbot-1 —/,
      'the podium the banner sits above puts the bot first');
    screen.cleanup();
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

describe('ten-player private-room race screen', () => {
  test('renders ten lanes and all final standings, including a tenth-place local racer', () => {
    mock.timers.enable({ apis: ['setTimeout'] });
    const players = Array.from({ length: 10 }, (_, i) => player(`p-${i + 1}`, { handle: `Racer${i + 1}` }));
    const screen = openRaceScreen(racingState({ players }), 'p-10');
    assert.equal(dom.el('track').children.length, 10);
    assert.equal(screen.input.disabled, false);
    for (const [i, p] of players.entries()) {
      screen.receive({ type: 'advance', playerId: p.id, score: SEQ.length, finishMs: 20_000 + i * 1000 });
      assert.equal(screen.carFor(p.id === 'p-10' ? 'player' : p.id).style.props['--progress'], '1');
    }
    screen.receive({ type: 'finish', rankings: players.map((p, i) => ({ ...p, score: SEQ.length, finishMs: 20_000 + i * 1000 })) });
    mock.timers.tick(2000);
    assert.equal(screen.podium.children.length, 10);
    assert.deepEqual(screen.podium.children.map((row) => row.textContent), players.map((p, i) =>
      `${p.handle}${i === 9 ? ' (you)' : ''} — 3/3 in ${(20 + i).toFixed(1)}s`));
    assert.equal(screen.bannerPlace.textContent, '10th place');
    assert.equal(screen.input.disabled, true);
    screen.cleanup();
    screen.runner.stop();
  });
});
