// The multiplayer race client. Everything the room server puts on the wire
// lands here and is turned into the same events ui.js gets from the solo
// runner, so a regression in this file breaks every room race — and until
// these tests it had no coverage at all.
//
// The server is a fake roomClient: a listener set plus a log of what was sent.
// requestAnimationFrame is shimmed onto globalThis for the bot ticker, and
// Date is mocked so "elapsed since race start" is under test control.

import { test, describe, beforeEach, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteRunner } from './remote-runner.js';

const ME = 'p-2';
const SEQ = [
  { problem: '1 + 1', answer: 2 },
  { problem: '2 + 2', answer: 4 },
  { problem: '3 + 3', answer: 6 },
];

function fakeRoomClient() {
  const listeners = new Set();
  const sent = [];
  return {
    sent,
    on(handler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },
    send(msg) {
      sent.push(msg);
    },
    // Test-side: what the server would push.
    receive(msg) {
      for (const l of [...listeners]) l(msg);
    },
    get listenerCount() {
      return listeners.size;
    },
  };
}

function player(id, extra = {}) {
  return { id, handle: `H${id}`, isGuest: false, score: 0, finishMs: null, dropped: false, dnf: false, ...extra };
}

function lobbyState(extra = {}) {
  return {
    raceLength: SEQ.length,
    state: 'lobby',
    players: [player('p-1'), player(ME, { isGuest: true })],
    problemSequence: [],
    raceStartedAt: null,
    ...extra,
  };
}

function record(runner) {
  const events = [];
  runner.on((event, data) => events.push({ event, data }));
  return events;
}

function startRace(client, at = 10_000) {
  client.receive({ type: 'race-start', sequence: SEQ, raceStartedAt: at });
}

// requestAnimationFrame shim: frames queue and run only when the test flushes.
let frames;
let nextFrameId;
beforeEach(() => {
  frames = new Map();
  nextFrameId = 1;
  globalThis.requestAnimationFrame = (fn) => {
    const id = nextFrameId++;
    frames.set(id, fn);
    return id;
  };
  globalThis.cancelAnimationFrame = (id) => {
    frames.delete(id);
  };
});
afterEach(() => {
  delete globalThis.requestAnimationFrame;
  delete globalThis.cancelAnimationFrame;
  mock.timers.reset();
});
function flushFrame() {
  const pending = [...frames.values()];
  frames.clear();
  for (const fn of pending) fn();
}

describe('racer bootstrap from the initial state', () => {
  test('the local player is aliased to "player" and guests get the badge', () => {
    const client = fakeRoomClient();
    const runner = createRemoteRunner({ roomClient: client, initialState: lobbyState(), youAre: ME });
    assert.deepEqual(
      runner.racers.map((r) => [r.id, r.handle]),
      [['p-1', 'Hp-1'], ['player', `H${ME} (Guest)`]],
    );
    assert.equal(runner.raceLength, SEQ.length);
    assert.equal(runner.getState(), 'idle');
  });

  test('the racers array is the live one ui.js keys its lanes off — late joiners are pushed into it', () => {
    const client = fakeRoomClient();
    const runner = createRemoteRunner({ roomClient: client, initialState: lobbyState(), youAre: ME });
    const ref = runner.racers;
    client.receive({ type: 'state', state: lobbyState({ players: [player('p-1'), player(ME), player('p-3', { isBot: true, tier: 'fast' })] }) });
    assert.equal(runner.racers, ref);
    const bot = ref.find((r) => r.id === 'p-3');
    assert.equal(bot.isBot, true);
    assert.equal(bot.tier, 'fast');
    assert.equal(bot.handle, 'Hp-3');
  });
});

describe('race-start and countdown', () => {
  test('race-start adopts the sequence, emits start with the first problem, and flips getState to racing', () => {
    const client = fakeRoomClient();
    const runner = createRemoteRunner({ roomClient: client, initialState: lobbyState(), youAre: ME });
    const events = record(runner);
    startRace(client);
    assert.deepEqual(events, [{ event: 'start', data: { problem: SEQ[0] } }]);
    assert.equal(runner.getState(), 'racing');
    assert.deepEqual(runner.currentProblemFor('player'), SEQ[0]);
  });

  test('countdown pushes are relayed as-is', () => {
    const client = fakeRoomClient();
    const runner = createRemoteRunner({ roomClient: client, initialState: lobbyState(), youAre: ME });
    const events = record(runner);
    client.receive({ type: 'countdown', n: 3 });
    client.receive({ type: 'countdown', n: 0 });
    assert.deepEqual(events.map((e) => e.data.n), [3, 0]);
  });

  test('joining mid-countdown replays the tick from the snapshot, once', () => {
    const client = fakeRoomClient();
    const runner = createRemoteRunner({ roomClient: client, initialState: lobbyState(), youAre: ME });
    const events = record(runner);
    const snap = lobbyState({ state: 'countdown', countdownN: 2 });
    client.receive({ type: 'state', state: snap });
    client.receive({ type: 'state', state: { ...snap, countdownN: 1 } });
    assert.deepEqual(events, [{ event: 'countdown', data: { n: 2 } }]);
  });

  test('a snapshot never replays a countdown the live push already delivered', () => {
    const client = fakeRoomClient();
    const runner = createRemoteRunner({ roomClient: client, initialState: lobbyState(), youAre: ME });
    const events = record(runner);
    client.receive({ type: 'countdown', n: 3 });
    client.receive({ type: 'state', state: lobbyState({ state: 'countdown', countdownN: 3 }) });
    assert.equal(events.length, 1);
  });
});

