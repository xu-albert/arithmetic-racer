import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DIFFICULTIES,
  generateProblem,
  validateAnswer,
  makeRng,
  generateSequence,
} from './game.js';

const SAMPLE_COUNT = 500;

function parseProblem(str) {
  const parts = str.split(/\s+/);
  if (parts.length !== 3) throw new Error(`Malformed problem: ${str}`);
  const a = Number(parts[0]);
  const op = parts[1];
  const b = Number(parts[2]);
  switch (op) {
    case '+': return a + b;
    case '-': return a - b;
    case '×': return a * b;
    case '÷': return a / b;
    default: throw new Error(`Unknown operator: ${op}`);
  }
}

for (const diff of DIFFICULTIES) {
  test(`${diff}: ${SAMPLE_COUNT} problems are well-formed and answers match`, () => {
    const rng = makeRng(42 + diff.length);
    for (let i = 0; i < SAMPLE_COUNT; i++) {
      const { problem, answer } = generateProblem(diff, rng);
      const computed = parseProblem(problem);
      assert.equal(
        computed,
        answer,
        `Problem "${problem}" claims answer ${answer}, parser computed ${computed}`,
      );
      assert.ok(Number.isInteger(answer), `Answer for "${problem}" is not an integer: ${answer}`);
    }
  });
}

test('easy: answers are never negative', () => {
  const rng = makeRng(7);
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const p = generateProblem('easy', rng);
    assert.ok(p.answer >= 0, `easy answer ${p.answer} for "${p.problem}"`);
  }
});

test('medium: subtraction answers are never negative', () => {
  const rng = makeRng(8);
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const p = generateProblem('medium', rng);
    if (p.problem.includes(' - ')) {
      assert.ok(p.answer >= 0, `medium subtraction answer ${p.answer} for "${p.problem}"`);
    }
  }
});

test('medium: multiplication stays within times-table range (≤12 × ≤9)', () => {
  const rng = makeRng(11);
  let seen = 0;
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const p = generateProblem('medium', rng);
    if (p.problem.includes(' × ')) {
      seen++;
      const [a, b] = p.problem.split(' × ').map(Number);
      assert.ok(a >= 2 && a <= 12, `medium × operand ${a} out of range in "${p.problem}"`);
      assert.ok(b >= 2 && b <= 9, `medium × operand ${b} out of range in "${p.problem}"`);
    }
  }
  assert.ok(seen > 0, 'expected at least one multiplication in sample');
});

test('hard: division always produces integers', () => {
  const rng = makeRng(9);
  let divisionsSeen = 0;
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const p = generateProblem('hard', rng);
    if (p.problem.includes(' ÷ ')) {
      divisionsSeen++;
      assert.ok(
        Number.isInteger(p.answer) && p.answer > 0,
        `hard division answer ${p.answer} for "${p.problem}"`,
      );
    }
  }
  assert.ok(divisionsSeen > 50, `expected many divisions in 500 hard problems, got ${divisionsSeen}`);
});

test('easy: operands stay within single-digit range', () => {
  const rng = makeRng(11);
  for (let i = 0; i < SAMPLE_COUNT; i++) {
    const p = generateProblem('easy', rng);
    const [a, , b] = p.problem.split(/\s+/);
    assert.ok(Number(a) >= 0 && Number(a) <= 9, `easy left operand ${a} out of range`);
    assert.ok(Number(b) >= 0 && Number(b) <= 9, `easy right operand ${b} out of range`);
  }
});

test('seeded RNG is reproducible', () => {
  const a = generateProblem('medium', makeRng(123));
  const b = generateProblem('medium', makeRng(123));
  assert.deepEqual(a, b);
});

test('generateSequence returns the requested number of problems', () => {
  const seq = generateSequence('medium', 20, 99);
  assert.equal(seq.length, 20);
  for (const p of seq) {
    assert.ok(typeof p.problem === 'string');
    assert.ok(Number.isInteger(p.answer));
  }
});

test('generateSequence is deterministic for a given seed', () => {
  const a = generateSequence('hard', 20, 555);
  const b = generateSequence('hard', 20, 555);
  assert.deepEqual(a, b);
});

test('generateSequence with different seeds produces different sequences', () => {
  const a = generateSequence('medium', 20, 1);
  const b = generateSequence('medium', 20, 2);
  assert.notDeepEqual(a, b);
});

test('validateAnswer: numeric inputs', () => {
  const p = { problem: '7 + 4', answer: 11 };
  assert.equal(validateAnswer(p, 11), true);
  assert.equal(validateAnswer(p, 11.0), true);
  assert.equal(validateAnswer(p, 12), false);
  assert.equal(validateAnswer(p, -11), false);
});

test('validateAnswer: string inputs', () => {
  const p = { problem: '7 + 4', answer: 11 };
  assert.equal(validateAnswer(p, '11'), true);
  assert.equal(validateAnswer(p, '  11  '), true);
  assert.equal(validateAnswer(p, '+11'), true);
  assert.equal(validateAnswer(p, '12'), false);
  assert.equal(validateAnswer(p, 'abc'), false);
  assert.equal(validateAnswer(p, ''), false);
  assert.equal(validateAnswer(p, '   '), false);
});

test('validateAnswer: nullish inputs', () => {
  const p = { problem: '7 + 4', answer: 11 };
  assert.equal(validateAnswer(p, null), false);
  assert.equal(validateAnswer(p, undefined), false);
});

test('unknown difficulty throws', () => {
  assert.throws(() => generateProblem('extreme'), /Unknown difficulty/);
});
