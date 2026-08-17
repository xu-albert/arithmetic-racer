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
import { readUserId } from "../worker/session.js";
import { handleMatchmakeJoin } from "../worker/routes/matchmake.js";
import { handleAdminIndex, handleAdminUser } from "../worker/routes/admin.js";
import { handleContact } from "../worker/routes/contact.js";
import { handleRecentFinishes } from "../worker/routes/recent-finishes.js";
import { logError, KINDS } from "../worker/logger.js";

const USER_ID_HEADER = "x-arithmetic-user-id";

export { RaceRoom } from "./room.js";
export { LobbyRouter } from "./lobby-router.js";
export { PublicRaceRoom } from "./public-room.js";

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
    // Public, unauthenticated: the lobby's recent-finishes strip.
    if (pathname === "/api/recent-finishes" && request.method === "GET") {
      return handleRecentFinishes(request, env);
    }

    if (pathname === "/api/contact" && request.method === "POST") {
      return handleContact(request, env);
    }

    // Matchmaking
    if (pathname === "/api/matchmake/join" && request.method === "POST") {
      return handleMatchmakeJoin(request, env);
    }

    // Admin dashboard (operator-only, token-gated)
    if (pathname === "/admin" || pathname === "/admin/") {
      return handleAdminIndex(request, env);
    }
    if (pathname.startsWith("/admin/users/") && request.method === "GET") {
      return handleAdminUser(request, env);
    }

    // Phase 6 — private multiplayer rooms
    if (request.method === "POST" && pathname === "/api/rooms") {
      const roomId = generateRoomId();
      // Creating a room is the one moment we know this name is being claimed
      // anew, so clear any expired-room tombstone sitting on it — otherwise
      // the creator opens their brand-new room onto the "room expired" screen.
      // Best-effort: a failure here costs a confusing screen, not the room.
      try {
        await env.RaceRoom.get(env.RaceRoom.idFromName(roomId)).claimRoomName();
      } catch (e) {
        logError(KINDS.ROOM_CLAIM_FAILED, e, { roomId });
      }
      return Response.json({ roomId });
    }

    // Stamp the resolved user_id on race-room upgrades so the DO can
    // attribute race-result rows. Cookie-bound auth = unspoofable; we
    // unconditionally overwrite/delete any client-supplied header value.
    let upgradeRequest = request;
    if (
      pathname.startsWith("/parties/race-room/")
      || pathname.startsWith("/parties/public-race-room/")
    ) {
      const userId = await readUserId(request, env);
      const headers = new Headers(request.headers);
      if (userId) headers.set(USER_ID_HEADER, userId);
      else headers.delete(USER_ID_HEADER);
      upgradeRequest = new Request(request.url, {
        method: request.method,
        headers,
        body: request.body,
        // WebSocket upgrades require these to flow through.
        cf: request.cf,
        redirect: request.redirect,
      });
    }
    const partyResponse = await routePartykitRequest(upgradeRequest, env);
    if (partyResponse) return partyResponse;

    // Static assets (HTML, CSS, JS, etc.)
    return env.ASSETS.fetch(request);
  },
};