// A reload or a dropped socket mid-race rebuilds the runner from a `state`
// snapshot. `race-start` is sent once, at the countdown→racing transition, so
// there is nothing left to wait for — and until the snapshot itself starts the
// race, ui.js leaves the answer input disabled and every car at the line.
describe('reconnecting into a race already in progress', () => {
  const racingState = (extra = {}) =>
    lobbyState({
      state: 'racing',
      problemSequence: SEQ,
      raceStartedAt: 10_000,
      ...extra,
    });

  test('a runner built from an already-racing snapshot is racing, and starts as soon as the UI subscribes', () => {
    const client = fakeRoomClient();
    const runner = createRemoteRunner({
      roomClient: client,
      initialState: racingState({ players: [player('p-1', { score: 2 }), player(ME, { score: 1 })] }),
      youAre: ME,
    });
    // Racing before anybody is listening: the handoff in lobby.js constructs the
    // runner first and only then hands it to attachRaceUI.
    assert.equal(runner.getState(), 'racing');

    const events = record(runner);
    assert.deepEqual(events, [
      // 'start' is what ui.js enables the answer input on, and it carries the
      // problem to answer now — which mid-race is not the first one.
      { event: 'start', data: { problem: SEQ[1] } },
      // …and 'advance' is what moves the cars and the score readout off zero.
      { event: 'advance', data: { laneId: 'p-1', score: 2, finishMs: null } },
      { event: 'advance', data: { laneId: 'player', score: 1, finishMs: null } },
    ]);
    assert.deepEqual(runner.currentProblemFor('player'), SEQ[1]);
  });

  test('the reconnect snapshot that follows does not start the race a second time', () => {
    const client = fakeRoomClient();
    const runner = createRemoteRunner({
      roomClient: client,
      initialState: racingState({ players: [player('p-1', { score: 2 }), player(ME, { score: 1 })] }),
      youAre: ME,
    });
    const events = record(runner);
    client.receive({
      type: 'state',
      state: racingState({ players: [player('p-1', { score: 3 }), player(ME, { score: 1 })] }),
    });
    assert.equal(events.filter((e) => e.event === 'start').length, 1);
    assert.equal(runner.getState(), 'racing');
  });

  test('a seat the room dropped is replayed as dropped, and is not handed a start', () => {
    const client = fakeRoomClient();
    const runner = createRemoteRunner({
      roomClient: client,
      initialState: racingState({ players: [player('p-1', { score: 2 }), player(ME, { score: 1, dropped: true })] }),
      youAre: ME,
    });
    const events = record(runner);
    // No 'start': ui.js enables the answer input on it, and both submitAnswer
    // and the server ignore a dropped seat's answers.
    assert.deepEqual(events, [
      { event: 'advance', data: { laneId: 'p-1', score: 2, finishMs: null } },
      { event: 'advance', data: { laneId: 'player', score: 1, finishMs: null } },
      { event: 'drop', data: { laneId: 'player' } },
    ]);
    assert.deepEqual(runner.getRankings().find((r) => r.id === 'player').dropped, true);
  });

  test('a dropped opponent is replayed so their lane greys, without ending your race', () => {
    const client = fakeRoomClient();
    const runner = createRemoteRunner({
      roomClient: client,
      initialState: racingState({ players: [player('p-1', { score: 2, dropped: true }), player(ME, { score: 1 })] }),
      youAre: ME,
    });
    assert.deepEqual(record(runner), [
      { event: 'start', data: { problem: SEQ[1] } },
      { event: 'advance', data: { laneId: 'p-1', score: 2, finishMs: null } },
      { event: 'drop', data: { laneId: 'p-1' } },
      { event: 'advance', data: { laneId: 'player', score: 1, finishMs: null } },
    ]);
  });

  test('racers who already finished are replayed with their finish time', () => {
    const client = fakeRoomClient();
    const runner = createRemoteRunner({
      roomClient: client,
      initialState: racingState({
        players: [player('p-1', { score: SEQ.length, finishMs: 4200 }), player(ME)],
      }),
      youAre: ME,
    });
    const events = record(runner);
    assert.deepEqual(events, [
      { event: 'start', data: { problem: SEQ[0] } },
      { event: 'advance', data: { laneId: 'p-1', score: SEQ.length, finishMs: 4200 } },
    ]);
  });

  test('a snapshot promotes a runner that was built mid-countdown into a live race', () => {
    const client = fakeRoomClient();
    const runner = createRemoteRunner({
      roomClient: client,
      initialState: lobbyState({ state: 'countdown', countdownN: 1, problemSequence: SEQ }),
      youAre: ME,
    });
    const events = record(runner);
    assert.equal(runner.getState(), 'idle');
    // The socket dropped over the GO frame, so `race-start` never arrived.
    client.receive({
      type: 'state',
      state: racingState({ players: [player('p-1'), player(ME, { score: 2 })] }),
    });
    assert.equal(runner.getState(), 'racing');
    assert.deepEqual(events, [
      { event: 'start', data: { problem: SEQ[2] } },
      { event: 'advance', data: { laneId: 'player', score: 2, finishMs: null } },
    ]);
  });

  test('the snapshot adopts the shared race clock, so a reconnected finish is timed from it', () => {
    mock.timers.enable({ apis: ['Date'], now: 10_000 });
    const client = fakeRoomClient();
    const runner = createRemoteRunner({
      roomClient: client,
      initialState: lobbyState({ state: 'countdown', countdownN: 1, problemSequence: SEQ }),
      youAre: ME,
    });
    record(runner);
    client.receive({
      type: 'state',
      state: racingState({ players: [player('p-1'), player(ME, { score: SEQ.length - 1 })] }),
    });
    mock.timers.tick(3_000);
    runner.submitAnswer(String(SEQ[SEQ.length - 1].answer));
    assert.equal(runner.racers.find((r) => r.id === 'player').finishMs, 3_000);
  });

  test('the ordinary countdown → race-start path still starts the race exactly once', () => {
    const client = fakeRoomClient();
    const runner = createRemoteRunner({ roomClient: client, initialState: lobbyState(), youAre: ME });
    const events = record(runner);
    client.receive({ type: 'countdown', n: 1 });
    client.receive({ type: 'countdown', n: 0 });
    startRace(client);
    // A state broadcast follows the transition on the server.
    client.receive({ type: 'state', state: racingState() });
    startRace(client);
    assert.deepEqual(events.filter((e) => e.event === 'start'), [{ event: 'start', data: { problem: SEQ[0] } }]);
    assert.equal(runner.getState(), 'racing');
  });

  test('a listener that subscribes after a message-driven start is not handed a second one', () => {
    const client = fakeRoomClient();
    const runner = createRemoteRunner({ roomClient: client, initialState: lobbyState(), youAre: ME });
    const attached = record(runner);
    startRace(client);
    assert.deepEqual(attached, [{ event: 'start', data: { problem: SEQ[0] } }]);
    // The start was paid out to whoever was listening when it happened; it is
    // owed only when the race began before anybody had subscribed.
    assert.deepEqual(record(runner), []);
  });
});

