// Mirrors public/src/runner.js so attachRaceUI works unchanged.
// The local player's id is aliased to 'player' so ui.js's `.id === 'player'` checks Just Work.
// Name collision worth knowing: the `racerId` carried by these events (and written to
// `lane.dataset.racerId` in ui.js) is that lane key — the server's ephemeral broadcast id,
// or the 'player' alias — never the localStorage racerId, which is the reconnect secret and
// leaves this browser only inside `hello` (see identity.js).

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
        // Reconnect bootstrap: if we joined mid-race and don't yet have bot
        // timelines locally, take them from the state snapshot and start the
        // bot tick loop. Without this, a brief disconnect mid-race leaves
        // all bots frozen at score 0 because the original 'bot-timelines'
        // message was only sent once at countdown→racing transition.
        if (
          msg.state.state === 'racing'
          && msg.state.botTimelines?.length
          && !botTimelines
        ) {
          botTimelines = msg.state.botTimelines;
          if (msg.state.raceStartedAt) raceStartedAtMs = msg.state.raceStartedAt;
          if (botRafId) cancelAnimationFrame(botRafId);
          botRafId = requestAnimationFrame(tickBots);
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
      case 'captcha': {
        // Server-side verification: the pace was superhuman and the result is
        // held until these are answered. Problems arrive without answers.
        emit('captcha', { problems: msg.problems, remainingMs: msg.remainingMs });
        break;
      }
      case 'captcha-result': {
        emit('captcha-result', { verified: !!msg.verified, reason: msg.reason ?? null });
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
    // Captcha answers bypass the optimistic race path entirely: the server
    // grades them and the client learns the outcome in `captcha-result`.
    submitCaptchaAnswer(raw) {
      roomClient.send({ type: 'captcha-answer', value: raw });
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
