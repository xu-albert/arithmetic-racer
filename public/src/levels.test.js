// Tests for levels.js: the skill ladders per difficulty, the experience
// milestones, and the progress lines the profile prints beside them.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SKILL_BANDS,
  EXP_BANDS,
  skillBand,
  expBand,
  skillProgressText,
  expProgressText,
} from "./levels.js";
import { HUMAN_AVG_PPM, BOT_TIERS } from "./bot.js";
import { CAPTCHA_TRIGGER_MS_PER_PROBLEM } from "../../worker/plausibility.js";

const DIFFICULTIES = ["easy", "medium", "hard"];

// ---------- ladder shape ----------

test("every difficulty has its own ladder, same names, strictly rising floors from 0", () => {
  assert.deepEqual(Object.keys(SKILL_BANDS).sort(), [...DIFFICULTIES].sort());
  const names = SKILL_BANDS.easy.map((b) => b.name);
  for (const d of DIFFICULTIES) {
    const bands = SKILL_BANDS[d];
    assert.deepEqual(bands.map((b) => b.name), names, `${d} uses the shared band names`);
    assert.equal(bands[0].minPpm, 0, `${d} starts at 0 so every finished racer has a band`);
    for (let i = 1; i < bands.length; i++) {
      assert.ok(bands[i].minPpm > bands[i - 1].minPpm, `${d} floors rise at ${bands[i].name}`);
    }
  }
});

test("harder tiers need fewer PPM for the same band — the ladders are per difficulty", () => {
  for (let i = 1; i < SKILL_BANDS.easy.length; i++) {
    assert.ok(SKILL_BANDS.easy[i].minPpm > SKILL_BANDS.medium[i].minPpm);
    assert.ok(SKILL_BANDS.medium[i].minPpm > SKILL_BANDS.hard[i].minPpm);
  }
});

test("the ladders stay anchored on the bots' human baseline", () => {
  // A typical human (HUMAN_AVG_PPM) is a mid-pack "Racer" on every tier, the
  // fast bot tier a "Speedster", the slow one a "Cruiser". If the bots are
  // retuned and this fails, the ladders need the same look.
  for (const d of DIFFICULTIES) {
    const avg = HUMAN_AVG_PPM[d];
    assert.equal(skillBand(avg, d).name, "Racer", `${d} average human`);
    assert.equal(skillBand(avg * BOT_TIERS.fast.factor, d).name, "Speedster", `${d} fast bot`);
    assert.equal(skillBand(avg * BOT_TIERS.slow.factor, d).name, "Cruiser", `${d} slow bot`);
  }
});

test("the top band is reachable without tripping the superhuman-pace captcha", () => {
  const captchaPpm = 60000 / CAPTCHA_TRIGGER_MS_PER_PROBLEM;
  for (const d of DIFFICULTIES) {
    const top = SKILL_BANDS[d].at(-1);
    assert.ok(top.minPpm < captchaPpm, `${d} ${top.name} floor ${top.minPpm} < ${captchaPpm}`);
  }
});

test("the band tables cannot be mutated by a caller", () => {
  assert.throws(() => SKILL_BANDS.easy.push({ name: "x", minPpm: 1 }));
  assert.throws(() => { SKILL_BANDS.easy[0].minPpm = 5; });
  assert.throws(() => { EXP_BANDS[0].minRaces = 0; });
});

// ---------- skillBand ----------

test("skillBand picks the highest floor reached, floors inclusive", () => {
  assert.equal(skillBand(0, "easy").name, "Learner");
  assert.equal(skillBand(17.99, "easy").name, "Learner");
  assert.equal(skillBand(18, "easy").name, "Cruiser");
  assert.equal(skillBand(29.9, "easy").name, "Cruiser");
  assert.equal(skillBand(30, "easy").name, "Racer");
  assert.equal(skillBand(42, "easy").name, "Speedster");
  assert.equal(skillBand(56, "easy").name, "Ace");
  assert.equal(skillBand(75, "easy").name, "Lightning");
  assert.equal(skillBand(400, "easy").name, "Lightning");
});