describe('submitAnswer — optimistic local scoring', () => {
  test('a correct answer moves the car before the server replies, and is relayed', () => {
    const client = fakeRoomClient();
    const runner = createRemoteRunner({ roomClient: client, initialState: lobbyState(), youAre: ME });
    startRace(client);
    const events = record(runner);
    const result = runner.submitAnswer(' 2 ');
    assert.deepEqual(result, { correct: true });
    assert.deepEqual(client.sent, [{ type: 'answer', value: ' 2 ' }]);
    assert.deepEqual(events, [
      { event: 'advance', data: { laneId: 'player', score: 1, finishMs: null } },
      { event: 'problem', data: { problem: SEQ[1] } },
    ]);
  });

  test('a wrong answer shakes locally and is still relayed, so the server keeps the attempt count', () => {
    const client = fakeRoomClient();
    const runner = createRemoteRunner({ roomClient: client, initialState: lobbyState(), youAre: ME });
    startRace(client);
    const events = record(runner);
    assert.deepEqual(runner.submitAnswer('99'), { correct: false });
    assert.deepEqual(client.sent, [{ type: 'answer', value: '99' }]);
    assert.deepEqual(events, [{ event: 'wrong', data: { laneId: 'player' } }]);
  });

  test('the last correct answer stamps finishMs from the shared race clock', () => {
    mock.timers.enable({ apis: ['Date'], now: 10_000 });
    const client = fakeRoomClient();
    const runner = createRemoteRunner({ roomClient: client, initialState: lobbyState(), youAre: ME });
    startRace(client, 10_000);
    const events = record(runner);
    runner.submitAnswer('2');
    runner.submitAnswer('4');
    mock.timers.setTime(14_250);
    runner.submitAnswer('6');
    const last = events.filter((e) => e.event === 'advance').at(-1);
    assert.deepEqual(last.data, { laneId: 'player', score: 3, finishMs: 4250 });
    // No 'problem' after the finish line.
    assert.equal(events.filter((e) => e.event === 'problem').length, 2);
  });

  test('after finishing, further input is not scored locally', () => {
    const client = fakeRoomClient();
    const runner = createRemoteRunner({ roomClient: client, initialState: lobbyState(), youAre: ME });
    startRace(client);
    for (const p of SEQ) runner.submitAnswer(String(p.answer));
    const events = record(runner);
    assert.deepEqual(runner.submitAnswer('6'), { correct: true });
    assert.deepEqual(events, []);
    const me = runner.racers.find((r) => r.id === 'player');
    assert.equal(me.score, SEQ.length);
  });
});

