import { test, expect, vi } from 'vitest';
import { env, runInDurableObject } from 'cloudflare:test';
import { generateSequence } from '../public/src/game.js';

async function withRacingRoom(binding, fn) {
  const stub = binding.get(binding.idFromName('m-attempts-' + crypto.randomUUID()));
  await runInDurableObject(stub, async (room, ctx) => {
    if (!room.state) await room.onStart();
    room.broadcast = () => {};
    const racerId = crypto.randomUUID();
    const conn = { id: 'socket', state: { playerId: 'p-1', racerId } };
    Object.assign(room.state, {
      state: 'racing', difficulty: 'medium', raceLength: 10,
      raceStartedAt: Date.now(), lastActivityAt: Date.now() - 1000,
      problemSequence: generateSequence('medium', 10, 123),
      players: [{
        id: 'p-1', racerId, connId: conn.id, isBot: false,
        score: 2, attempts: 2, currentStreak: 2, longestStreak: 2,
        finishMs: null, dropped: false,
      }],
    });
    await room.persist();
    const put = vi.spyOn(ctx.storage, 'put');
    try {
      await fn(room, conn, ctx.storage, put);
    } finally {
      put.mockRestore();
      await ctx.storage.deleteAlarm();
    }
  });
}

// This proves the durable write in the Workers pool, not an actual eviction.
// Read storage independently: inspecting room.state alone misses this bug.
for (const name of ['PublicRaceRoom', 'RaceRoom']) {
  test(`${name}: a wrong answer durably records the attempt and broken streak`, async () => {
    await withRacingRoom(env[name], async (room, conn, storage, put) => {
      await room.onMessage(conn, JSON.stringify({ type: 'answer', value: 'wrong' }));
      const stored = await storage.get('state');
      expect(stored.players[0]).toMatchObject({
        score: 2, attempts: 3, currentStreak: 0, longestStreak: 2,
      });
      expect(put).toHaveBeenCalledTimes(1);
    });
  });

  test(`${name}: an active correct answer still persists exactly once`, async () => {
    await withRacingRoom(env[name], async (room, conn, storage, put) => {
      await room.onMessage(conn, JSON.stringify({
        type: 'answer', value: String(room.state.problemSequence[2].answer),
      }));
      expect(put).toHaveBeenCalledTimes(1);
      const stored = await storage.get('state');
      expect(stored.players[0]).toMatchObject({
        score: 3, attempts: 3, currentStreak: 3, longestStreak: 3,
      });
    });
  });
}
