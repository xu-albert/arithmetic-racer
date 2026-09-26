// The client half of reconnect catch-up (Design C): the per-race outbox that
// holds answers typed while the socket is down, the single ordered `catch-up`
// batch sent after hello on reconnect, the drain-time input pause, and the
// batch id a second reconnect's replay carries so the room grades it once.
//
// The room side is covered in server/room-catchup.test.js; here the server is
// a fake roomClient with a switchable readyState, and the browser's open event
// is what room-client.js fires after it has sent hello.

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createRemoteRunner } from './remote-runner.js';
import { CATCHUP_MAX_ENTRIES_PER_PROBLEM } from './catch-up-rules.js';

const ME = 'p-2';
const SEQ = [
  { problem: '1 + 1', answer: 2 },
  { problem: '2 + 2', answer: 4 },
  { problem: '3 + 3', answer: 6 },
  { problem: '4 + 4', answer: 8 },
];

function fakeRoomClient() {
  const listeners = new Set();
  const openListeners = new Set();
  const sent = [];
  return {
    sent,
    readyState: 1,
    on(handler) { listeners.add(handler); return () => listeners.delete(handler); },
    onOpen(handler) { openListeners.add(handler); return () => openListeners.delete(handler); },
    send(msg) { sent.push(msg); },
    // Test-side: what the server would push.
    receive(msg) { for (const l of [...listeners]) l(msg); },
    // Test-side: the socket dropped, then came back (room-client sends hello
    // from its own open handler before these listeners fire).
    drop() { this.readyState = 3; },
    reopen() { this.readyState = 1; for (const l of [...openListeners]) l(); },
    catchUps() { return sent.filter((m) => m.type === 'catch-up'); },
    answers() { return sent.filter((m) => m.type === 'answer'); },
  };
}

function player(id, extra = {}) {
  return { id, handle: `H${id}`, isGuest: false, score: 0, finishMs: null, dropped: false, dnf: false, ...extra };
}

