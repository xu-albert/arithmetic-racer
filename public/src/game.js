// Pure problem-generation + answer-validation logic.
// No DOM, no globals beyond Math.random fallback. Ports straight to the server in Phase 6.

export const DIFFICULTIES = ['easy', 'medium', 'hard'];

const DEFAULT_RNG = Math.random;

function randInt(min, max, rng) {
  return Math.floor(rng() * (max - min + 1)) + min;
}

function easyProblem(rng) {
  const op = rng() < 0.5 ? '+' : '-';
  let a = randInt(0, 9, rng);
  let b = randInt(0, 9, rng);
  if (op === '-' && b > a) [a, b] = [b, a];
  const answer = op === '+' ? a + b : a - b;
  return { problem: `${a} ${op} ${b}`, answer };
}

function mediumProblem(rng) {
  const ops = ['+', '-', '×'];
  const op = ops[randInt(0, 2, rng)];
  if (op === '×') {
    const a = randInt(10, 99, rng);
    const b = randInt(2, 9, rng);
    return { problem: `${a} × ${b}`, answer: a * b };
  }
  let a = randInt(10, 99, rng);
  let b = randInt(10, 99, rng);
  if (op === '-' && b > a) [a, b] = [b, a];
  const answer = op === '+' ? a + b : a - b;
  return { problem: `${a} ${op} ${b}`, answer };
}

function hardProblem(rng) {
  const op = rng() < 0.5 ? '×' : '÷';
  if (op === '×') {
    const a = randInt(11, 19, rng);
    const b = randInt(2, 9, rng);
    return { problem: `${a} × ${b}`, answer: a * b };
  }
  const divisor = randInt(2, 9, rng);
  const quotient = randInt(2, 19, rng);
  const dividend = divisor * quotient;
  return { problem: `${dividend} ÷ ${divisor}`, answer: quotient };
}

const GENERATORS = { easy: easyProblem, medium: mediumProblem, hard: hardProblem };

export function generateProblem(difficulty, rng = DEFAULT_RNG) {
  const gen = GENERATORS[difficulty];
  if (!gen) throw new Error(`Unknown difficulty: ${difficulty}`);
  return gen(rng);
}

export function validateAnswer(problem, userAnswer) {
  const raw = typeof userAnswer === 'string' ? userAnswer.trim() : userAnswer;
  if (raw === '' || raw === null || raw === undefined) return false;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return false;
  return parsed === problem.answer;
}

// Mulberry32 — small deterministic PRNG for testing and for shared problem sequences across players.
export function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Generate a fixed-length problem sequence from a seed.
// Used at race start so all players see the same problems in the same order.
export function generateSequence(difficulty, length, seed) {
  const rng = makeRng(seed);
  const out = [];
  for (let i = 0; i < length; i++) out.push(generateProblem(difficulty, rng));
  return out;
}
