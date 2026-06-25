import { test } from 'node:test';
import assert from 'node:assert/strict';
import { seededRng } from './seeded-rng.js';

test('seeded-rng: deterministic — same seed produces same sequence', () => {
  const a = seededRng(0xdeadbeef);
  const b = seededRng(0xdeadbeef);
  const seqA = Array.from({ length: 10 }, () => a());
  const seqB = Array.from({ length: 10 }, () => b());
  assert.deepEqual(seqA, seqB);
});

test('seeded-rng: different seeds produce different sequences', () => {
  const a = seededRng(1);
  const b = seededRng(2);
  assert.notDeepEqual(
    Array.from({ length: 5 }, () => a()),
    Array.from({ length: 5 }, () => b()),
  );
});

test('seeded-rng: values are in [0, 1)', () => {
  const r = seededRng(42);
  for (let i = 0; i < 1000; i++) {
    const v = r();
    assert.ok(v >= 0 && v < 1, `value out of range: ${v}`);
  }
});

test('seeded-rng: seed 0 is allowed and produces a non-trivial sequence', () => {
  // xorshift32 must coerce 0 to a non-zero state to avoid the all-zero fixed point.
  const r = seededRng(0);
  const first10 = Array.from({ length: 10 }, () => r());
  // No value should be exactly 0 — that'd indicate the state collapsed.
  assert.ok(first10.every((v) => v > 0), `got zero value: ${JSON.stringify(first10)}`);
});
