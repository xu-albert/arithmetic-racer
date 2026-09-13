import { ADJECTIVES, ANIMALS } from '../public/src/handles.js';

export function generateRoomId(rng = Math.random) {
  const adj = ADJECTIVES[Math.floor(rng() * ADJECTIVES.length)].toLowerCase();
  const a1 = ANIMALS[Math.floor(rng() * ANIMALS.length)].toLowerCase();
  let a2 = ANIMALS[Math.floor(rng() * ANIMALS.length)].toLowerCase();
  for (let i = 0; i < 10 && a2 === a1; i++) {
    a2 = ANIMALS[Math.floor(rng() * ANIMALS.length)].toLowerCase();
  }
  return `${adj}-${a1}-${a2}`;
}

// How many names a single creation is allowed to draw. The namespace is 13,248
// names (24 adjectives × 24 × 23 ordered distinct animal pairs), so one draw
// lands on a live room with probability live/13248 — under 1% even at 100 live
// rooms, but nowhere near negligible across many creations: the chance that
// *some* pair among 50 allocated names collides is already ~8.8%, and ~31.2%
// at 100. Retrying independently makes exhaustion that per-draw probability to
// the eighth power, which is vanishing long before the namespace is anywhere
// near full, while bounding the Durable Object round-trips one request can
// cost. The bound matters more than its exact value: a namespace crowded
// enough to exhaust eight draws needs a bigger word list, not more retries.
export const ROOM_ID_ATTEMPTS = 8;

/**
 * Draw a room id nobody is using and reserve it, retrying on collision.
 *
 * Returns the reserved id, or null if every attempt was taken or errored. Null
 * has to become a visible failure at the route: handing back the last drawn
 * name would be handing back somebody else's live lobby, which is the bug this
 * exists to prevent.
 *
 * `reserveRoomName()` is what makes an attempt atomic rather than advisory —
 * see its comment in server/room.js. A throwing attempt counts as taken: the
 * reservation is unproven, so the name cannot be handed out either way.
 */
export async function allocateRoomId(env, { attempts = ROOM_ID_ATTEMPTS, generate = generateRoomId, onError } = {}) {
  for (let i = 0; i < attempts; i++) {
    const roomId = generate();
    try {
      if (await env.RaceRoom.get(env.RaceRoom.idFromName(roomId)).reserveRoomName()) return roomId;
    } catch (e) {
      onError?.(e, roomId);
    }
  }
  return null;
}
