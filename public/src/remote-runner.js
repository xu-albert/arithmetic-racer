// Mirrors public/src/runner.js so attachRaceUI works unchanged.
// The local player's id is aliased to 'player' so ui.js's `.id === 'player'` checks Just Work.
// The `laneId` carried by these events (and written to `lane.dataset.laneId` in ui.js) is
// that lane key — the server's ephemeral broadcast id, or the 'player' alias — never the
// localStorage racerId, which is the reconnect secret and leaves this browser only inside
// `hello` (see identity.js).

import { validateAnswer } from './game.js';
import { scoreBotAt } from './bot-timeline.js';
import { rankRacers } from './rankings.js';

const PLAYER_ALIAS = 'player';

function aliasId(id, youAre) {
  return id === youAre ? PLAYER_ALIAS : id;
}

// Append the guest marker inline so it shows up on race lanes + podium without
// modifying ui.js. The server broadcasts isGuest (no account); the badge only
// encodes account status, so bots carry it too — bot backfill is disclosed in
// the lobby copy, not hidden on the wire (isBot/tier stay in the payload).
function displayHandle(rawHandle, isGuest) {
  return isGuest ? `${rawHandle} (Guest)` : rawHandle;
}

// One wire player → one local racer, in the shape ui.js and rankings.js read.
function toRacer(p, youAre) {
  return {
    id: aliasId(p.id, youAre),
    handle: displayHandle(p.handle, !!p.isGuest),
    isBot: !!p.isBot,
    tier: p.tier ?? null,
    score: p.score ?? 0,
    finishMs: p.finishMs ?? null,
    dropped: !!p.dropped,
    dnf: !!p.dnf,
  };
}

function buildRacers(players, youAre) {
  return players.map((p) => toRacer(p, youAre));
}

