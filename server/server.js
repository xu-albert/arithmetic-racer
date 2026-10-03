// Worker entry — merged after Phase A (users + auth + stats) joined Phase 6
// (private multiplayer rooms). Order:
//   1. Phase A routes — /api/auth/*, /api/race-result, /api/me*, /api/stats/*,
//      /api/leaderboard
//   2. Phase 6 routes — /api/rooms (create) + partykit WebSocket upgrade
//   3. Static assets fallback
//
// Auth routes are checked first so they always win path resolution. partykit
// then claims its own paths (typically /parties/*). Anything not handled
// falls through to env.ASSETS.

import { routePartykitRequest } from "partyserver";
import { handleRaceResult } from "../worker/routes/race-result.js";
import { handleGetMe, handleGetMyRaces, handlePostUsername, handleByDevice } from "../worker/routes/me.js";
import { getAuth } from "../worker/auth.js";
import { readUserId } from "../worker/session.js";
import { handleMatchmakeJoin } from "../worker/routes/matchmake.js";
import { handleAdminIndex, handleAdminUser, handleAdminContactHandled } from "../worker/routes/admin.js";
import { handleContact } from "../worker/routes/contact.js";
import { handleRecentFinishes } from "../worker/routes/recent-finishes.js";
import { handleLeaderboard } from "../worker/routes/leaderboard.js";
import { handleCreateRoom } from "../worker/routes/rooms.js";
import { checkAdmissionPass, ADMISSION_HEADER } from "./admission-pass.js";
import { refuseAdmission } from "./room.js";
import { INVITE_INVALID_REASON } from "../public/src/room-expiry.js";
import { allowRequest, clientIpBucket } from "../worker/rate-limit.js";

const USER_ID_HEADER = "x-arithmetic-user-id";
// Must match PARTIES_IP_LIMIT's period in wrangler.jsonc.
const PARTIES_RATE_LIMIT_WINDOW_S = 60;

// The pass mode each routable room class admits, keyed by the class name
// partyserver resolves a /parties/<party>/<name> path to. Anything else it can
// route to admits nobody.
const ADMISSION_MODES = { RaceRoom: "private", PublicRaceRoom: "public" };

// Checked against the name and class partyserver is about to route to. The
// verdict — 'fresh', 'stale', or 'none' for a missing or forged pass — goes on
// to the room, which alone knows what it admits: whether it is alive, and
// whether a hello's racerId already holds a seat (RaceRoom.fetch and
// handleHello). Set on every request, so no client value survives.
async function admit(request, lobby, env) {
  const mode = ADMISSION_MODES[lobby.className];
  if (!mode) return refuseAdmission(request, lobby.name, INVITE_INVALID_REASON);
  const pass = new URL(request.url).searchParams.get("admission");
  const verdict = await checkAdmissionPass(env, pass, { roomId: lobby.name, mode });
  request.headers.set(ADMISSION_HEADER, verdict ?? "none");
  return request;
}

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
    if (pathname === "/api/me/races" && request.method === "GET") {
      return handleGetMyRaces(request, env);
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
    // Public read-only boards — no session required; the response carries only
    // usernames people chose to publish by signing in. The only handler here
    // that takes `ctx`: it stores each board in the Workers cache, and the
    // put has to outlive the response.
    if (pathname === "/api/leaderboard" && request.method === "GET") {
      return handleLeaderboard(request, env, ctx);
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
    if (pathname.startsWith("/admin/contact/") && pathname.endsWith("/handled") && request.method === "POST") {
      return handleAdminContactHandled(request, env);
    }
    if (pathname.startsWith("/admin/users/") && request.method === "GET") {
      return handleAdminUser(request, env);
    }

    // Phase 6 — private multiplayer rooms
    if (request.method === "POST" && pathname === "/api/rooms") {
      return handleCreateRoom(request, env);
    }

    // Stamp the resolved user_id on race-room upgrades so the DO can
    // attribute race-result rows. Cookie-bound auth = unspoofable; we
    // unconditionally overwrite/delete any client-supplied header value.
    //
    // partyserver tolerates duplicate slashes, so /parties//race-room/<name>
    // routes to the same room DO as the canonical path. Matching the raw
    // pathname would let that form skip the gate and carry a forged header
    // through, so collapse repeated slashes before the prefix checks — every
    // path that can reach a room DO then passes the gate.
    let upgradeRequest = request;
    const normalizedPathname = pathname.replace(/\/{2,}/g, "/");
    // A coarse per-IP ceiling on everything that can reach a Durable Object,
    // ahead of the session lookup and the pass check below.
    if (normalizedPathname.startsWith("/parties/")) {
      if (!(await allowRequest(env.PARTIES_IP_LIMIT, clientIpBucket(request), "PARTIES_IP_LIMIT"))) {
        return Response.json({ error: "rate_limited" }, {
          status: 429,
          headers: { "retry-after": String(PARTIES_RATE_LIMIT_WINDOW_S) },
        });
      }
    }
    if (
      normalizedPathname.startsWith("/parties/race-room/")
      || normalizedPathname.startsWith("/parties/public-race-room/")
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
    const partyResponse = await routePartykitRequest(upgradeRequest, env, {
      onBeforeConnect: (req, lobby) => admit(req, lobby, env),
      onBeforeRequest: (req, lobby) => admit(req, lobby, env),
    });
    if (partyResponse) return partyResponse;

    // Static assets (HTML, CSS, JS, etc.)
    return env.ASSETS.fetch(request);
  },
};
