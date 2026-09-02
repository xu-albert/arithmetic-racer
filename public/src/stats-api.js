// Wrapper for /api/* endpoints. Shapes match worker/api-contracts.js.
// Session-bearing requests use credentials: 'include' so the cookie is sent
// with cross-route fetches; the public boards omit it — see getLeaderboard.

export async function postRaceResult(input) {
  const res = await fetch("/api/race-result", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`race-result ${res.status}`);
  return res.json();
}

export async function getMe() {
  const res = await fetch("/api/me", { credentials: "include" });
  if (res.status === 401) return null;
  if (!res.ok) throw new Error(`me ${res.status}`);
  return res.json();
}

export async function setUsername(username) {
  const res = await fetch("/api/me/username", {
    method: "POST",
    headers: { "content-type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ username }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    const err = new Error(`username ${res.status}`);
    err.code = body.error;
    throw err;
  }
  return res.json();
}

/**
 * One leaderboard: the fastest races at one difficulty in one period.
 *
 * `credentials: 'omit'` — the boards are public and identical for everyone, so
 * the session cookie has nothing to say here and sending it would only make
 * them look personalized. Omitting the option would not do it: fetch defaults
 * to 'same-origin', and this is a same-origin request.
 *
 * @param {{difficulty: string, period?: string, limit?: number}} opts
 */
export async function getLeaderboard({ difficulty, period = "all", limit } = {}) {
  const params = new URLSearchParams({ difficulty, period });
  if (limit != null) params.set("limit", String(limit));
  const res = await fetch(`/api/leaderboard?${params}`, { credentials: "omit" });
  if (!res.ok) throw new Error(`leaderboard ${res.status}`);
  return res.json();
}

export async function getStatsByDevice(deviceId) {
  const res = await fetch(`/api/stats/by-device/${encodeURIComponent(deviceId)}`);
  if (!res.ok) throw new Error(`by-device ${res.status}`);
  return res.json();
}
