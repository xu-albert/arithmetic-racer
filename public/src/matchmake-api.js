// Client-side wrapper for POST /api/matchmake/join.
// Returns { roomId, difficulty, mode } on success, or throws Error on failure.

export async function joinMatchmaking({ difficulty, deviceId }) {
  const res = await fetch('/api/matchmake/join', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ difficulty, device_id: deviceId }),
  });
  if (res.status === 429) {
    throw Object.assign(new Error('Slow down — too many queue attempts'), { code: 'rate_limited' });
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { code: body.error });
  }
  return res.json();
}