describe('server advance reconciliation', () => {
  test("the server's echo of an answer already applied locally is suppressed", () => {
    const client = fakeRoomClient();
    const runner = createRemoteRunner({ roomClient: client, initialState: lobbyState(), youAre: ME });
    startRace(client);
    runner.submitAnswer('2');
    const events = record(runner);
    client.receive({ type: 'advance', playerId: ME, score: 1, finishMs: null });
    assert.deepEqual(events, []);
  });

  test('when the server is ahead of the optimistic score, the server wins and the next problem is re-issued', () => {
    const client = fakeRoomClient();
    const runner = createRemoteRunner({ roomClient: client, initialState: lobbyState(), youAre: ME });
    startRace(client);
    const events = record(runner);
    client.receive({ type: 'advance', playerId: ME, score: 2, finishMs: null });
    assert.deepEqual(events, [
      { event: 'advance', data: { laneId: 'player', score: 2, finishMs: null } },
      { event: 'problem', data: { problem: SEQ[2] } },
    ]);
    assert.equal(runner.racers.find((r) => r.id === 'player').score, 2);
  });

  test("the room's finish time replaces the optimistic one, which carries this browser's clock skew", () => {
    // The room started the race at 10_000 on its own clock; this browser's is
    // 10s behind it, so the elapsed it computes for itself comes out negative
    // — and it gets ranked against times the room stamped.
    mock.timers.enable({ apis: ['Date'], now: 7_000 });
    const client = fakeRoomClient();
    const runner = createRemoteRunner({ roomClient: client, initialState: lobbyState(), youAre: ME });
    startRace(client, 10_000);
    for (const p of SEQ) runner.submitAnswer(String(p.answer));
    const me = runner.racers.find((r) => r.id === 'player');
    assert.equal(me.finishMs, -3_000, 'the optimistic stamp mixes the two clocks');

    const events = record(runner);
    client.receive({ type: 'advance', playerId: ME, score: SEQ.length, finishMs: 7_000 });

    assert.equal(me.finishMs, 7_000);
    assert.deepEqual(events, [
      { event: 'advance', data: { laneId: 'player', score: SEQ.length, finishMs: 7_000 } },
    ]);
  });

  test("an opponent's advance is applied from the server and carries their finishMs", () => {
    const client = fakeRoomClient();
    const runner = createRemoteRunner({ roomClient: client, initialState: lobbyState(), youAre: ME });
    startRace(client);
    const events = record(runner);
    client.receive({ type: 'advance', playerId: 'p-1', score: 3, finishMs: 3100 });
    assert.deepEqual(events, [{ event: 'advance', data: { laneId: 'p-1', score: 3, finishMs: 3100 } }]);
    const opp = runner.racers.find((r) => r.id === 'p-1');
    assert.equal(opp.score, 3);
    assert.equal(opp.finishMs, 3100);
  });

  test('an advance for an unknown player is ignored rather than throwing', () => {
    const client = fakeRoomClient();
    const runner = createRemoteRunner({ roomClient: client, initialState: lobbyState(), youAre: ME });
    startRace(client);
    const events = record(runner);
    client.receive({ type: 'advance', playerId: 'p-99', score: 1, finishMs: null });
    client.receive({ type: 'drop', playerId: 'p-99' });
    assert.deepEqual(events, []);
  });

  test("opponents' wrong answers do not shake this player's input", () => {
    const client = fakeRoomClient();
    const runner = createRemoteRunner({ roomClient: client, initialState: lobbyState(), youAre: ME });
    startRace(client);
    const events = record(runner);
    client.receive({ type: 'wrong', playerId: 'p-1' });
    client.receive({ type: 'wrong', playerId: ME });
    assert.deepEqual(events, []);
  });
});

describe('state snapshots mid-race', () => {
  test('a snapshot updates human scores, finish and drop flags in place', () => {
    const client = fakeRoomClient();
    const runner = createRemoteRunner({ roomClient: client, initialState: lobbyState(), youAre: ME });
    startRace(client);
    const opp = runner.racers.find((r) => r.id === 'p-1');
    client.receive({
      type: 'state',
      state: lobbyState({
        state: 'racing',
        players: [player('p-1', { score: 2, finishMs: 2500, dnf: true }), player(ME, { dropped: true, handle: 'Renamed' })],
      }),
    });
    assert.equal(opp.score, 2);
    assert.equal(opp.finishMs, 2500);
    assert.equal(opp.dnf, true);
    const me = runner.racers.find((r) => r.id === 'player');
    assert.equal(me.dropped, true);
    assert.equal(me.handle, 'Renamed');
  });

  test('a snapshot with a sequence replaces the local one; an empty one does not', () => {
    const client = fakeRoomClient();
    const runner = createRemoteRunner({ roomClient: client, initialState: lobbyState(), youAre: ME });
    const other = [{ problem: '5 + 5', answer: 10 }, { problem: '6 + 6', answer: 12 }, { problem: '7 + 7', answer: 14 }];
    client.receive({ type: 'state', state: lobbyState({ problemSequence: other }) });
    assert.deepEqual(runner.currentProblemFor('player'), other[0]);
    client.receive({ type: 'state', state: lobbyState({ problemSequence: [] }) });
    assert.deepEqual(runner.currentProblemFor('player'), other[0]);
  });
});

describe('the exposed sequence', () => {
  test('runner.sequence is the one the room last sent, not the one the runner was built with', () => {
    const client = fakeRoomClient();
    const runner = createRemoteRunner({ roomClient: client, initialState: lobbyState(), youAre: ME });
    assert.deepEqual(runner.sequence, []);
    startRace(client);
    assert.equal(runner.sequence, SEQ);
    const other = [{ problem: '5 + 5', answer: 10 }, { problem: '6 + 6', answer: 12 }, { problem: '7 + 7', answer: 14 }];
    client.receive({ type: 'state', state: lobbyState({ state: 'racing', problemSequence: other }) });
    assert.equal(runner.sequence, other);
    assert.deepEqual(runner.currentProblemFor('player'), runner.sequence[0]);
  });
});

