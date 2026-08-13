// Tests for migrations/0009_race_results_points.sql.
//
// The backfill is a one-shot rewrite of history: if it is wrong, every past
// race is wrong and the only fix is another migration. So it gets tested the
// way it will actually run — the real .sql files, applied in filename order to
// a real SQLite database (better-sqlite3, already a devDependency), with rows
// seeded *before* 0009 so the UPDATE sees genuine historical data.
//
// D1 is SQLite, so the SQL semantics under test here are the ones production
// gets. Runs on node:test rather than vitest-pool-workers because it needs the
// filesystem to read the migrations it is testing.

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";

const MIGRATIONS_DIR = dirname(fileURLToPath(import.meta.url));
const POINTS_MIGRATION = "0009_race_results_points.sql";

function migrationFiles() {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith(".sql"))
    .sort();
}

/** Apply every migration up to (excluding) 0009 — the schema history lands on. */
function freshDbBeforePoints() {
  const db = new Database(":memory:");
  for (const file of migrationFiles()) {
    if (file >= POINTS_MIGRATION) break;
    db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
  }
  return db;
}

function applyPointsMigration(db) {
  db.exec(readFileSync(join(MIGRATIONS_DIR, POINTS_MIGRATION), "utf8"));
}

let seq = 0;
function seedRace(db, overrides = {}) {
  const r = {
    id: `race-${++seq}`,
    device_id: "dev-1",
    difficulty: "medium",
    finished: 1,
    finish_time_ms: 60_000,
    problems_total: 20,
    problems_correct: 20,
    problems_attempted: 20,
    avg_time_per_problem_ms: 3000,
    accuracy_pct: 100,
    longest_streak: 20,
    played_at: 1_700_000_000_000,
    ...overrides,
  };
  db.prepare(
    `INSERT INTO race_results (
       id, device_id, difficulty, finished, finish_time_ms,
       problems_total, problems_correct, problems_attempted,
       avg_time_per_problem_ms, accuracy_pct, longest_streak, played_at
     ) VALUES (@id,@device_id,@difficulty,@finished,@finish_time_ms,
       @problems_total,@problems_correct,@problems_attempted,
       @avg_time_per_problem_ms,@accuracy_pct,@longest_streak,@played_at)`
  ).run(r);
  return r.id;
}

const pointsOf = (db, id) =>
  db.prepare("SELECT points FROM race_results WHERE id = ?").get(id).points;

test("adds a nullable points column without disturbing existing rows", () => {
  const db = freshDbBeforePoints();
  const id = seedRace(db, { accuracy_pct: 92.5, longest_streak: 7 });
  applyPointsMigration(db);

  const row = db.prepare("SELECT * FROM race_results WHERE id = ?").get(id);
  assert.ok("points" in row);
  assert.equal(row.accuracy_pct, 92.5);
  assert.equal(row.longest_streak, 7);
  assert.equal(row.finish_time_ms, 60_000);
});

test("backfills historical rows with volume x rate / 60", () => {
  const db = freshDbBeforePoints();
  // 20 correct in 60s: 20 ppm, 20 x 20/60 = 6.667 points.
  const oneMinute = seedRace(db, { finish_time_ms: 60_000, problems_correct: 20 });
  // Twice the volume in the same time -> four times the points (volume enters
  // twice: once directly, once through the rate).
  const doubleVolume = seedRace(db, { finish_time_ms: 60_000, problems_correct: 40 });
  // Twice the volume at the same rate -> twice the points. This is the
  // grinding-pays property: a longer race is worth more.
  const doubleLength = seedRace(db, { finish_time_ms: 120_000, problems_correct: 40 });
  // Same volume in half the time -> twice the points.
  const halfMinute = seedRace(db, { finish_time_ms: 30_000, problems_correct: 20 });
  applyPointsMigration(db);

  assert.ok(Math.abs(pointsOf(db, oneMinute) - 20 * 20 * 1000 / 60_000) < 1e-9);
  assert.ok(Math.abs(pointsOf(db, doubleVolume) - 4 * pointsOf(db, oneMinute)) < 1e-9);
  assert.ok(Math.abs(pointsOf(db, doubleLength) - 2 * pointsOf(db, oneMinute)) < 1e-9);
  assert.ok(Math.abs(pointsOf(db, halfMinute) - 2 * pointsOf(db, oneMinute)) < 1e-9);
});

test("backfill does not weight or compare across difficulties", () => {
  const db = freshDbBeforePoints();
  // Identical races, different tiers: identical points. The tiers are separate
  // pools, never a single weighted scale.
  const ids = ["easy", "medium", "hard"].map((difficulty) =>
    seedRace(db, { difficulty, finish_time_ms: 45_000, problems_correct: 15 })
  );
  applyPointsMigration(db);

  const [easy, medium, hard] = ids.map((id) => pointsOf(db, id));
  assert.equal(easy, medium);
  assert.equal(medium, hard);
});

test("backfill leaves unfinished and untimed races NULL, not 0", () => {
  const db = freshDbBeforePoints();
  const dnf = seedRace(db, { finished: 0, finish_time_ms: null, problems_correct: 4 });
  // finished=0 but a time somehow present: still not a finish, still NULL.
  const quitWithTime = seedRace(db, { finished: 0, finish_time_ms: 30_000 });
  // finished=1 with no time is a writer bug, not a zero-second race.
  const finishedNoTime = seedRace(db, { finished: 1, finish_time_ms: null });
  const zeroTime = seedRace(db, { finished: 1, finish_time_ms: 0 });
  applyPointsMigration(db);

  assert.equal(pointsOf(db, dnf), null);
  assert.equal(pointsOf(db, quitWithTime), null);
  assert.equal(pointsOf(db, finishedNoTime), null);
  assert.equal(pointsOf(db, zeroTime), null);
});

test("backfill scores a finished race with nothing correct as 0", () => {
  const db = freshDbBeforePoints();
  // 0 is earnable, so it must be distinguishable from a DNF's NULL.
  const id = seedRace(db, { finished: 1, finish_time_ms: 60_000, problems_correct: 0 });
  applyPointsMigration(db);
  assert.equal(pointsOf(db, id), 0);
});

test("backfill scores suspect rows too — flagging is a read-time filter", () => {
  const db = freshDbBeforePoints();
  // migrations/0007 stores the verdict rather than dropping the row, and only
  // leaderboards filter it. The score still gets computed.
  const id = seedRace(db, { finish_time_ms: 1_000, problems_correct: 20 });
  db.prepare("UPDATE race_results SET suspect = 1, suspect_reason = ? WHERE id = ?").run(
    "impossibly_fast",
    id
  );
  applyPointsMigration(db);
  assert.ok(pointsOf(db, id) > 0);
});
