// xorshift32 — deterministic PRNG identical across server (workerd/V8) and
// any modern browser. All ops stay in unsigned-32 space via `>>> 0`; only the
// final divide-to-float produces a IEEE-754 value, which is also deterministic.
//
// Returns a function () => number in [0, 1). Pass the same seed on server
// and client to get identical sequences.
export function seededRng(seed) {
  // The all-zero state is a fixed point. Force a non-zero start.
  let state = (seed >>> 0) || 0x9e3779b9;
  return function next() {
    state ^= state << 13;
    state = state >>> 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state = state >>> 0;
    return state / 0x100000000;
  };
}