describe("race time is read on the room's clock", () => {
  // Every race time on the wire is the room's. These devices' clocks are a
  // minute off from it, which read naively made every bot finish at once (or
  // sit at the line for a minute) and put the provisional finish a minute out.
  const botState = (extra = {}) =>
    lobbyState({
      players: [player('p-1'), player(ME), player('bot-1', { isBot: true, tier: 'fast' })],
      ...extra,
    });
  const TIMELINE = [[1000, 2000, 3000]];

  test('a device clock a minute fast still moves the bots on the timeline, not all at once', () => {
    mock.timers.enable({ apis: ['Date'], now: 70_000 });
    const client = fakeRoomClient();
    const runner = createRemoteRunner({ roomClient: client, initialState: botState(), youAre: ME });
    client.receive({ type: 'race-start', sequence: SEQ, raceStartedAt: 10_000, serverNow: 10_000 });
    const events = record(runner);
    client.receive({ type: 'bot-timelines', botTimelines: TIMELINE, raceStartedAt: 10_000, serverNow: 10_000 });

    flushFrame();
    assert.deepEqual(events, [], 'nothing has happened a moment into the race');

    mock.timers.setTime(72_100);
    flushFrame();
    assert.deepEqual(events, [{ event: 'advance', data: { laneId: 'bot-1', score: 2, finishMs: null } }]);
    runner.stop();
  });

  test('a device clock a minute slow catches a reconnecting client up from the snapshot it was built from', () => {
    mock.timers.enable({ apis: ['Date'], now: 1_000 });
    const client = fakeRoomClient();
    const runner = createRemoteRunner({
      roomClient: client,
      initialState: botState({
        state: 'racing', problemSequence: SEQ, raceStartedAt: 60_000, serverNow: 62_100, botTimelines: TIMELINE,
      }),
      youAre: ME,
    });
    const events = record(runner);
    assert.deepEqual(events, [
      { event: 'start', data: { problem: SEQ[0] } },
      { event: 'advance', data: { laneId: 'bot-1', score: 2, finishMs: null } },
    ]);
    runner.stop();
  });

  test('a stamp that arrives late does not drag the estimate, or the bots, backwards', () => {
    mock.timers.enable({ apis: ['Date'], now: 70_000 });
    const client = fakeRoomClient();
    const runner = createRemoteRunner({ roomClient: client, initialState: botState(), youAre: ME });
    client.receive({ type: 'race-start', sequence: SEQ, raceStartedAt: 10_000, serverNow: 10_000 });
    client.receive({ type: 'bot-timelines', botTimelines: TIMELINE, raceStartedAt: 10_000, serverNow: 10_000 });
    // Stamped at room time 11_000 but delivered 500ms late.
    mock.timers.setTime(71_500);
    client.receive({ type: 'state', state: botState({ state: 'racing', problemSequence: SEQ, raceStartedAt: 10_000, serverNow: 11_000 }) });

    mock.timers.setTime(72_100);
    flushFrame();
    assert.equal(runner.racers.find((r) => r.id === 'bot-1').score, 2);
    runner.stop();
  });

  test("the provisional finish is timed on the room's clock", () => {
    mock.timers.enable({ apis: ['Date'], now: 70_000 });
    const client = fakeRoomClient();
    const runner = createRemoteRunner({ roomClient: client, initialState: lobbyState(), youAre: ME });
    client.receive({ type: 'race-start', sequence: SEQ, raceStartedAt: 10_000, serverNow: 10_000 });
    mock.timers.setTime(74_250);
    for (const p of SEQ) runner.submitAnswer(String(p.answer));
    assert.equal(runner.racers.find((r) => r.id === 'player').finishMs, 4_250);
  });
});

