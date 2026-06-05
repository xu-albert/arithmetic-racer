// Pure bot-timeline computation. Both server (at race-start in PublicRaceRoom)
// and client (as a fallback if race-start message lost botTimelines) call this
// with the same args and get identical results.
//
// Each bot's timeline is a sorted array of ms-offsets-from-raceStartedAt at
// which that bot completes its 1st, 2nd, ..., raceLength-th problem.

import { seededRng } from './seeded-rng.js';
import { nextBotDelay } from './bot.js';

export function computeBotTimelines({ botSeed, botTiers, difficulty, raceLength }) {
  const result = [];
  for (let i = 0; i < botTiers.length; i++) {
    const rng = seededRng((botSeed + i) >>> 0);
    const ticks = [];
    let t = 0;
    for (let k = 0; k < raceLength; k++) {
      t += nextBotDelay(botTiers[i], difficulty, rng);
      ticks.push(t);
    }
    result.push(ticks);
  }
  return result;
}

export function scoreBotAt(timeline, elapsedMs) {
  let s = 0;
  while (s < timeline.length && timeline[s] <= elapsedMs) s++;
  return s;
}
