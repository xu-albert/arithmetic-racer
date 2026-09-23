// Capability regression: ten simultaneous private-room seats over the real
// Worker route and PartyServer sockets, including D1 result persistence.
import { it, expect } from 'vitest';
import { env, SELF, runInDurableObject } from 'cloudflare:test';

async function connect(roomId) {
  const response = await SELF.fetch(`https://ten.test/parties/race-room/${roomId}`, {
    headers: { Upgrade: 'websocket' },
  });
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  const messages = [];
  socket.addEventListener('message', ({ data }) => { messages.push(JSON.parse(data)); });
  socket.accept();
  let cursor = 0;
  return {
    messages,
    send(message) { socket.send(JSON.stringify(message)); },
    close() { socket.close(); },
    async wait(predicate) {
      const deadline = Date.now() + 5000;
      while (Date.now() < deadline) {
        for (let i = cursor; i < messages.length; i++) {
          if (predicate(messages[i])) {
            cursor = i + 1;
            return messages[i];
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      throw new Error(`Missing message; received ${JSON.stringify(messages)}`);
    },
  };
}

it('ten private-room players join, race concurrently, receive all standings, and store ten results', async () => {
  const created = await SELF.fetch('https://ten.test/api/rooms', { method: 'POST' });
  expect(created.ok).toBe(true);
  const { roomId } = await created.json();
  const stub = env.RaceRoom.get(env.RaceRoom.idFromName(roomId));
  const clients = [];
  try {
    // Keep all ten sockets attached throughout. Seat one claims host before
    // the others say hello so the starter is deterministic.
    for (let i = 0; i < 10; i++) clients.push(await connect(roomId));
    async function hello(client, i) {
      client.deviceId = crypto.randomUUID();
      client.send({ type: 'hello', playerId: crypto.randomUUID(), deviceId: client.deviceId, handle: `Racer${i + 1}` });
      client.playerId = (await client.wait((m) => m.type === 'hello-ack')).playerId;
    }
    await hello(clients[0], 0);
    await Promise.all(clients.slice(1).map((client, i) => hello(client, i + 1)));
    const ids = clients.map((client) => client.playerId);
    expect(new Set(ids).size).toBe(10);
    for (const client of clients) {
      const lobby = await client.wait((m) => m.type === 'state' && m.state.players.length === 10);
      expect(lobby.state.state).toBe('lobby');
      expect(lobby.youAre).toBe(client.playerId);
      expect(lobby.state.players.map((p) => p.id).sort()).toEqual([...ids].sort());
    }

    clients[0].send({ type: 'start-race' });
    await Promise.all(clients.map((client) => client.wait((m) => m.type === 'state' && m.state.state === 'countdown')));
    // Exercise the actual countdown alarms without three seconds of wall time.
    await runInDurableObject(stub, async (room) => {
      for (let i = 0; i < 8 && room.state.state === 'countdown'; i++) {
        room.state.countdownAt = Date.now() - 1;
        await room.onAlarm();
      }
      expect(room.state.state).toBe('racing');
      // Wire answers are instantaneous; represent an ordinary human pace so
      // active verification does not take ownership of these result rows.
      room.state.raceStartedAt = Date.now() - 20_000;
    });
    const starts = await Promise.all(clients.map((client) => client.wait((m) => m.type === 'race-start')));
    const sequence = starts[0].sequence;
    expect(sequence).toHaveLength(10);
    for (const start of starts) expect(start.sequence).toEqual(sequence);

    const offsets = clients.map((client) => client.messages.length);
    // Nine rounds arrive concurrently from all ten clients. Each client waits
    // for its own acknowledgement, just as an ordinary sequential answer flow.
    for (let score = 1; score < sequence.length; score++) {
      await Promise.all(clients.map(async (client) => {
        client.send({ type: 'answer', value: String(sequence[score - 1].answer) });
        await client.wait((m) => m.type === 'advance' && m.playerId === client.playerId && m.score === score);
      }));
    }
    // Pin a distinct wrong-answer payload on the tenth seat as well.
    const tenth = clients[9];
    tenth.send({ type: 'answer', value: String(sequence[9].answer + 1) });
    await tenth.wait((m) => m.type === 'wrong' && m.playerId === tenth.playerId);
    // Finish in reverse join order to catch standings keyed by roster position.
    // All ten cross the line within milliseconds, so this is the prompt-finish
    // happy path only. Ten-seat straggler handling is untested: the grace the
    // first finisher arms is raceGraceMs() = 60s for ten problems and is never
    // extended, so a slow racer past it is DNF'd. Whether that window is right
    // with nine opponents rather than one is an open product decision.
    const finishOrder = [...clients].reverse();
    for (const [i, client] of finishOrder.entries()) {
      await runInDurableObject(stub, (room) => { room.state.raceStartedAt = Date.now() - 20_000 - i * 1000; });
      client.send({ type: 'answer', value: String(sequence[9].answer) });
      await client.wait((m) => m.type === 'advance' && m.playerId === client.playerId && m.score === 10);
    }
    for (const [i, client] of clients.entries()) {
      const finish = await client.wait((m) => m.type === 'finish');
      expect(finish.rankings.map((p) => p.id)).toEqual(finishOrder.map((c) => c.playerId));
      expect(finish.rankings.every((p) => p.score === 10 && p.finishMs > 0 && !p.dnf)).toBe(true);
      const snapshot = await client.wait((m) => m.type === 'state' && m.state.state === 'finished');
      expect(snapshot.state.players).toHaveLength(10);
      expect(client.messages.filter((m) => m.type === 'error' || m.type === 'captcha')).toEqual([]);
      const traffic = client.messages.slice(offsets[i]);
      expect(traffic.filter((m) => m.type === 'advance')).toHaveLength(100);
      // No full-roster snapshot per answer: only the terminal snapshot.
      expect(traffic.filter((m) => m.type === 'state')).toHaveLength(1);
    }

    // The finished state follows persistRaceResults, so no polling/sleep is
    // needed to observe the ten actual buildRaceResultPayload -> D1 inserts.
    const { results } = await env.DB.prepare('SELECT * FROM race_results WHERE room_id = ?').bind(roomId).all();
    expect(results).toHaveLength(10);
    for (const client of clients) {
      const row = results.find((r) => r.device_id === client.deviceId);
      expect(row).toMatchObject({ finished: 1, problems_total: 10, problems_correct: 10, problems_attempted: client === tenth ? 11 : 10, suspect: 0 });
      expect(row.finish_time_ms).toBeGreaterThanOrEqual(20_000);
      expect(row.accuracy_pct).toBeCloseTo(1000 / row.problems_attempted);
      expect(row.avg_time_per_problem_ms).toBe(Math.round(row.finish_time_ms / 10));
    }
  } finally {
    for (const client of clients) client.close();
  }
}, 20_000);

it('refuses an 11th new racer in lobby and finished states, but still accepts a seated reconnect', async () => {
  const created = await SELF.fetch('https://ten.test/api/rooms', { method: 'POST' });
  const { roomId } = await created.json();
  const stub = env.RaceRoom.get(env.RaceRoom.idFromName(roomId));
  const clients = [];
  const racerIds = [];
  try {
    for (let i = 0; i < 10; i++) {
      const c = await connect(roomId);
      clients.push(c);
      racerIds.push(crypto.randomUUID());
      c.send({ type: 'hello', playerId: racerIds[i], handle: `Racer${i + 1}` });
      await c.wait((m) => m.type === 'hello-ack');
    }
    const refuse = async () => {
      const extra = await connect(roomId);
      extra.send({ type: 'hello', playerId: crypto.randomUUID(), handle: 'Late' });
      const err = await extra.wait((m) => m.type === 'error');
      expect(err.code).toBe('ROOM_FULL');
      expect(extra.messages.some((m) => m.type === 'hello-ack')).toBe(false);
      extra.close();
    };
    await refuse();
    await runInDurableObject(stub, async (room) => {
      expect(room.state.players).toHaveLength(10);
      room.state.state = 'finished';
    });
    await refuse();

    const again = await connect(roomId);
    again.send({ type: 'hello', playerId: racerIds[3], handle: 'Racer4' });
    await again.wait((m) => m.type === 'hello-ack');
    await runInDurableObject(stub, async (room) => {
      expect(room.state.players).toHaveLength(10);
    });
    again.close();
  } finally {
    for (const c of clients) c.close();
  }
});
