import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankRacers } from './rankings.js';

const racer = (id, extra = {}) => ({ id, score: 0, finishMs: null, dropped: false, dnf: false, ...extra });

test('finished racers come first, fastest time on top', () => {
  const out = rankRacers([racer('slow', { finishMs: 9000 }), racer('fast', { finishMs: 4000 }), racer('mid', { finishMs: 6000 })]);
  assert.deepEqual(out.map((r) => r.id), ['fast', 'mid', 'slow']);
});

test('still-racing racers rank below any finisher, ordered by score', () => {
  const out = rankRacers([racer('two', { score: 2 }), racer('done', { score: 10, finishMs: 30_000 }), racer('five', { score: 5 })]);
  assert.deepEqual(out.map((r) => r.id), ['done', 'five', 'two']);
});

test('dnf and dropped racers sit at the bottom regardless of score, dnf above dropped', () => {
  const out = rankRacers([
    racer('quit', { score: 9, dropped: true }),
    racer('dnf', { score: 8, dnf: true }),
    racer('racing', { score: 1 }),
    racer('finished', { score: 10, finishMs: 60_000 }),
  ]);
  assert.deepEqual(out.map((r) => r.id), ['finished', 'racing', 'dnf', 'quit']);
});

test('racers who are out rank by score, so a solo quitter sits under the bots and the bots are in order', () => {
  // runner.quit() ends the race and marks every bot dnf alongside the
  // dropped player, so the whole field lands in the out tier at once.
  const out = rankRacers([
    racer('player', { score: 0, dropped: true }),
    racer('bot-a', { score: 4, dnf: true }),
    racer('bot-b', { score: 6, dnf: true }),
    racer('bot-c', { score: 4, dnf: true }),
  ]);
  assert.deepEqual(out.map((r) => r.id), ['bot-b', 'bot-a', 'bot-c', 'player']);
});

test('within the dnf and dropped tiers, a higher score ranks first', () => {
  const out = rankRacers([
    racer('dnf-8', { score: 8, dnf: true }),
    racer('quit-2', { score: 2, dropped: true }),
    racer('dnf-9', { score: 9, dnf: true }),
    racer('quit-7', { score: 7, dropped: true }),
  ]);
  assert.deepEqual(out.map((r) => r.id), ['dnf-9', 'dnf-8', 'quit-7', 'quit-2']);
});

test('a dropped racer with a finish time is still out — dropped wins over finishMs', () => {
  const out = rankRacers([racer('ghost', { finishMs: 1, dropped: true }), racer('real', { finishMs: 5000 })]);
  assert.deepEqual(out.map((r) => r.id), ['real', 'ghost']);
});

test('ties keep arrival order (stable), within every tier', () => {
  const out = rankRacers([
    racer('a', { finishMs: 5000 }),
    racer('b', { finishMs: 5000 }),
    racer('c', { score: 3 }),
    racer('d', { score: 3 }),
    racer('e', { dnf: true }),
    racer('f', { dnf: true }),
    racer('g', { dropped: true }),
    racer('h', { dropped: true }),
  ]);
  assert.deepEqual(out.map((r) => r.id), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']);
});

test('returns a new array and leaves the input untouched', () => {
  const input = [racer('x', { score: 1 }), racer('y', { score: 2 })];
  const out = rankRacers(input);
  assert.notEqual(out, input);
  assert.deepEqual(input.map((r) => r.id), ['x', 'y']);
  assert.deepEqual(out.map((r) => r.id), ['y', 'x']);
  assert.deepEqual(rankRacers([]), []);
});

test('a score of 0 and a finishMs of 0 are both real values, not "missing"', () => {
  const out = rankRacers([racer('zero-score', { score: 0 }), racer('instant', { score: 3, finishMs: 0 })]);
  assert.deepEqual(out.map((r) => r.id), ['instant', 'zero-score']);
});
