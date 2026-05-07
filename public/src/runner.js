// Local "simulated server" — owns race state, drives bot timers, exposes events.
// Same shape as the real Socket.io server we'll build in Phase 6, so the UI doesn't change.
//
// Events emitted (as (eventName, payload)):
//   countdown { n }           — n=3, 2, 1; one per second before start
//   start     { problem }     — race begins; problem is the first one for the player
//   advance   { racerId, score, finishMs? }   — a racer answered correctly; finishMs set if they finished
//   problem   { problem }     — next problem for the player after a correct answer
//   wrong     { racerId }     — player submitted a wrong answer (no penalty, just a UI ping)
//   drop      { racerId }     — a bot dropped out mid-race (looks like a disconnect)
//   finish    { rankings }    — race over; rankings sorted best-first, dropped at the bottom

import { generateSequence, validateAnswer } from './game.js';
import { nextBotDelay } from './bot.js';

export const RACE_LENGTH = 10;
export const COUNTDOWN_SECONDS = 3;
export const DROPOUT_CHANCE_PER_ANSWER = 0.012;
// After the player crosses the line, give close-behind racers this long to finish
// before locking in the podium. Anyone still racing at expiry is marked dnf.
export const GRACE_PERIOD_MS = 5000;

export function createRunner({ difficulty, seed, player, bots = [], length = RACE_LENGTH }) {
  const sequence = generateSequence(difficulty, length, seed);

  const racers = [
    {
      id: 'player',
      handle: player.handle,
      isBot: false,
      tier: null,
      score: 0,
      finishMs: null,
      dropped: false,
      dnf: false,
    },
    ...bots.map((b, i) => ({
      id: `bot-${i}`,
      handle: b.handle,
      isBot: true,
      tier: b.tier,
      score: 0,
      finishMs: null,
      dropped: false,
      dnf: false,
    })),
  ];

  const listeners = new Set();
  let state = 'idle';
  let startedAt = null;
  const timers = new Set();

  function emit(event, data) {
    for (const l of listeners) l(event, data);
  }

  function setTimer(fn, ms) {
    const t = setTimeout(() => {
      timers.delete(t);
      fn();
    }, ms);
    timers.add(t);
    return t;
  }

  function clearAllTimers() {
    for (const t of timers) clearTimeout(t);
    timers.clear();
  }

  function advance(racerId) {
    if (state !== 'racing') return;
    const r = racers.find((x) => x.id === racerId);
    if (!r || r.dropped || r.score >= length) return;
    r.score++;
    if (r.score >= length) {
      r.finishMs = Date.now() - startedAt;
    }
    emit('advance', { racerId: r.id, score: r.score, finishMs: r.finishMs });
    if (r.id === 'player' && r.score >= length) {
      // Give close-behind racers a short window to finish before locking the podium.
      setTimer(finishRace, GRACE_PERIOD_MS);
    }
    checkRaceComplete();
  }

  function dropBot(bot) {
    if (bot.dropped) return;
    bot.dropped = true;
    emit('drop', { racerId: bot.id });
    checkRaceComplete();
  }

  function checkRaceComplete() {
    if (state !== 'racing') return;
    const allDone = racers.every((r) => r.dropped || r.score >= length);
    if (allDone) finishRace();
  }

  function maybeDropOut(bot) {
    // Only drop in the middle of a race, never at the very start (looks unnatural)
    // and never within 2 of the finish (steals the finish-line drama).
    if (bot.score < 3 || bot.score >= length - 2) return false;
    if (Math.random() < DROPOUT_CHANCE_PER_ANSWER) {
      dropBot(bot);
      return true;
    }
    return false;
  }

  function scheduleBot(bot) {
    if (state !== 'racing' || bot.dropped || bot.score >= length) return;
    const delay = nextBotDelay(bot.tier, difficulty);
    setTimer(() => {
      if (maybeDropOut(bot)) return;
      advance(bot.id);
      scheduleBot(bot);
    }, delay);
  }

  function startRace() {
    state = 'racing';
    startedAt = Date.now();
    emit('start', { problem: sequence[0] });
    for (const bot of racers.filter((r) => r.isBot)) scheduleBot(bot);
  }

  function getRankings() {
    // Tiers: finished (1) ranks above still-racing (2) ranks above dropped/dnf (3).
    // Within finished: faster finishMs first. Within still-racing: higher score first.
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

  function finishRace() {
    if (state === 'finished') return;
    state = 'finished';
    clearAllTimers();
    for (const r of racers) {
      if (!r.dropped && r.finishMs == null) r.dnf = true;
    }
    emit('finish', { rankings: getRankings() });
  }

  return {
    racers,
    sequence,
    raceLength: length,
    getRankings,

    on(handler) {
      listeners.add(handler);
      return () => listeners.delete(handler);
    },

    start() {
      if (state !== 'idle') return;
      state = 'countdown';
      let n = COUNTDOWN_SECONDS;
      const tick = () => {
        emit('countdown', { n });
        n--;
        if (n >= 1) setTimer(tick, 1000);
        else setTimer(startRace, 1000);
      };
      tick();
    },

    submitAnswer(input) {
      if (state !== 'racing') return { correct: false, reason: 'not-racing' };
      const player = racers.find((r) => !r.isBot);
      if (player.score >= length) return { correct: false, reason: 'finished' };
      const problem = sequence[player.score];
      if (validateAnswer(problem, input)) {
        advance('player');
        const next = sequence[player.score] ?? null;
        if (next && state === 'racing') emit('problem', { problem: next });
        return { correct: true, next };
      }
      emit('wrong', { racerId: 'player' });
      return { correct: false };
    },

    currentProblemFor(racerId) {
      const r = racers.find((x) => x.id === racerId);
      if (!r) return null;
      return sequence[r.score] ?? null;
    },

    getState() {
      return state;
    },

    quit() {
      if (state !== 'racing') return;
      const player = racers.find((r) => !r.isBot);
      if (!player || player.dropped || player.score >= length) return;
      player.dropped = true;
      emit('drop', { racerId: player.id });
      finishRace();
    },

    stop() {
      clearAllTimers();
      state = 'finished';
    },
  };
}