describe('bot timelines (Quick Match)', () => {
  const botState = (extra = {}) =>
    lobbyState({
      players: [player('p-1'), player(ME), player('bot-1', { isBot: true, tier: 'fast' })],
      ...extra,
    });
  const TIMELINE = [[1000, 2000, 3000]];

  test('bot-timelines starts a frame loop that advances the bot on the shared clock', () => {
    mock.timers.enable({ apis: ['Date'], now: 10_000 });
    const client = fakeRoomClient();
    const runner = createRemoteRunner({ roomClient: client, initialState: botState(), youAre: ME });
    startRace(client, 10_000);
    const events = record(runner);
    client.receive({ type: 'bot-timelines', botTimelines: TIMELINE, raceStartedAt: 10_000 });
    assert.equal(frames.size, 1);

    mock.timers.setTime(10_500);
    flushFrame();
    assert.deepEqual(events, []);

    mock.timers.setTime(12_100);
    flushFrame();
    assert.deepEqual(events, [{ event: 'advance', data: { laneId: 'bot-1', score: 2, finishMs: null } }]);

    mock.timers.setTime(13_000);
    flushFrame();
    assert.deepEqual(events.at(-1), { event: 'advance', data: { laneId: 'bot-1', score: 3, finishMs: 3000 } });
    // Every bot finished: no further frame is requested.
    assert.equal(frames.size, 0);
  });

  test('a mid-race snapshot bootstraps the timelines a reconnecting client missed', () => {
    mock.timers.enable({ apis: ['Date'], now: 12_100 });
    const client = fakeRoomClient();
    // Reconnect: the race is already running and 'bot-timelines' was sent long ago.
    const runner = createRemoteRunner({
      roomClient: client,
      initialState: botState({ state: 'racing', problemSequence: SEQ, raceStartedAt: 10_000 }),
      youAre: ME,
    });
    const events = record(runner);
    client.receive({
      type: 'state',
      state: botState({ state: 'racing', problemSequence: SEQ, raceStartedAt: 10_000, botTimelines: TIMELINE }),
    });
    assert.equal(frames.size, 1);
    flushFrame();
    assert.deepEqual(events, [
      // Reconnecting into a racing snapshot starts the race for this client too.
      { event: 'start', data: { problem: SEQ[0] } },
      { event: 'advance', data: { laneId: 'bot-1', score: 2, finishMs: null } },
    ]);
  });

  test('the snapshot the runner is built from carries the timelines too — bots are not frozen until the next broadcast', () => {
    mock.timers.enable({ apis: ['Date'], now: 12_100 });
    const client = fakeRoomClient();
    // The handoff in lobby.js constructs the runner from this snapshot; no
    // further `state` message is owed, so the timelines have to be taken here.
    const runner = createRemoteRunner({
      roomClient: client,
      initialState: botState({ state: 'racing', problemSequence: SEQ, raceStartedAt: 10_000, botTimelines: TIMELINE }),
      youAre: ME,
    });
    const events = record(runner);
    assert.equal(frames.size, 1, 'the bot ticker is already scheduled');
    flushFrame();
    assert.deepEqual(events, [
      { event: 'start', data: { problem: SEQ[0] } },
      { event: 'advance', data: { laneId: 'bot-1', score: 2, finishMs: null } },
    ]);
    runner.stop();
  });

  test('a reload replays the bots where their timelines already put them, not at the line', () => {
    // The room keeps every bot row at score 0 / finishMs null until it
    // finalizes them at race end, so a mid-race snapshot says nothing about a
    // bot that is already home. The timelines it carries do, and the replay has
    // to read them before it announces anything: the race screen ranks the
    // local player against whatever it can see at that moment.
    mock.timers.enable({ apis: ['Date'], now: 17_000 });
    const client = fakeRoomClient();
    const runner = createRemoteRunner({
      roomClient: client,
      initialState: botState({
        state: 'racing',
        problemSequence: SEQ,
        raceStartedAt: 10_000,
        botTimelines: TIMELINE,
        players: [
          player('p-1', { score: 1 }),
          player(ME, { score: SEQ.length, finishMs: 5_000 }),
          player('bot-1', { isBot: true, tier: 'fast' }),
        ],
      }),
      youAre: ME,
    });

    // Everything below is the replay, before a single animation frame has run.
    const events = record(runner);
    assert.deepEqual(events, [
      { event: 'start', data: { problem: null } },
      { event: 'advance', data: { laneId: 'p-1', score: 1, finishMs: null } },
      { event: 'advance', data: { laneId: 'player', score: SEQ.length, finishMs: 5_000 } },
      { event: 'advance', data: { laneId: 'bot-1', score: SEQ.length, finishMs: 3_000 } },
    ]);

    flushFrame();
    assert.equal(events.length, 4, 'the frame that follows has nothing left to announce');
    runner.stop();
  });

  test('snapshots do not overwrite a bot score the client is driving', () => {
    mock.timers.enable({ apis: ['Date'], now: 10_000 });
    const client = fakeRoomClient();
    const runner = createRemoteRunner({ roomClient: client, initialState: botState(), youAre: ME });
    startRace(client, 10_000);
    client.receive({ type: 'bot-timelines', botTimelines: TIMELINE, raceStartedAt: 10_000 });
    mock.timers.setTime(12_100);
    flushFrame();
    const bot = runner.racers.find((r) => r.id === 'bot-1');
    assert.equal(bot.score, 2);
    client.receive({
      type: 'state',
      state: botState({ state: 'racing', players: [player('p-1'), player(ME), player('bot-1', { isBot: true, score: 0 })] }),
    });
    assert.equal(bot.score, 2);
  });

  test('a finished snapshot ends the bots the client is driving', () => {
    // Quick Match: the room ended the race on its human-only completeness check
    // and recorded the bot short of the line as a dnf, but the socket dropped
    // before `finish`. The reconnect lands on a `finished` snapshot, which
    // carries no bot rows at all, so the terminal transition is the only thing
    // that can stop them crossing the line over the results screen.
    mock.timers.enable({ apis: ['Date'], now: 10_000 });
    const client = fakeRoomClient();
    const runner = createRemoteRunner({
      roomClient: client,
      initialState: botState({ state: 'racing', problemSequence: SEQ, raceStartedAt: 10_000, botTimelines: TIMELINE }),
      youAre: ME,
    });
    const events = record(runner);
    mock.timers.setTime(12_100);
    flushFrame();
    const bot = runner.racers.find((r) => r.id === 'bot-1');
    assert.equal(bot.score, 2, 'the bot is still short of the line when the race ends');
    assert.equal(frames.size, 1, 'and its ticker is still running');

    client.receive({
      type: 'state',
      state: botState({
        state: 'finished',
        players: [player('p-1'), player(ME, { score: SEQ.length, finishMs: 2_100 })],
      }),
    });

    assert.equal(frames.size, 0, 'the bot ticker is cancelled at the race end');
    assert.equal(bot.dnf, true);
    assert.equal(bot.finishMs, null);
    const settled = events.at(-1);
    assert.equal(settled.event, 'finish');
    assert.deepEqual(settled.data.rankings.map((r) => r.id), ['player', 'p-1', 'bot-1']);

    // Past its own timeline's finish, and still a dnf on a podium nobody redraws.
    mock.timers.setTime(14_000);
    flushFrame();
    assert.equal(bot.score, 2);
    assert.equal(bot.finishMs, null);
    assert.equal(events.at(-1), settled, 'nothing moves once the results are up');
    runner.stop();
  });

  test("a finished snapshot takes the bots' final rows from the room over the local replay", () => {
    // The room ended the race at 2.1s with the bot two problems in and a dnf,
    // but this socket was away for `finish`, and meanwhile the local ticker
    // carried the bot over the line at 3s. The room's rows ride on `lastRace`
    // because the bots have left `state.players`, and they are the podium.
    mock.timers.enable({ apis: ['Date'], now: 10_000 });
    const client = fakeRoomClient();
    const runner = createRemoteRunner({
      roomClient: client,
      initialState: botState({ state: 'racing', problemSequence: SEQ, raceStartedAt: 10_000, botTimelines: TIMELINE }),
      youAre: ME,
    });
    const events = record(runner);
    mock.timers.setTime(13_500);
    flushFrame();
    const bot = runner.racers.find((r) => r.id === 'bot-1');
    assert.equal(bot.finishMs, 3_000, 'the local replay has the bot home');

    client.receive({
      type: 'state',
      state: botState({
        state: 'finished',
        players: [player('p-1'), player(ME, { score: SEQ.length, finishMs: 2_100 })],
        lastRace: {
          raceLength: SEQ.length,
          botRows: [player('bot-1', { isBot: true, tier: 'fast', score: 2, finishMs: null, dnf: true })],
        },
      }),
    });

    assert.deepEqual(
      { score: bot.score, finishMs: bot.finishMs, dnf: bot.dnf },
      { score: 2, finishMs: null, dnf: true },
    );
    assert.deepEqual(events.at(-2), { event: 'advance', data: { laneId: 'bot-1', score: 2, finishMs: null } });
    const settled = events.at(-1);
    assert.equal(settled.event, 'finish');
    assert.deepEqual(settled.data.rankings.map((r) => r.id), ['player', 'p-1', 'bot-1']);
    runner.stop();
  });

  test('a second snapshot does not restart a loop that is already running', () => {
    mock.timers.enable({ apis: ['Date'], now: 10_000 });
    const client = fakeRoomClient();
    const runner = createRemoteRunner({ roomClient: client, initialState: botState(), youAre: ME });
    startRace(client, 10_000);
    const snap = botState({ state: 'racing', problemSequence: SEQ, raceStartedAt: 10_000, botTimelines: TIMELINE });
    client.receive({ type: 'state', state: snap });
    client.receive({ type: 'state', state: snap });
    assert.equal(frames.size, 1);
    runner.stop();
  });
});

