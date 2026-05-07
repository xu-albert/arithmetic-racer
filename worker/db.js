// Tiny D1 helper. Centralizes the binding lookup so route handlers don't
// reach into env directly. Add query helpers here later if patterns repeat.
export function db(env) {
  return env.DB;
}
