import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateHandle } from './handles.js';
import { makeRng } from './game.js';

test('generateHandle returns adjective+animal format', () => {
  const handle = generateHandle(makeRng(1));
  assert.match(handle, /^[A-Z][a-z]+[A-Z][a-z]+$/);
});

test('generateHandle avoids names already taken', () => {
  const taken = new Set();
  for (let i = 0; i < 50; i++) {
    const h = generateHandle(makeRng(i + 1), taken);
    assert.ok(!taken.has(h), `duplicate handle: ${h}`);
    taken.add(h);
  }
});

test('generateHandle is deterministic with seeded RNG', () => {
  const a = generateHandle(makeRng(42));
  const b = generateHandle(makeRng(42));
  assert.equal(a, b);
});