describe('drop, finish and rankings', () => {
  test('a drop marks the racer and is relayed', () => {
    const client = fakeRoomClient();
    const runner = createRemoteRunner({ roomClient: client, initialState: lobbyState(), youAre: ME });
    startRace(client);
    const events = record(runner);
    client.receive({ type: 'drop', playerId: 'p-1' });
    assert.deepEqual(events, [{ event: 'drop', data: { laneId: 'p-1' } }]);
    assert.equal(runner.racers.find((r) => r.id === 'p-1').dropped, true);
  });

  test('finish syncs every racer from the server payload and ranks: finished by time, then racing by score, then out', () => {
    const client = fakeRoomClient();
    const runner = createRemoteRunner({
      roomClient: client,
      initialState: lobbyState({ players: [player('p-1'), player(ME), player('p-3'), player('p-4')] }),
      youAre: ME,
    });
    startRace(client);
    const events = record(runner);
    client.receive({
      type: 'finish',
      rankings: [
        { id: 'p-4', score: 3, finishMs: 4000, dropped: false, dnf: false },
        { id: ME, score: 3, finishMs: 3000, dropped: false, dnf: false },
        { id: 'p-1', score: 1, finishMs: null, dropped: true, dnf: false },
        { id: 'p-3', score: 2, finishMs: null, dropped: false, dnf: true },
      ],
    });
    assert.equal(events.length, 1);
    assert.equal(events[0].event, 'finish');
    assert.deepEqual(events[0].data.rankings.map((r) => r.id), ['player', 'p-4', 'p-1', 'p-3']);
    assert.deepEqual(runner.getRankings().map((r) => r.id), ['player', 'p-4', 'p-1', 'p-3']);
    const me = runner.racers.find((r) => r.id === 'player');
    assert.equal(me.finishMs, 3000);
    assert.equal(runner.racers.find((r) => r.id === 'p-3').dnf, true);
  });

  test('a newcomer who joined after the race ended stays out of the final standings', () => {
    // This player's socket died mid-race; the room ended the race on the
    // deadline and recorded them a dnf, so the one-shot `finish` never arrived.
    // Meanwhile a third person opened the invite link — the room accepts new
    // players again once it is back in `finished` — and the reconnect is
    // answered with a snapshot listing all three. The terminal transition ranks
    // from the local racers, so a seat that never raced would be tiered as
    // still-racing and land above this player's own dnf row.
    const client = fakeRoomClient();
    const runner = createRemoteRunner({
      roomClient: client,
      initialState: lobbyState({ players: [player('p-1'), player(ME)] }),
      youAre: ME,
    });
    startRace(client);
    const events = record(runner);

    client.receive({
      type: 'state',
      state: lobbyState({
        state: 'finished',
        players: [
          player('p-1', { score: SEQ.length, finishMs: 5_000 }),
          player(ME, { score: 1, dnf: true }),
          player('p-3'),
        ],
      }),
    });

    const settled = events.at(-1);
    assert.equal(settled.event, 'finish');
    assert.deepEqual(settled.data.rankings.map((r) => r.id), ['p-1', 'player']);
    assert.deepEqual(runner.getRankings().map((r) => r.id), ['p-1', 'player'], 'and the podium draws the same list');
    assert.equal(runner.racers.some((r) => r.id === 'p-3'), false);
    assert.equal(events.some((e) => e.data.laneId === 'p-3'), false, 'no lane on the screen belongs to them either');
  });

  test('a countdown handoff that never saw race-start keeps a post-race joiner off the podium', () => {
    // The race screen mounts at countdown, then this socket dies over the GO
    // frame — `race-start` never lands, so nothing has told this runner the
    // race began. It ends on its deadline with this player a dnf, a third
    // person opens the invite link while the room sits in `finished`, and the
    // reconnect is answered with a snapshot listing all three.
    const client = fakeRoomClient();
    const runner = createRemoteRunner({
      roomClient: client,
      initialState: lobbyState({ state: 'countdown', countdownN: 1, problemSequence: SEQ }),
      youAre: ME,
    });
    const events = record(runner);

    client.receive({
      type: 'state',
      state: lobbyState({
        state: 'finished',
        players: [
          player('p-1', { score: SEQ.length, finishMs: 5_000 }),
          player(ME, { score: 1, dnf: true }),
          player('p-3'),
        ],
      }),
    });

    const settled = events.at(-1);
    assert.equal(settled.event, 'finish');
    assert.deepEqual(settled.data.rankings.map((r) => r.id), ['p-1', 'player']);
    assert.deepEqual(runner.getRankings().map((r) => r.id), ['p-1', 'player'], 'and the podium draws the same list');
    assert.equal(runner.racers.some((r) => r.id === 'p-3'), false);
  });

  test('a lobby snapshot after this runner has raced does not reopen its roster', () => {
    // Race Again puts the room back in `lobby`, where a newcomer can join. The
    // snapshot that carries them does reset this still-mounted runner — the
    // lobby rows are score 0 with no finish, so `reconcilePlayers` rolls the
    // finish it just settled back off this player. That reset is the room's to
    // make. Enlarging the roster of the race that ran is not, and is all this
    // asserts.
    const client = fakeRoomClient();
    const runner = createRemoteRunner({
      roomClient: client,
      initialState: lobbyState({ players: [player('p-1'), player(ME)] }),
      youAre: ME,
    });
    startRace(client);
    client.receive({
      type: 'finish',
      rankings: [
        { id: ME, score: SEQ.length, finishMs: 3000, dropped: false, dnf: false },
        { id: 'p-1', score: 1, finishMs: null, dropped: false, dnf: true },
      ],
    });

    client.receive({
      type: 'state',
      state: lobbyState({ players: [player('p-1'), player(ME), player('p-3')] }),
    });

    assert.deepEqual(runner.racers.map((r) => r.id), ['p-1', 'player'], 'p-3 never joins this race');
  });

  test('a player who joins before the race starts is still picked up from the snapshot', () => {
    const client = fakeRoomClient();
    const runner = createRemoteRunner({ roomClient: client, initialState: lobbyState(), youAre: ME });
    client.receive({ type: 'state', state: lobbyState({ players: [player('p-1'), player(ME), player('p-3')] }) });
    startRace(client);
    assert.deepEqual(runner.racers.map((r) => r.id), ['p-1', 'player', 'p-3']);
  });

  test('getRankings orders still-racing players by score, higher first', () => {
    const client = fakeRoomClient();
    const runner = createRemoteRunner({
      roomClient: client,
      initialState: lobbyState({ players: [player('p-1', { score: 1 }), player(ME, { score: 2 }), player('p-3', { score: 3 })] }),
      youAre: ME,
    });
    assert.deepEqual(runner.getRankings().map((r) => r.id), ['p-3', 'player', 'p-1']);
  });
});