test("the same PPM reads as a different band on each tier", () => {
  assert.equal(skillBand(20, "easy").name, "Cruiser");
  assert.equal(skillBand(20, "medium").name, "Racer");
  assert.equal(skillBand(20, "hard").name, "Ace");
});

test("skillBand reports level, ladder size, its own floor, and the next band", () => {
  assert.deepEqual(skillBand(12, "hard"), {
    name: "Racer",
    level: 3,
    levels: 6,
    minPpm: 10,
    next: { name: "Speedster", minPpm: 15 },
  });
  const top = skillBand(60, "medium");
  assert.equal(top.name, "Lightning");
  assert.equal(top.level, 6);
  assert.equal(top.next, null);
});

test("skillBand is null when there is no speed to judge, never the bottom band", () => {
  for (const ppm of [null, undefined, NaN, Infinity, -1, "30"]) {
    assert.equal(skillBand(ppm, "easy"), null, `ppm ${String(ppm)}`);
  }
  assert.equal(skillBand(30, "expert"), null);
  assert.equal(skillBand(30, undefined), null);
  assert.equal(skillBand(30, "toString"), null, "prototype keys are not difficulties");
});

// ---------- expBand ----------

test("expBand: no band before the first race, then milestones with inclusive floors", () => {
  assert.equal(expBand(0), null);
  assert.equal(expBand(1).name, "Rookie");
  assert.equal(expBand(9).name, "Rookie");
  assert.equal(expBand(10).name, "Regular");
  assert.equal(expBand(25).name, "Seasoned");
  assert.equal(expBand(49).name, "Seasoned");
  assert.equal(expBand(50).name, "Veteran");
  assert.equal(expBand(100).name, "Road Warrior");
  assert.equal(expBand(250).name, "Legend");
  assert.equal(expBand(500).name, "Hall of Famer");
  assert.equal(expBand(12_345).name, "Hall of Famer");
});

test("expBand milestones rise strictly from 1", () => {
  assert.equal(EXP_BANDS[0].minRaces, 1);
  for (let i = 1; i < EXP_BANDS.length; i++) {
    assert.ok(EXP_BANDS[i].minRaces > EXP_BANDS[i - 1].minRaces);
  }
});

test("expBand reports level, ladder size, floor and next milestone", () => {
  assert.deepEqual(expBand(12), {
    name: "Regular",
    level: 2,
    levels: EXP_BANDS.length,
    minRaces: 10,
    next: { name: "Seasoned", minRaces: 25 },
  });
  assert.equal(expBand(500).next, null);
});

test("expBand is null for a malformed count", () => {
  for (const n of [null, undefined, NaN, Infinity, -3, "12"]) {
    assert.equal(expBand(n), null, `races ${String(n)}`);
  }
  assert.equal(expBand(9.9).name, "Rookie", "a fractional count is floored");
});

// ---------- progress text ----------

test("skillProgressText names the gap to the next band, rounded up", () => {
  assert.equal(skillProgressText(skillBand(35.1, "easy"), 35.1), "6.9 PPM to Speedster");
  // 41.99 is 0.01 short: it must not claim "0.0 PPM to".
  assert.equal(skillProgressText(skillBand(41.99, "easy"), 41.99), "0.1 PPM to Speedster");
  assert.equal(skillProgressText(skillBand(80, "easy"), 80), "Top skill band");
  assert.equal(skillProgressText(null, 30), "");
  assert.equal(skillProgressText(skillBand(30, "easy"), null), "");
});

test("expProgressText counts races to the next milestone, singular when one is left", () => {
  assert.equal(expProgressText(expBand(12), 12), "13 races to Seasoned");
  assert.equal(expProgressText(expBand(9), 9), "1 race to Regular");
  assert.equal(expProgressText(expBand(0), 0), "1 race to Rookie");
  assert.equal(expProgressText(null, null), "1 race to Rookie");
  assert.equal(expProgressText(expBand(600), 600), "Top experience band");
});