function lobbyState(extra = {}) {
  return {
    raceLength: SEQ.length,
    state: 'lobby',
    players: [player('p-1'), player(ME)],
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

function startRace(client, runner, at = 10_000) {
  runner.on(() => {}); // attach so 'start' is delivered
  client.receive({ type: 'race-start', sequence: SEQ, raceStartedAt: at, serverNow: at });
}

describe('the offline outbox', () => {
  test('answers typed while disconnected queue positionally and are not sent individually', () => {
    const client = fakeRoomClient();
    const runner = createRemoteRunner({ roomClient: client, initialState: lobbyState(), youAre: ME });
    startRace(client, runner);
    const events = record(runner);

    client.drop();
    runner.submitAnswer('2'); // correct at index 0
    runner.submitAnswer('9'); // wrong at index 1
    runner.submitAnswer('4'); // correct at index 1

    assert.equal(client.answers().length, 0, 'offline answers must not ride the socket queue');
    assert.equal(client.sent.length, 0);
    const me = runner.racers.find((r) => r.id === 'player');
    assert.equal(me.score, 2, 'the optimistic update still paints');
    assert.deepEqual(
      events.filter((e) => e.event === 'advance').map((e) => e.data.score),
      [1, 2],
    );
  });

  test('on reconnect, exactly one ordered catch-up batch goes out after open', () => {
    const client = fakeRoomClient();
    const runner = createRemoteRunner({ roomClient: client, initialState: lobbyState(), youAre: ME });
    startRace(client, runner);
    const events = record(runner);

    client.drop();
    runner.submitAnswer('2');
    runner.submitAnswer('9');
    runner.submitAnswer('4');
    client.reopen();

    assert.equal(client.answers().length, 0);
    assert.equal(client.catchUps().length, 1);
    const { batchId, ...batch } = client.catchUps()[0];
    assert.ok(Number.isSafeInteger(batchId));
    assert.deepEqual(batch, {
      type: 'catch-up',
      raceStartedAt: 10_000,
      entries: [
        { index: 0, value: '2' },
        { index: 1, value: '9' },
        { index: 1, value: '4' },
      ],
    });
    assert.deepEqual(events.filter((e) => e.event === 'catchup-start'), [
      { event: 'catchup-start', data: { pending: 3 } },
    ]);
  });

  test('a snapshot mid-drain does not roll back the self lane', () => {
    const client = fakeRoomClient();
    const runner = createRemoteRunner({ roomClient: client, initialState: lobbyState(), youAre: ME });
    startRace(client, runner);
    record(runner);

    client.drop();
    runner.submitAnswer('2');
    runner.submitAnswer('4');
    client.reopen();

    // The reconnect snapshot still carries the pre-outage scores.
    client.receive({
      type: 'state',
      state: {
        ...lobbyState(),
        state: 'racing',
        players: [player('p-1', { score: 1 }), player(ME, { score: 0 })],
        problemSequence: SEQ,
        raceStartedAt: 10_000,
        serverNow: 11_000,
      },
      youAre: ME,
    });

    const me = runner.racers.find((r) => r.id === 'player');
    assert.equal(me.score, 2, 'self keeps the optimistic position until the ack');
    assert.equal(runner.racers.find((r) => r.id === 'p-1').score, 1, 'opponents still reconcile');
  });

  test('the ack applies the server position, emits one advance, and normal play resumes', () => {
    const client = fakeRoomClient();
    const runner = createRemoteRunner({ roomClient: client, initialState: lobbyState(), youAre: ME });
    startRace(client, runner);
    const events = record(runner);

    client.drop();
    runner.submitAnswer('2');
    runner.submitAnswer('9'); // the room will grade this wrong
    runner.submitAnswer('4');
    client.reopen();
    events.length = 0;

    client.receive({
      type: 'catch-up-ack',
      applied: 3, skipped: 0, gaps: [], rejected: null,
      finalScore: 2, finishMs: null,
    });

    const me = runner.racers.find((r) => r.id === 'player');
    assert.equal(me.score, 2);
    assert.deepEqual(events.filter((e) => e.event === 'catchup-end'), [
      { event: 'catchup-end', data: { rejected: null, gaps: [] } },
    ]);
    assert.equal(events.filter((e) => e.event === 'advance').length, 0, 'position unchanged — nothing to repaint');

    // Outbox cleared: the next answer is an ordinary live answer.
    runner.submitAnswer('6');
    assert.deepEqual(client.answers(), [{ type: 'answer', value: '6' }]);
  });

  test('an ack with no seat behind it lifts the pause and leaves the lane alone', () => {
    const client = fakeRoomClient();
    const runner = createRemoteRunner({ roomClient: client, initialState: lobbyState(), youAre: ME });
    startRace(client, runner);
    const events = record(runner);

    client.drop();
    runner.submitAnswer('2');
    client.reopen();
    events.length = 0;

    client.receive({
      type: 'catch-up-ack',
      applied: 0, skipped: 0, gaps: [], rejected: 'no-seat',
      finalScore: null, finishMs: null,
    });

    assert.equal(runner.racers.find((r) => r.id === 'player').score, 1);
    assert.deepEqual(events, [{ event: 'catchup-end', data: { rejected: 'no-seat', gaps: [] } }]);
    runner.submitAnswer('4');
    assert.deepEqual(client.answers(), [{ type: 'answer', value: '4' }], 'the outbox is drained');
  });

  test('a revoked optimistic finish comes back as a null finishMs', () => {
    const client = fakeRoomClient();
    const runner = createRemoteRunner({ roomClient: client, initialState: lobbyState(), youAre: ME });
    startRace(client, runner);
    record(runner);

    client.drop();
    for (const value of ['2', '4', '6', '8']) runner.submitAnswer(value);
    const me = runner.racers.find((r) => r.id === 'player');
    assert.notEqual(me.finishMs, null, 'optimistic finish painted offline');

    client.reopen();
    // The room only ever received the first two (say the rest hit a gap).
    client.receive({
      type: 'catch-up-ack',
      applied: 2, skipped: 2, gaps: [], rejected: null,
      finalScore: 2, finishMs: null,
    });

    assert.equal(me.score, 2);
    assert.equal(me.finishMs, null, 'the finish the room never saw is revoked');
  });

  test('a second reconnect before the ack replays the batch verbatim', () => {
    const client = fakeRoomClient();
    const runner = createRemoteRunner({ roomClient: client, initialState: lobbyState(), youAre: ME });
    startRace(client, runner);
    record(runner);

    client.drop();
    runner.submitAnswer('2');
    runner.submitAnswer('4');
    client.reopen();
    assert.equal(client.catchUps().length, 1);

    // Down again before the ack arrived; the resend is the same entries under
    // the same id, which the room grades at most once.
    client.drop();
    client.reopen();

    assert.equal(client.catchUps().length, 2);
    const [first, resend] = client.catchUps();
    assert.equal(resend.batchId, first.batchId);
    assert.deepEqual(resend.entries, [
      { index: 0, value: '2' },
      { index: 1, value: '4' },
    ]);
  });

  test('the next outage after an ack is a new batch with a new id', () => {
    const client = fakeRoomClient();
    const runner = createRemoteRunner({ roomClient: client, initialState: lobbyState(), youAre: ME });
    startRace(client, runner);
    record(runner);

    client.drop();
    runner.submitAnswer('2');
    client.reopen();
    client.receive({
      type: 'catch-up-ack', applied: 1, skipped: 0, gaps: [], rejected: null, finalScore: 1, finishMs: null,
    });

    client.drop();
    runner.submitAnswer('9'); // wrong at index 1
    client.reopen();

    const [first, second] = client.catchUps();
    assert.ok(second.batchId > first.batchId);
    assert.deepEqual(second.entries, [{ index: 1, value: '9' }]);
  });

  test('a finished snapshot arriving mid-drain settles the race from the room\'s row', () => {
    const client = fakeRoomClient();
    const runner = createRemoteRunner({ roomClient: client, initialState: lobbyState(), youAre: ME });
    startRace(client, runner);
    const events = record(runner);

    runner.submitAnswer('2'); // live, graded by the room before the drop
    client.drop();
    for (const value of ['4', '6', '8']) runner.submitAnswer(value);
    const me = runner.racers.find((r) => r.id === 'player');
    assert.equal(me.score, SEQ.length);
    assert.notEqual(me.finishMs, null, 'optimistic finish painted offline');

    // The race hit its deadline during the outage. The batch goes out on
    // reopen, and the snapshot onConnect pushes is the first thing back.
    client.reopen();
    assert.equal(client.catchUps().length, 1);
    client.receive({
      type: 'state',
      state: {
        ...lobbyState(),
        state: 'finished',
        players: [
          player('p-1', { score: 4, finishMs: 9000 }),
          player(ME, { score: 1, dnf: true }),
        ],
        problemSequence: SEQ,
        raceStartedAt: 10_000,
        serverNow: 90_000,
      },
      youAre: ME,
    });

    assert.deepEqual(
      { score: me.score, finishMs: me.finishMs, dnf: me.dnf },
      { score: 1, finishMs: null, dnf: true },
      'the settled row is the room\'s, not the optimistic one',
    );
    const finish = events.filter((e) => e.event === 'finish');
    assert.equal(finish.length, 1);
    assert.deepEqual(finish[0].data.rankings.map((r) => r.id), ['p-1', 'player']);

    // The late ack speaks for a seat re-minted after the old one's grace ran
    // out in the finished room; it must not rewrite the settled row.
    events.length = 0;
    client.receive({
      type: 'catch-up-ack', applied: 0, skipped: 3, gaps: [], rejected: null, finalScore: 0, finishMs: null,
    });
    assert.equal(me.score, 1);
    assert.equal(events.filter((e) => e.event === 'advance').length, 0);
    assert.deepEqual(events.filter((e) => e.event === 'catchup-end'), [
      { event: 'catchup-end', data: { rejected: null, gaps: [] } },
    ]);
  });

  test('nothing is sent on reconnect when the race ended while offline', () => {
    const client = fakeRoomClient();
    const runner = createRemoteRunner({ roomClient: client, initialState: lobbyState(), youAre: ME });
    startRace(client, runner);
    record(runner);

    client.drop();
    runner.submitAnswer('2');
    // The room ended the race during the outage; the snapshot settles it.
    client.receive({
      type: 'state',
      state: {
        ...lobbyState(),
        state: 'finished',
        players: [player('p-1', { score: 4, finishMs: 9000 }), player(ME, { score: 1 })],
        problemSequence: SEQ,
        raceStartedAt: 10_000,
        serverNow: 20_000,
      },
      youAre: ME,
    });

    client.reopen();
    assert.equal(client.catchUps().length, 0, 'a settled race has nothing to catch up');
  });

  test('the outbox is capped at 4x raceLength', () => {
    const client = fakeRoomClient();
    const runner = createRemoteRunner({ roomClient: client, initialState: lobbyState(), youAre: ME });
    startRace(client, runner);
    record(runner);

    client.drop();
    for (let i = 0; i < 30; i++) runner.submitAnswer('9'); // wrong, stays at index 0

    client.reopen();
    const batch = client.catchUps()[0];
    assert.equal(batch.entries.length, CATCHUP_MAX_ENTRIES_PER_PROBLEM * SEQ.length);
  });
});
