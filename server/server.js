// Worker entry — merged after Phase A (users + auth + stats) joined Phase 6
// (private multiplayer rooms). Order:
//   1. Phase A routes — /api/auth/*, /api/race-result, /api/me*, /api/stats/*
//   2. Phase 6 routes — /api/rooms (create) + partykit WebSocket upgrade
//   3. Static assets fallback
//
// Auth routes are checked first so they always win path resolution. partykit
// then claims its own paths (typically /parties/*). Anything not handled
// falls through to env.ASSETS.

import { routePartykitRequest } from "partyserver";
import { generateRoomId } from "./room-id.js";
import { handleRaceResult } from "../worker/routes/race-result.js";
import { handleGetMe, handlePostUsername, handleByDevice } from "../worker/routes/me.js";
import { getAuth } from "../worker/auth.js";

export { RaceRoom } from "./room.js";

// Cache the auth instance per-isolate. better-auth construction is non-trivial
// (kysely + dialect detection + plugin wiring); initializing once per cold
// start is plenty for our traffic.
let _auth = null;
function authFor(env) {
  if (!_auth) _auth = getAuth(env);
  return _auth;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    // Phase A — auth + stats
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

    // Phase 6 — private multiplayer rooms
    if (request.method === "POST" && pathname === "/api/rooms") {
      const roomId = generateRoomId();
      return Response.json({ roomId });
    }
    const partyResponse = await routePartykitRequest(request, env);
    if (partyResponse) return partyResponse;

    // Static assets (HTML, CSS, JS, etc.)
    return env.ASSETS.fetch(request);
  },
};
