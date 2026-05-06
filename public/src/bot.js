// Bot timing model. Bots don't compute answers; they just "advance" on a schedule.
// Wrong answers don't penalize anyone in this game, so a bot's tier is purely how often it produces
// a correct answer.
//
// Mario Kart CC scaling: a bot's effective speed is HUMAN_AVG_PPM[difficulty] * tier.factor.
// At easy, most bots are slower than a typical human; at hard, most bots are faster.
// HUMAN_AVG_PPM is a rough "what does an average human do at this tier" baseline (problems/minute).

export const HUMAN_AVG_PPM = {
  easy: 35,
  medium: 20,
  hard: 12,
};

export const BOT_TIERS = {
  slow:   { factor: 0.55, jitter: 0.30 },
  medium: { factor: 0.95, jitter: 0.25 },
  fast:   { factor: 1.40, jitter: 0.20 },
};

export const BOT_TIER_NAMES = Object.keys(BOT_TIERS);

// Distribution of tiers across bots, by difficulty. Mario Kart CC: easy is forgiving,
// hard is brutal. Weights are relative — pickBotTiers samples from them.
export const TIER_WEIGHTS = {
  easy:   { slow: 75, medium: 20, fast: 5 },
  medium: { slow: 25, medium: 50, fast: 25 },
  hard:   { slow: 10, medium: 30, fast: 60 },
};

export function nextBotDelay(tier, difficulty, rng = Math.random) {
  const config = BOT_TIERS[tier];
  if (!config) throw new Error(`Unknown bot tier: ${tier}`);
  const ppm = HUMAN_AVG_PPM[difficulty];
  if (!ppm) throw new Error(`Unknown difficulty: ${difficulty}`);
  const meanMs = 60000 / (ppm * config.factor);
  const jitter = (rng() * 2 - 1) * meanMs * config.jitter;
  return Math.max(50, Math.round(meanMs + jitter));
}

export function pickBotTiers(difficulty, count, rng = Math.random) {
  const weights = TIER_WEIGHTS[difficulty];
  if (!weights) throw new Error(`Unknown difficulty: ${difficulty}`);
  const total = Object.values(weights).reduce((a, b) => a + b, 0);
  const tiers = [];
  for (let i = 0; i < count; i++) {
    let r = rng() * total;
    for (const [name, w] of Object.entries(weights)) {
      r -= w;
      if (r <= 0) {
        tiers.push(name);
        break;
      }
    }
  }
  return tiers;
}
