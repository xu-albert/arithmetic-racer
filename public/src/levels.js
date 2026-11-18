// Skill and experience levels: named bands over stats the profile already has.
//
// Pure presentation. Nothing here is stored or sent anywhere: a skill band is
// read off a difficulty's `avg_ppm` and an experience band off the race count,
// both of which GET /api/me already aggregates (worker/routes/me.js). Changing
// a threshold below re-labels every racer on their next profile load, and that
// is fine precisely because no row records a band.
//
// Skill is per difficulty, like every speed number on the site: a hard problem
// takes roughly three times as long as an easy one, so one PPM ladder for all
// three tiers would just say which tier you played. Each tier gets its own
// thresholds, and the profile shows a band beside each tier's raw PPM rather
// than one blended level.

/**
 * Skill ladders, slowest first. `minPpm` is the inclusive floor of the band.
 *
 * The thresholds are anchored on HUMAN_AVG_PPM in bot.js (easy 35, medium 24,
 * hard 12 — the "typical human" pace the bots are tuned around): that pace
 * lands mid-"Racer" on every tier, the fast bot tier (1.4×) lands in
 * "Speedster", and the slow one (0.55×) in "Cruiser". The top band sits well
 * under the 500 ms/problem captcha trigger (120 PPM, worker/plausibility.js)
 * on every tier, so it is reachable by an honest racer. levels.test.js pins
 * those relationships, so retuning the bots flags the ladders for a look.
 */
export const SKILL_BANDS = Object.freeze({
  easy: freezeBands([
    { name: "Learner", minPpm: 0 },
    { name: "Cruiser", minPpm: 18 },
    { name: "Racer", minPpm: 30 },
    { name: "Speedster", minPpm: 42 },
    { name: "Ace", minPpm: 56 },
    { name: "Lightning", minPpm: 75 },
  ]),
  medium: freezeBands([
    { name: "Learner", minPpm: 0 },
    { name: "Cruiser", minPpm: 12 },
    { name: "Racer", minPpm: 20 },
    { name: "Speedster", minPpm: 29 },
    { name: "Ace", minPpm: 38 },
    { name: "Lightning", minPpm: 50 },
  ]),
  hard: freezeBands([
    { name: "Learner", minPpm: 0 },
    { name: "Cruiser", minPpm: 6 },
    { name: "Racer", minPpm: 10 },
    { name: "Speedster", minPpm: 15 },
    { name: "Ace", minPpm: 20 },
    { name: "Lightning", minPpm: 26 },
  ]),
});

/**
 * Experience milestones, by races played across every difficulty (a race is
 * a race, whichever tier it was run at). `minRaces` is the inclusive floor;
 * a racer with no races has no band yet.
 */
export const EXP_BANDS = freezeBands([
  { name: "Rookie", minRaces: 1 },
  { name: "Regular", minRaces: 10 },
  { name: "Seasoned", minRaces: 25 },
  { name: "Veteran", minRaces: 50 },
  { name: "Road Warrior", minRaces: 100 },
  { name: "Legend", minRaces: 250 },
  { name: "Hall of Famer", minRaces: 500 },
]);

function freezeBands(bands) {
  return Object.freeze(bands.map((b) => Object.freeze(b)));
}

/**
 * Pick the highest band whose floor `value` reaches, plus the one above it.
 * `key` names the floor field. Null when `value` is under the lowest floor.
 */
function pickBand(bands, key, value) {
  let index = -1;
  for (let i = 0; i < bands.length; i++) {
    if (value >= bands[i][key]) index = i;
    else break;
  }
  if (index < 0) return null;
  const band = bands[index];
  const next = bands[index + 1] ?? null;
  return {
    name: band.name,
    level: index + 1,
    levels: bands.length,
    [key]: band[key],
    next: next ? { name: next.name, [key]: next[key] } : null,
  };
}

/**
 * The skill band for an average PPM at one difficulty.
 *
 * @param {number|null|undefined} ppm  average problems per minute (avg_ppm)
 * @param {string} difficulty          "easy" | "medium" | "hard"
 * @returns {{name: string, level: number, levels: number, minPpm: number,
 *            next: {name: string, minPpm: number}|null}|null}
 *   null when there is no speed to judge (no finished race, a malformed
 *   number) or the difficulty is unknown — "no band" must not read as the
 *   bottom band.
 */
export function skillBand(ppm, difficulty) {
  if (!Object.hasOwn(SKILL_BANDS, difficulty)) return null;
  if (typeof ppm !== "number" || !Number.isFinite(ppm) || ppm < 0) return null;
  return pickBand(SKILL_BANDS[difficulty], "minPpm", ppm);
}

/**
 * The experience band for a race count.
 *
 * @param {number|null|undefined} races  races played, every difficulty
 * @returns {{name: string, level: number, levels: number, minRaces: number,
 *            next: {name: string, minRaces: number}|null}|null}
 *   null below the first milestone (no races yet) or for a malformed count.
 */
export function expBand(races) {
  if (typeof races !== "number" || !Number.isFinite(races)) return null;
  return pickBand(EXP_BANDS, "minRaces", Math.floor(races));
}

/**
 * "4.2 PPM to Speedster", the gap to the next skill band, or a top-band line.
 * The gap is rounded *up* to one decimal so it never reads "0.0 PPM to" while
 * the racer is still short of the floor.
 *
 * @returns {string} "" when there is no band to progress from.
 */
export function skillProgressText(band, ppm) {
  if (!band || typeof ppm !== "number" || !Number.isFinite(ppm)) return "";
  if (!band.next) return "Top skill band";
  const gap = Math.max(0.1, Math.ceil(Number(((band.next.minPpm - ppm) * 10).toPrecision(12))) / 10);
  return `${gap.toFixed(1)} PPM to ${band.next.name}`;
}

/**
 * "13 races to Seasoned", the races left to the next milestone. With no band
 * yet it points at the first one, so an empty profile still has a goal.
 *
 * @returns {string}
 */
export function expProgressText(band, races) {
  const n = typeof races === "number" && Number.isFinite(races) ? Math.max(0, Math.floor(races)) : 0;
  const next = band ? band.next : EXP_BANDS[0];
  if (!next) return "Top experience band";
  const left = next.minRaces - n;
  return `${left} ${left === 1 ? "race" : "races"} to ${next.name}`;
}
