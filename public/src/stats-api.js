// Wrapper for /api/* endpoints. Shapes match worker/api-contracts.js.
// All requests use credentials: 'include' so the session cookie is sent
// with cross-route fetches.

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

export async function getStatsByDevice(deviceId) {
  const res = await fetch(`/api/stats/by-device/${encodeURIComponent(deviceId)}`);
  if (!res.ok) throw new Error(`by-device ${res.status}`);
  return res.json();
}
