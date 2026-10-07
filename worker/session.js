// Session helper. Reads the current user_id from the session cookie via
// better-auth, with a test override so unit tests can inject a user without
// going through a real signup/sign-in dance.
//
// Route handlers and the Worker entry import readUserId from here. Test files
// import _setTestUserId to inject a known user id.

import { getAuth } from "./auth.js";

let TEST_USER_ID_OVERRIDE = null;
let TEST_USERNAME_OVERRIDE = null;

/**
 * Inject a user_id (and optionally that user's username) for tests. Pass null
 * to clear. Has no effect in real requests because tests run inside
 * vitest-pool-workers with an isolated module graph; production code paths
 * never call this.
 */
export function _setTestUserId(id, username = null) {
  TEST_USER_ID_OVERRIDE = id;
  TEST_USERNAME_OVERRIDE = id === null ? null : username;
}

// Cache the auth instance per-isolate. better-auth construction is non-trivial
// (kysely, dialect detection, plugin wiring) — initializing once per cold
// start is plenty for our request volume.
let _auth = null;

export async function readUserId(request, env) {
  return (await readSessionUser(request, env))?.id ?? null;
}

/**
 * The signed-in user's id and username, or null for a guest. `username` is
 * null until an OAuth signup has picked one. One session lookup serves both,
 * for the room upgrade that stamps each on its own header.
 *
 * @returns {Promise<{ id: string, username: string|null } | null>}
 */
export async function readSessionUser(request, env) {
  if (TEST_USER_ID_OVERRIDE !== null) {
    return { id: TEST_USER_ID_OVERRIDE, username: TEST_USERNAME_OVERRIDE };
  }

  if (!_auth) _auth = getAuth(env);

  const session = await _auth.api.getSession({ headers: request.headers });
  const id = session?.user?.id;
  if (!id) return null;
  return { id, username: session.user.username || null };
}
