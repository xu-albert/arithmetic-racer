// POST /api/matchmake/join handler.
//
// Flow:
//   1. Validate body { difficulty, device_id }.
//   2. Rate-limit per device_id via the MATCHMAKING_LIMIT binding (3 per 60s).
//   3. Ask the difficulty's LobbyRouter DO for the current open room.
//   4. Return { roomId, mode: 'public', difficulty }.
//
// There is deliberately no per-device "queue-lock". It used to cache the last
// roomId in KV and return it only when it equalled the router's fresh pick —
// which is the value returned anyway, so it changed no response and cost a KV
// read+write per join against the free daily quota.

import { allowRequest } from "../rate-limit.js";

const DIFFICULTIES = new Set(["easy", "medium", "hard"]);
// Native rate-limit binding periods are 10 or 60s only; must match wrangler.jsonc.
const RATE_LIMIT_WINDOW_S = 60;

export async function handleMatchmakeJoin(request, env) {
  let body;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid_body" }, { status: 400 });
  }

  if (!DIFFICULTIES.has(body?.difficulty)) {
    return Response.json({ error: "invalid_difficulty" }, { status: 400 });
  }
  if (typeof body?.device_id !== "string" || body.device_id.length === 0) {
    return Response.json({ error: "missing_device_id" }, { status: 400 });
  }
  const { difficulty, device_id } = body;

  // Fails open (allowRequest): a missing or broken limiter must not block play.
  if (!(await allowRequest(env.MATCHMAKING_LIMIT, `rl:${device_id}`, "MATCHMAKING_LIMIT"))) {
    return new Response(JSON.stringify({ error: "rate_limited" }), {
      status: 429,
      headers: { "content-type": "application/json", "retry-after": String(RATE_LIMIT_WINDOW_S) },
    });
  }

  let roomId;
  try {
    const stub = env.LobbyRouter.get(env.LobbyRouter.idFromName(difficulty));
    const result = await stub.pick(difficulty);
    roomId = result.roomId;
  } catch (e) {
    return Response.json({ error: "router_unavailable" }, { status: 503, headers: { "retry-after": "1" } });
  }

  return Response.json({ roomId, mode: "public", difficulty });
}
