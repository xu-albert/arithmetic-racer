// Mirrors public/src/runner.js so attachRaceUI works unchanged.
// The local player's id is aliased to 'player' so ui.js's `.id === 'player'` checks Just Work.

const PLAYER_ALIAS = 'player';
const GRACE_PERIOD_MS = 5000; // mirrors runner.js

function aliasId(id, youAre) {
  return id === youAre ? PLAYER_ALIAS : id;
}

function buildRacers(players, youAre) {
  return players.map((p) => ({
    id: aliasId(p.id, youAre),
    handle: p.handle,
    isBot: false,
    tier: null,
    score: p.score ?? 0,
    finishMs: p.finishMs ?? null,
    dropped: !!p.dropped,
    dnf: !!p.dnf,
  }));
}

export function createRemoteRunner({ roomClient, initialState, youAre, onLocalQuit }) {
  const raceLength = initialState.raceLength;
  let racers = buildRacers(initialState.players, youAre);
  let sequence = initialState.problemSequence ?? [];
  const listeners = new Set();
  let stopped = false;
  let raceStartEmitted = false;
  let lastCountdownN = null;

  function emit(event, data) {
    if (stopped) return;
    for (const l of listeners) l(event, data);
  }

  function findRacer(serverPlayerId) {
    const aliased = aliasId(serverPlayerId, youAre);
    return racers.find((r) => r.id === aliased);
  }

  function getRankings() {
    const tier = (r) => (r.dropped || r.dnf ? 3 : r.finishMs != null ? 1 : 2);
    return [...racers].sort((a, b) => {
      const ta = tier(a);
      const tb = tier(b);
      if (ta !== tb) return ta - tb;
      if (ta === 1) return a.finishMs - b.finishMs;
      if (ta === 2) return b.score - a.score;
      return 0;
    });
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
            existing.handle = p.handle;
            existing.score = p.score ?? existing.score;
            if (p.finishMs != null) existing.finishMs = p.finishMs;
            existing.dropped = !!p.dropped;
            existing.dnf = !!p.dnf;
          } else {
            racers.push({
              id: aliased,
              handle: p.handle,
              isBot: false,
              tier: null,
              score: p.score ?? 0,
              finishMs: p.finishMs ?? null,
              dropped: !!p.dropped,
              dnf: !!p.dnf,
            });
          }
        }
        if (msg.state.problemSequence?.length) sequence = msg.state.problemSequence;
        // Replay countdown if we joined mid-countdown and haven't seen a countdown event yet.
        if (msg.state.state === 'countdown' && msg.state.countdownN != null && lastCountdownN == null) {
          lastCountdownN = msg.state.countdownN;
          emit('countdown', { n: msg.state.countdownN });
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
        raceStartEmitted = true;
        emit('start', { problem: sequence[0] });
        break;
      }
      case 'advance': {
        const r = findRacer(msg.playerId);
        if (!r) break;
        r.score = msg.score;
        if (msg.finishMs != null) r.finishMs = msg.finishMs;
        emit('advance', { racerId: r.id, score: r.score, finishMs: r.finishMs });
        // For the local player, push the next problem to mirror runner.js behavior.
        if (r.id === PLAYER_ALIAS) {
          const next = sequence[r.score] ?? null;
          if (next) emit('problem', { problem: next });
        }
        break;
      }
      case 'wrong': {
        // ui.js shakes the local input on any 'wrong' event without checking racerId
        // (runner.js only ever emits wrong for the local player). Mirror that here.
        if (msg.playerId !== youAre) break;
        emit('wrong', { racerId: PLAYER_ALIAS });
        break;
      }
      case 'drop': {
        const r = findRacer(msg.playerId);
        if (!r) break;
        r.dropped = true;
        emit('drop', { racerId: r.id });
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

  return {
    racers,
    sequence,
    raceLength,
    getRankings,
    on(handler) { listeners.add(handler); return () => listeners.delete(handler); },
    start() { /* no-op; server drives countdown */ },
    submitAnswer(raw) {
      roomClient.send({ type: 'answer', value: raw });
      return { correct: true }; // ui.js doesn't use the return value; events do the work.
    },
    currentProblemFor(racerId) {
      const r = racers.find((x) => x.id === racerId);
      return r ? sequence[r.score] ?? null : null;
    },
    getState() {
      return raceStartEmitted ? 'racing' : 'idle';
    },
    quit() {
      roomClient.send({ type: 'quit' });
      if (typeof onLocalQuit === 'function') onLocalQuit();
    },
    stop() {
      stopped = true;
      unsubscribe();
    },
  };
}
