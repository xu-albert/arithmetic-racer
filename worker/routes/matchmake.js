// POST /api/matchmake/join handler.
//
// Flow:
//   1. Validate body { difficulty, device_id }.
//   2. Rate-limit per device_id via KV (3 calls per 10s window).
//   3. Check KV queue-lock for this device; if set, return cached roomId.
//   4. Call LobbyRouter.pick() for the difficulty's router DO.
//   5. Set KV queue-lock with 60s TTL.
//   6. Return { roomId, mode: 'public', difficulty }.

const DIFFICULTIES = new Set(["easy", "medium", "hard"]);
const RATE_LIMIT_MAX = 3;
const RATE_LIMIT_WINDOW_S = 10;
const QUEUE_LOCK_TTL_S = 60;

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

  // Rate limit
  const rlKey = `rl:${device_id}`;
  try {
    const count = parseInt((await env.MATCHMAKING_LIMITS.get(rlKey)) || "0", 10);
    if (count >= RATE_LIMIT_MAX) {
      return new Response(JSON.stringify({ error: "rate_limited" }), {
        status: 429,
        headers: { "content-type": "application/json", "retry-after": String(RATE_LIMIT_WINDOW_S) },
      });
    }
    await env.MATCHMAKING_LIMITS.put(rlKey, String(count + 1), { expirationTtl: RATE_LIMIT_WINDOW_S });
  } catch (e) {
    console.warn("rate-limit KV op failed; proceeding", e);
  }

  // Queue-lock
  const lockKey = `queue-lock:${device_id}`;
  try {
    const cached = await env.MATCHMAKING_LIMITS.get(lockKey);
    if (cached) {
      return Response.json({ roomId: cached, mode: "public", difficulty });
    }
  } catch (e) {
    console.warn("queue-lock get failed; proceeding", e);
  }

  // Router pick
  let roomId;
  try {
    const stub = env.LobbyRouter.get(env.LobbyRouter.idFromName(difficulty));
    const result = await stub.pick();
    roomId = result.roomId;
  } catch (e) {
    return Response.json({ error: "router_unavailable" }, { status: 503, headers: { "retry-after": "1" } });
  }

  // Set queue-lock (best-effort)
  try {
    await env.MATCHMAKING_LIMITS.put(lockKey, roomId, { expirationTtl: QUEUE_LOCK_TTL_S });
  } catch (e) {
    console.warn("queue-lock put failed", e);
  }

  return Response.json({ roomId, mode: "public", difficulty });
}
