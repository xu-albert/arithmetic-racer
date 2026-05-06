// Worker entry. Routes /api/* to handlers; falls through to static assets.
//
// Phase 3 (Integration): real handlers replace the Foundation stubs.
// /api/auth/* is mounted on better-auth's handler.

import { handleRaceResult } from "./routes/race-result.js";
import { handleGetMe, handlePostUsername, handleByDevice } from "./routes/me.js";
import { getAuth } from "./auth.js";

let _auth = null;
function authFor(env) {
  if (!_auth) _auth = getAuth(env);
  return _auth;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    // better-auth owns the entire /api/auth/* prefix.
    if (pathname.startsWith("/api/auth/")) {
      return authFor(env).handler(request);
    }

    if (pathname === "/api/race-result" && request.method === "POST") {
      return handleRaceResult(request, env);
    }
    if (pathname === "/api/me" && request.method === "GET") {
      return handleGetMe(request, env);
    }
    if (pathname === "/api/me/username" && request.method === "POST") {
      return handlePostUsername(request, env);
    }
    if (pathname.startsWith("/api/stats/by-device/") && request.method === "GET") {
      return handleByDevice(request, env);
    }

    // Fall through to static assets (index.html, css, js, reset-password.html).
    return env.ASSETS.fetch(request);
  },
};
