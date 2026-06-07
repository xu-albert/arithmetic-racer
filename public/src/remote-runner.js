// Mirrors public/src/runner.js so attachRaceUI works unchanged.
// The local player's id is aliased to 'player' so ui.js's `.id === 'player'` checks Just Work.

import { validateAnswer } from './game.js';
import { scoreBotAt } from './bot-timeline.js';

const PLAYER_ALIAS = 'player';

function aliasId(id, youAre) {
  return id === youAre ? PLAYER_ALIAS : id;
}

// Until accounts ship, every human multiplayer participant is a guest. Append the
// marker inline so it shows up on race lanes + podium without modifying ui.js.
// Bots are excluded — they already have synthetic handles.
function displayHandle(rawHandle, isBot) {
  return isBot ? rawHandle : `${rawHandle} (Guest)`;
}

function buildRacers(players, youAre) {
  return players.map((p) => ({
    id: aliasId(p.id, youAre),
    handle: displayHandle(p.handle, !!p.isBot),
    isBot: !!p.isBot,
    tier: p.tier ?? null,
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
        emit('advance', { racerId: bot.id, score: bot.score, finishMs: bot.finishMs });
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
            existing.handle = displayHandle(p.handle, !!p.isBot);
            // Don't overwrite bot scores mid-race — client drives them via tickBots.
            if (!existing.isBot) existing.score = p.score ?? existing.score;
            if (p.finishMs != null) existing.finishMs = p.finishMs;
            existing.dropped = !!p.dropped;
            existing.dnf = !!p.dnf;
          } else {
            racers.push({
              id: aliased,
              handle: displayHandle(p.handle, !!p.isBot),
              isBot: !!p.isBot,
              tier: p.tier ?? null,
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
        raceStartedAtMs = msg.raceStartedAt;
        raceStartEmitted = true;
        emit('start', { problem: sequence[0] });
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
            emit('advance', { racerId: r.id, score: r.score, finishMs: r.finishMs });
            const next = sequence[r.score] ?? null;
            if (next) emit('problem', { problem: next });
          }
          break;
        }
        // Opponents: update from server.
        r.score = msg.score;
        if (msg.finishMs != null) r.finishMs = msg.finishMs;
        emit('advance', { racerId: r.id, score: r.score, finishMs: r.finishMs });
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
        emit('advance', { racerId: me.id, score: me.score, finishMs: me.finishMs });
        const next = sequence[me.score] ?? null;
        if (next) emit('problem', { problem: next });
        return { correct: true };
      }
      emit('wrong', { racerId: me.id });
      return { correct: false };
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
      if (botRafId) { cancelAnimationFrame(botRafId); botRafId = null; }
      unsubscribe();
    },
  };
}