export function createRemoteRunner({ roomClient, initialState, youAre, onLocalQuit }) {
  const raceLength = initialState.raceLength;
  // Mutated in place and never reassigned: ui.js keeps a reference to it.
  const racers = buildRacers(initialState.players, youAre);
  let sequence = initialState.problemSequence ?? [];
  const listeners = new Set();
  let stopped = false;
  // `raceStarted` is this runner's view of the race being live. It is normally
  // set by the `race-start` push, which listeners are always attached for. The
  // exception is a reconnect: the runner is constructed from an already-`racing`
  // snapshot, before attachRaceUI has subscribed, so the start is owed at that
  // point and paid out in `on()` — that is what `pendingStart` tracks.
  let raceStarted = false;
  let startDelivered = false;
  let pendingStart = false;
  let raceStartedAtMs = initialState.raceStartedAt ?? null;
  let lastCountdownN = null;

  // Bot timeline state (public mode only)
  let botTimelines = null;
  let botRafId = null;

  function tickBots() {
    if (!botTimelines || stopped) return;
    const elapsed = Date.now() - raceStartedAtMs;
    let anyRunning = false;
    for (let i = 0; i < botTimelines.length; i++) {
      const bot = racers.find((r) => r.id === `bot-${i + 1}`);
      if (!bot || bot.finishMs != null || bot.dropped || bot.dnf) continue;
      const newScore = scoreBotAt(botTimelines[i], elapsed);
      if (newScore !== bot.score) {
        bot.score = newScore;
        if (newScore >= raceLength && bot.finishMs == null) {
          bot.finishMs = botTimelines[i][raceLength - 1];
        }
        emit('advance', { laneId: bot.id, score: bot.score, finishMs: bot.finishMs });
      }
      if (bot.finishMs == null) anyRunning = true;
    }
    if (anyRunning && !stopped) {
      botRafId = requestAnimationFrame(tickBots);
    }
  }

  function emit(event, data) {
    if (stopped) return;
    for (const l of listeners) l(event, data);
  }

  // The race screen opens with input disabled, every car at 0 and the score at
  // 0/N; 'start' is what unlocks it and 'advance' is what moves a car. A racer
  // who reloads mid-race therefore needs both replayed from the snapshot, or
  // they land on a live race they cannot type into with everyone at the line.
  function deliverStart() {
    if (startDelivered) return;
    startDelivered = true;
    pendingStart = false;
    emit('start', { problem: sequence[0] ?? null });
    for (const r of racers) {
      if (r.score > 0 || r.finishMs != null) {
        emit('advance', { laneId: r.id, score: r.score, finishMs: r.finishMs });
      }
    }
  }

  // Idempotent: whichever arrives first — the one-shot `race-start` push or a
  // snapshot that already says `racing` — starts the race exactly once.
  function beginRace() {
    if (raceStarted) return;
    raceStarted = true;
    deliverStart();
  }

  function findRacer(serverPlayerId) {
    const aliased = aliasId(serverPlayerId, youAre);
    return racers.find((r) => r.id === aliased);
  }

  function getRankings() {
    return rankRacers(racers);
  }

  const unsubscribe = roomClient.on((msg) => {
    if (stopped) return;

    switch (msg.type) {
      case 'state': {
        // Mutate existing racer objects in-place; ui.js holds references via runner.racers.
        for (const p of msg.state.players) {
          const aliased = aliasId(p.id, youAre);
          const existing = racers.find((r) => r.id === aliased);
          if (existing) {
            existing.handle = displayHandle(p.handle, !!p.isGuest);
            // Don't overwrite bot scores mid-race — client drives them via tickBots.
            if (!existing.isBot) existing.score = p.score ?? existing.score;
            if (p.finishMs != null) existing.finishMs = p.finishMs;
            existing.dropped = !!p.dropped;
            existing.dnf = !!p.dnf;
          } else {
            racers.push(toRacer(p, youAre));
          }
        }
        if (msg.state.problemSequence?.length) sequence = msg.state.problemSequence;
        // Replay countdown if we joined mid-countdown and haven't seen a countdown event yet.
        if (msg.state.state === 'countdown' && msg.state.countdownN != null && lastCountdownN == null) {
          lastCountdownN = msg.state.countdownN;
          emit('countdown', { n: msg.state.countdownN });
        }
        // Reconnect bootstrap. Both `race-start` and `bot-timelines` are sent
        // once, at the countdown→racing transition; a client that joins or
        // reconnects after it gets a snapshot, never a replay. So the snapshot
        // has to do their job: adopt the shared race clock, pick up the bot
        // timelines (without this all bots stay frozen at 0), and start the
        // race — which is what enables the answer input.
        if (msg.state.state === 'racing') {
          if (msg.state.raceStartedAt) raceStartedAtMs = msg.state.raceStartedAt;
          if (msg.state.botTimelines?.length && !botTimelines) {
            botTimelines = msg.state.botTimelines;
            if (botRafId) cancelAnimationFrame(botRafId);
            botRafId = requestAnimationFrame(tickBots);
          }
          beginRace();
        }
        break;
      }
      case 'countdown': {
        lastCountdownN = msg.n;
        emit('countdown', { n: msg.n });
        break;
      }
      case 'race-start': {
        sequence = msg.sequence;
        raceStartedAtMs = msg.raceStartedAt;
        beginRace();
        break;
      }
      case 'bot-timelines': {
        // Public-mode only: server sends this right after race-start with precomputed timelines.
        botTimelines = msg.botTimelines;
        if (msg.raceStartedAt) raceStartedAtMs = msg.raceStartedAt;
        if (botRafId) cancelAnimationFrame(botRafId);
        botRafId = requestAnimationFrame(tickBots);
        break;
      }
      case 'advance': {
        const r = findRacer(msg.playerId);
        if (!r) break;
        // Suppress the local player's server-driven advance — we already
        // applied it optimistically in submitAnswer. Only reconcile if the
        // server is ahead of us (e.g. a dropped optimistic frame), in which
        // case server wins.
        if (r.id === PLAYER_ALIAS) {
          if (msg.score > r.score) {
            r.score = msg.score;
            if (msg.finishMs != null) r.finishMs = msg.finishMs;
            emit('advance', { laneId: r.id, score: r.score, finishMs: r.finishMs });
            const next = sequence[r.score] ?? null;
            if (next) emit('problem', { problem: next });
          }
          break;
        }
        // Opponents: update from server.
        r.score = msg.score;
        if (msg.finishMs != null) r.finishMs = msg.finishMs;
        emit('advance', { laneId: r.id, score: r.score, finishMs: r.finishMs });
        break;
      }
      case 'wrong': {
        // Local player's wrong was already shown optimistically; suppress.
        // Opponents' wrong answers don't shake anyone's input by design.
        break;
      }
      case 'drop': {
        const r = findRacer(msg.playerId);
        if (!r) break;
        r.dropped = true;
        emit('drop', { laneId: r.id });
        break;
      }
      case 'finish': {
        // Sync ranking-relevant fields from server payload.
        for (const sp of msg.rankings) {
          const r = findRacer(sp.id);
          if (!r) continue;
          r.score = sp.score;
          r.finishMs = sp.finishMs;
          r.dropped = !!sp.dropped;
          r.dnf = !!sp.dnf;
        }
        emit('finish', { rankings: getRankings() });
        break;
      }
    }
  });

  // Reconnect/mid-race join: the handoff in lobby.js builds this runner from an
  // already-`racing` snapshot, so there is no `race-start` left to wait for. The
  // race screen is attached to it a moment later, so the start waits for it.
  if (initialState.state === 'racing') {
    raceStarted = true;
    pendingStart = true;
  }

  return {
    racers,
    sequence,
    raceLength,
    getRankings,
    on(handler) {
      listeners.add(handler);
      // Pay a start owed from before anybody was listening (see deliverStart).
      if (pendingStart) deliverStart();
      return () => listeners.delete(handler);
    },
    start() { /* no-op; server drives countdown */ },
    submitAnswer(raw) {
      // Always relay to server; server is the source of truth.
      roomClient.send({ type: 'answer', value: raw });
      // Optimistic local update — your own car moves on press, no waiting on
      // the server round-trip. Server's later `advance`/`wrong` for self is
      // suppressed unless server's score gets ahead of ours (rare).
      const me = racers.find((r) => r.id === PLAYER_ALIAS);
      if (!me || me.dropped || me.score >= raceLength) return { correct: true };
      const problem = sequence[me.score];
      if (!problem) return { correct: true };
      if (validateAnswer(problem, raw)) {
        me.score += 1;
        if (me.score >= raceLength && me.finishMs == null && raceStartedAtMs != null) {
          me.finishMs = Date.now() - raceStartedAtMs;
        }
        emit('advance', { laneId: me.id, score: me.score, finishMs: me.finishMs });
        const next = sequence[me.score] ?? null;
        if (next) emit('problem', { problem: next });
        return { correct: true };
      }
      emit('wrong', { laneId: me.id });
      return { correct: false };
    },
    currentProblemFor(laneId) {
      const r = racers.find((x) => x.id === laneId);
      return r ? sequence[r.score] ?? null : null;
    },
    getState() {
      return raceStarted ? 'racing' : 'idle';
    },
    quit() {
      roomClient.send({ type: 'quit' });
      if (typeof onLocalQuit === 'function') onLocalQuit();
    },
    stop() {
      stopped = true;
      if (botRafId) { cancelAnimationFrame(botRafId); botRafId = null; }
      unsubscribe();
    },
  };
}
