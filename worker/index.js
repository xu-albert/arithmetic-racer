// Worker entry. Routes /api/* to handlers; falls through to static assets.
//
// Foundation phase: stub routes return mock data shaped per
// worker/api-contracts.js so frontend agents can develop against a live
// dev server without any backend agent finishing first.
//
// Integration phase replaces the stubs with real handlers (see
// worker/routes/*.js) and mounts /api/auth/* on better-auth's handler.

const STUB_ME = {
  username: "BraveOtter",
  email: "demo@example.com",
  created_at: "2026-01-01T00:00:00.000Z",
  aggregates: [
    { difficulty: "easy",   races_played: 4, races_finished: 4, best_time_ms: 23400, avg_accuracy: 98, avg_problem_time_ms: 1100 },
    { difficulty: "medium", races_played: 2, races_finished: 2, best_time_ms: 48100, avg_accuracy: 91, avg_problem_time_ms: 2400 },
    { difficulty: "hard",   races_played: 1, races_finished: 1, best_time_ms: 72000, avg_accuracy: 84, avg_problem_time_ms: 3600 },
  ],
  recent: [
    { race_seq: 7, difficulty: "hard",   finish_time_ms: 72000, accuracy_pct: 84, avg_time_per_problem_ms: 3600, played_at: "2026-05-06T19:00:00.000Z" },
    { race_seq: 6, difficulty: "medium", finish_time_ms: 48100, accuracy_pct: 91, avg_time_per_problem_ms: 2400, played_at: "2026-05-06T18:30:00.000Z" },
    { race_seq: 5, difficulty: "easy",   finish_time_ms: 23400, accuracy_pct: 98, avg_time_per_problem_ms: 1100, played_at: "2026-05-06T18:00:00.000Z" },
  ],
};

const STUB_BY_DEVICE = { total_races: 0, best_time_ms: null, best_difficulty: null };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const { pathname } = url;

    if (pathname === "/api/race-result" && request.method === "POST") {
      return Response.json({ id: crypto.randomUUID(), claimed: false });
    }
    if (pathname === "/api/me" && request.method === "GET") {
      return Response.json(STUB_ME);
    }
    if (pathname === "/api/me/username" && request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      return Response.json({ username: body.username ?? "BraveOtter" });
    }
    if (pathname.startsWith("/api/stats/by-device/") && request.method === "GET") {
      return Response.json(STUB_BY_DEVICE);
    }
    if (pathname.startsWith("/api/auth/")) {
      // Wired to better-auth in Phase 3 (Integration). Until then, 501.
      return new Response("auth not yet wired", { status: 501 });
    }

    // Fall through to static assets.
    return env.ASSETS.fetch(request);
  },
};