describe('quit and stop', () => {
  test('quit tells the server and the local screen', () => {
    const client = fakeRoomClient();
    let quits = 0;
    const runner = createRemoteRunner({ roomClient: client, initialState: lobbyState(), youAre: ME, onLocalQuit: () => quits++ });
    runner.quit();
    assert.deepEqual(client.sent, [{ type: 'quit' }]);
    assert.equal(quits, 1);
  });

  test('quit tolerates no onLocalQuit', () => {
    const client = fakeRoomClient();
    const runner = createRemoteRunner({ roomClient: client, initialState: lobbyState(), youAre: ME });
    assert.doesNotThrow(() => runner.quit());
  });

  test('stop unsubscribes from the socket, cancels the bot loop, and silences every later event', () => {
    mock.timers.enable({ apis: ['Date'], now: 10_000 });
    const client = fakeRoomClient();
    const runner = createRemoteRunner({ roomClient: client, initialState: lobbyState(), youAre: ME });
    startRace(client, 10_000);
    client.receive({ type: 'bot-timelines', botTimelines: [[1000]], raceStartedAt: 10_000 });
    assert.equal(client.listenerCount, 1);
    assert.equal(frames.size, 1);
    const events = record(runner);
    runner.stop();
    assert.equal(client.listenerCount, 0);
    assert.equal(frames.size, 0);
    client.receive({ type: 'advance', playerId: 'p-1', score: 1, finishMs: null });
    runner.submitAnswer('2');
    assert.deepEqual(events, []);
  });
});

