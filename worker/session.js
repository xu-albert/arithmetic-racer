// Session helper. Reads the current user_id from the session cookie via
// better-auth, with a test override so unit tests can inject a user without
// going through a real signup/sign-in dance.
//
// Both worker/routes/race-result.js and worker/routes/me.js import readUserId
// from here. Test files import _setTestUserId to inject a known user id.

import { getAuth } from "./auth.js";

let TEST_USER_ID_OVERRIDE = null;

/**
 * Inject a user_id for tests. Pass null to clear.
 * Has no effect in real requests because tests run inside vitest-pool-workers
 * with an isolated module graph; production code paths never call this.
 */
export function _setTestUserId(id) {
  TEST_USER_ID_OVERRIDE = id;
}

// Cache the auth instance per-isolate. better-auth construction is non-trivial
// (kysely, dialect detection, plugin wiring) — initializing once per cold
// start is plenty for our request volume.
let _auth = null;

export async function readUserId(request, env) {
  if (TEST_USER_ID_OVERRIDE !== null) return TEST_USER_ID_OVERRIDE;

  if (!_auth) _auth = getAuth(env);

  const session = await _auth.api.getSession({ headers: request.headers });
  return session?.user?.id ?? null;
}

/**
 * Test-only helper: drop the cached auth instance so a fresh env can be
 * picked up between test files.
 */
export function _resetAuth() {
  _auth = null;
}
