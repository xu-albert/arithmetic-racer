import { Server } from 'partyserver';
import { generateHandle } from '../public/src/handles.js';
import { generateSequence, validateAnswer, DIFFICULTIES } from '../public/src/game.js';
import { insertRaceResult } from '../worker/race-result-store.js';
import { buildRaceResultPayload } from './room-stats.js';

// Mirrors public/src/runner.js values; private rooms use 20 by default.
export const COUNTDOWN_SECONDS = 3;
export const IDLE_CLEANUP_MS = 5 * 60 * 1000;
export const RECONNECT_GRACE_MS = 30 * 1000;
export const ROOM_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const MAX_HANDLE_LEN = 24;
export const MIN_RACE_LENGTH = 5;
export const MAX_RACE_LENGTH = 50;

export function freshState(id) {
  return {
    id,
    createdAt: Date.now(),
    difficulty: 'medium',
    raceLength: 10,
    state: 'lobby',
    players: [],
    problemSequence: [],
    raceStartedAt: null,
    graceDeadline: null,
    countdownN: null,
    countdownAt: null,
    idleCleanupAt: null,
    disconnectDeadlines: {}, // playerId -> deadline ms (Task 9 reconnection grace)
  };
}

export function resetForRace(state) {
  for (const p of state.players) {
    p.score = 0;
    p.attempts = 0;
    p.longestStreak = 0;
    p.currentStreak = 0;
    p.finishMs = null;
    p.dropped = false;
    p.dnf = false;
  }
  state.problemSequence = [];
  state.raceStartedAt = null;
  state.graceDeadline = null;
  state.countdownN = null;
  state.countdownAt = null;
}

function isValidDeviceId(s) {
  return typeof s === 'string' && s.length > 0 && s.length <= 128;
}

export function isValidHandle(s) {
  if (typeof s !== 'string') return false;
  const t = s.trim();
  if (t.length === 0 || t.length > MAX_HANDLE_LEN) return false;
  // Reject control chars (incl. tab, newline) — keep punctuation/emoji.
  if (/[\x00-\x1f\x7f]/.test(t)) return false;
  return true;
}

function publicPlayer(p) {
  // Strip server-only bookkeeping (attempts/streak counters, identity)
  // before broadcasting to WS clients. Clients don't render these.
  const { attempts, longestStreak, currentStreak, deviceId, userId, ...rest } = p;
  return rest;
}

// Tier 1 finished ASC by finishMs; tier 2 still-racing DESC by score; tier 3 dropped/dnf.
export function rankPlayers(players) {
  const tier = (r) => (r.dropped || r.dnf ? 3 : r.finishMs != null ? 1 : 2);
  return [...players].sort((a, b) => {
    const ta = tier(a);
    const tb = tier(b);
    if (ta !== tb) return ta - tb;
    if (ta === 1) return a.finishMs - b.finishMs;
    if (ta === 2) return b.score - a.score;
    return 0;
  });
}

export class RaceRoom extends Server {
  static options = { hibernate: true };

  state = null;

  async onStart() {
    const stored = await this.ctx.storage.get('state');
    this.state = stored ?? freshState(this.name);
    if (!stored) await this.persist();
  }

  async onConnect(connection, ctx) {
    // Capture user_id from the upgrade-request header set by the Worker
    // entry. Client-supplied values are stripped/overwritten there, so this
    // is trustworthy. Null for anon users.
    const userId = ctx?.request?.headers?.get('x-arithmetic-user-id') ?? null;
    connection.setState({ ...(connection.state ?? {}), userId });

    // Don't add player yet — wait for `hello`.
    connection.send(JSON.stringify({ type: 'state', state: this.publicState(), youAre: null }));
  }

  async onMessage(connection, raw) {
    let msg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;

    try {
      switch (msg.type) {
        case 'hello': return await this.handleHello(connection, msg);
        case 'set-handle': return await this.handleSetHandle(connection, msg);
        case 'set-config': return await this.handleSetConfig(connection, msg);
        case 'start-race': return await this.handleStartRace(connection);
        case 'answer': return await this.handleAnswer(connection, msg);
        case 'quit': return await this.handleQuit(connection);
        case 'rematch': return await this.handleRematch(connection);
      }
    } catch (e) {
      console.error('onMessage error', msg.type, e);
    }
  }

  async onClose(connection) {
    const playerId = connection.state?.playerId;
    if (!playerId) return;
    const player = this.state.players.find((p) => p.id === playerId);
    if (!player) return;

    // Schedule a 30s reconnection grace (Task 9). If a fresh hello with the same
    // playerId arrives within the window, the disconnect is cancelled.
    const deadline = Date.now() + RECONNECT_GRACE_MS;
    this.state.disconnectDeadlines[playerId] = deadline;
    await this.persist();
    await this.scheduleNextAlarm();
  }

  async onAlarm() {
    const now = Date.now();
    let mutated = false;

    // Reconnection-grace expirations.
    for (const [pid, dl] of Object.entries(this.state.disconnectDeadlines)) {
      if (dl <= now) {
        delete this.state.disconnectDeadlines[pid];
        if (await this.removePlayer(pid)) mutated = true;
      }
    }

    // Countdown tick.
    if (this.state.countdownAt != null && this.state.countdownAt <= now && this.state.state === 'countdown') {
      const n = this.state.countdownN;
      this.broadcast(JSON.stringify({ type: 'countdown', n }));
      if (n > 0) {
        this.state.countdownN = n - 1;
        this.state.countdownAt = now + 1000;
      } else {
        // n === 0 was the GO frame; transition to racing now.
        this.state.countdownN = null;
        this.state.countdownAt = null;
        this.state.state = 'racing';
        this.state.raceStartedAt = now;
        this.broadcast(JSON.stringify({
          type: 'race-start',
          sequence: this.state.problemSequence,
          raceStartedAt: now,
        }));
      }
      mutated = true;
    }

    // Grace deadline removed — each player finishes at their own pace.

    // Idle cleanup.
    if (this.state.idleCleanupAt != null && this.state.idleCleanupAt <= now && this.state.players.length === 0) {
      await this.ctx.storage.delete('state');
      this.state = freshState(this.name);
      // Don't broadcast; nobody's listening.
      return;
    }

    // Hard ceiling: 24h.
    if (now - this.state.createdAt > ROOM_MAX_AGE_MS && this.state.players.length === 0) {
      await this.ctx.storage.delete('state');
      this.state = freshState(this.name);
      return;
    }

    if (mutated) {
      await this.persist();
      this.broadcastState();
    }
    await this.scheduleNextAlarm();
  }

  // ---------- handlers ----------

  async handleHello(connection, msg) {
    if (typeof msg.playerId !== 'string' || !UUID_V4_RE.test(msg.playerId)) {
      return this.sendError(connection, 'INVALID_INPUT', 'Bad playerId');
    }
    const playerId = msg.playerId;
    const existing = this.state.players.find((p) => p.id === playerId);

    if (existing) {
      // Reconnect — preserve all per-race fields.
      delete this.state.disconnectDeadlines[playerId];
      const currentConnState = connection.state ?? {};
      connection.setState({ ...currentConnState, playerId });
      // Refresh identity from this connection (cookie may have changed).
      if (isValidDeviceId(msg.deviceId)) existing.deviceId = msg.deviceId;
      existing.userId = currentConnState.userId ?? null;
      // Optionally update handle if client sent a non-null one.
      if (typeof msg.handle === 'string' && isValidHandle(msg.handle)) {
        existing.handle = msg.handle.trim();
      }
      connection.send(JSON.stringify({
        type: 'hello-ack', playerId, handle: existing.handle,
      }));
      await this.persist();
      this.broadcastState();
      await this.scheduleNextAlarm();
      return;
    }

    // New player — only allowed in lobby or finished (not mid-race).
    if (this.state.state === 'countdown' || this.state.state === 'racing') {
      return this.sendError(connection, 'BAD_STATE', 'Race already in progress');
    }

    const taken = new Set(this.state.players.map((p) => p.handle));
    let handle;
    if (typeof msg.handle === 'string' && isValidHandle(msg.handle) && !taken.has(msg.handle.trim())) {
      handle = msg.handle.trim();
    } else {
      handle = generateHandle(Math.random, taken);
    }

    const isCreator = this.state.players.length === 0;
    const currentConnState = connection.state ?? {};
    const player = {
      id: playerId,
      handle,
      isCreator,
      joinedAt: Date.now(),
      score: 0,
      attempts: 0,
      longestStreak: 0,
      currentStreak: 0,
      finishMs: null,
      dropped: false,
      dnf: false,
      deviceId: isValidDeviceId(msg.deviceId) ? msg.deviceId : null,
      userId: currentConnState.userId ?? null,
    };
    this.state.players.push(player);
    this.state.idleCleanupAt = null;

    connection.setState({ ...currentConnState, playerId });
    connection.send(JSON.stringify({ type: 'hello-ack', playerId, handle }));
    this.broadcast(JSON.stringify({ type: 'player-joined', player: publicPlayer(player) }));
    await this.persist();
    this.broadcastState();
    await this.scheduleNextAlarm();
  }

  async handleSetHandle(connection, msg) {
    const player = this.playerFor(connection);
    if (!player) return this.sendError(connection, 'BAD_STATE', 'No player; send hello first');
    if (!isValidHandle(msg.handle)) {
      return this.sendError(connection, 'INVALID_INPUT', 'Handle must be 1–24 chars, no control chars');
    }
    const trimmed = msg.handle.trim();
    if (this.state.players.some((p) => p.id !== player.id && p.handle === trimmed)) {
      return this.sendError(connection, 'INVALID_INPUT', 'Handle already taken');
    }
    player.handle = trimmed;
    this.broadcast(JSON.stringify({ type: 'handle-changed', playerId: player.id, handle: trimmed }));
    await this.persist();
    this.broadcastState();
  }

  async handleSetConfig(connection, msg) {
    const player = this.playerFor(connection);
    if (!player) return this.sendError(connection, 'BAD_STATE', 'No player; send hello first');
    if (!player.isCreator) return this.sendError(connection, 'NOT_CREATOR', 'Only the host can change config');
    if (this.state.state !== 'lobby') return this.sendError(connection, 'BAD_STATE', 'Config can only change in lobby');

    if (!DIFFICULTIES.includes(msg.difficulty)) {
      return this.sendError(connection, 'INVALID_INPUT', 'Invalid difficulty');
    }
    const len = Number(msg.raceLength);
    if (!Number.isInteger(len) || len < MIN_RACE_LENGTH || len > MAX_RACE_LENGTH) {
      return this.sendError(connection, 'INVALID_INPUT', `raceLength must be int in [${MIN_RACE_LENGTH}, ${MAX_RACE_LENGTH}]`);
    }
    this.state.difficulty = msg.difficulty;
    this.state.raceLength = len;
    this.broadcast(JSON.stringify({ type: 'config-changed', difficulty: msg.difficulty, raceLength: len }));
    await this.persist();
    this.broadcastState();
  }

  async handleStartRace(connection) {
    const player = this.playerFor(connection);
    if (!player) return this.sendError(connection, 'BAD_STATE', 'No player; send hello first');
    if (!player.isCreator) return this.sendError(connection, 'NOT_CREATOR', 'Only the host can start the race');
    if (this.state.state !== 'lobby') return this.sendError(connection, 'BAD_STATE', 'Already started');
    const active = this.state.players.filter((p) => !this.state.disconnectDeadlines[p.id]);
    if (active.length < 2) return this.sendError(connection, 'NEED_MORE_PLAYERS', 'Need at least 2 players to start');

    resetForRace(this.state);
    const seed = (Date.now() & 0xffffffff) >>> 0;
    this.state.problemSequence = generateSequence(this.state.difficulty, this.state.raceLength, seed);
    this.state.state = 'countdown';
    this.state.countdownN = COUNTDOWN_SECONDS;
    this.state.countdownAt = Date.now(); // fire first tick immediately
    await this.persist();
    this.broadcastState();
    await this.scheduleNextAlarm();
  }

  async handleAnswer(connection, msg) {
    const player = this.playerFor(connection);
    if (!player) return;
    if (this.state.state !== 'racing') return;
    if (player.dropped || player.score >= this.state.raceLength) return;

    const problem = this.state.problemSequence[player.score];
    if (!problem) return;

    if (validateAnswer(problem, msg.value)) {
      player.score += 1;
      player.attempts += 1;
      player.currentStreak += 1;
      if (player.currentStreak > player.longestStreak) {
        player.longestStreak = player.currentStreak;
      }
      if (player.score >= this.state.raceLength) {
        player.finishMs = Date.now() - this.state.raceStartedAt;
      }
      this.broadcast(JSON.stringify({
        type: 'advance', playerId: player.id, score: player.score, finishMs: player.finishMs,
      }));

      // Race ends only when every non-dropped player has finished. Stragglers
      // get to finish at their own pace; AFK risk accepted by design.
      const allDone = this.isRaceComplete();
      if (allDone) {
        await this.finishRace();
        await this.persist();
        this.broadcastState();
        await this.scheduleNextAlarm();
        return;
      }
      // During active racing we skip the routine state broadcast — granular
      // events drive the UI and the full snapshot was the main animation
      // stutter source. Persist still runs so reconnects see latest score.
      await this.persist();
    } else {
      player.attempts += 1;
      player.currentStreak = 0;
      this.broadcast(JSON.stringify({ type: 'wrong', playerId: player.id }));
    }
  }

  async handleQuit(connection) {
    const player = this.playerFor(connection);
    if (!player) return;

    if (this.state.state === 'racing') {
      player.dropped = true;
      this.broadcast(JSON.stringify({ type: 'drop', playerId: player.id }));
      const allDone = this.isRaceComplete();
      if (allDone) {
        await this.finishRace();
        await this.persist();
        this.broadcastState();
        await this.scheduleNextAlarm();
        return;
      }
      // No state broadcast during active racing — drop event is enough.
      await this.persist();
      return;
    }

    // In lobby/countdown/finished: remove the player outright.
    delete this.state.disconnectDeadlines[player.id];
    await this.removePlayer(player.id);
    await this.persist();
    this.broadcastState();
    await this.scheduleNextAlarm();
  }

  async handleRematch(connection) {
    const player = this.playerFor(connection);
    if (!player) return this.sendError(connection, 'BAD_STATE', 'No player; send hello first');
    if (!player.isCreator) return this.sendError(connection, 'NOT_CREATOR', 'Only the host can rematch');
    if (this.state.state !== 'finished') return this.sendError(connection, 'BAD_STATE', 'Race not finished');

    resetForRace(this.state);
    this.state.state = 'lobby';
    await this.persist();
    this.broadcastState();
    await this.scheduleNextAlarm();
  }

  // ---------- helpers ----------

  async finishRace() {
    if (this.state.state === 'finished') return;
    for (const p of this.state.players) {
      if (!p.dropped && p.finishMs == null) p.dnf = true;
    }
    this.state.state = 'finished';
    this.state.graceDeadline = null;
    const rankings = rankPlayers(this.state.players);
    this.broadcast(JSON.stringify({ type: 'finish', rankings: rankings.map(publicPlayer) }));

    await this.persistRaceResults();
  }

  async persistRaceResults() {
    for (const p of this.state.players) {
      if (!p.deviceId) {
        // Defensive: shouldn't happen since the client always sends deviceId
        // in `hello`, but skip rather than violate the NOT NULL constraint.
        console.error('persistRaceResults: skipping player with no deviceId', { playerId: p.id });
        continue;
      }
      try {
        await insertRaceResult(this.env, buildRaceResultPayload(p, this.state));
      } catch (e) {
        console.error('persistRaceResults: insert failed', { playerId: p.id, error: String(e) });
      }
    }
  }

  async removePlayer(playerId) {
    const idx = this.state.players.findIndex((p) => p.id === playerId);
    if (idx < 0) return false;
    const player = this.state.players[idx];
    delete this.state.disconnectDeadlines[playerId];

    // Mid-race: keep the player in state.players so finishRace persists their
    // DNF row. Mark dropped (idempotent) and re-check allDone. Cleanup happens
    // naturally when the room is destroyed or a rematch resets per-race fields.
    if (this.state.state === 'racing') {
      if (!player.dropped) {
        player.dropped = true;
        this.broadcast(JSON.stringify({ type: 'drop', playerId }));
      }
      const allDone = this.isRaceComplete();
      if (allDone) await this.finishRace();
      return true;
    }

    // Non-racing (lobby / countdown / finished): actually remove.
    const wasCreator = player.isCreator;
    this.state.players.splice(idx, 1);

    // Promote next-joined player if creator left.
    if (wasCreator && this.state.players.length > 0) {
      this.state.players.sort((a, b) => a.joinedAt - b.joinedAt);
      this.state.players[0].isCreator = true;
    }

    this.broadcast(JSON.stringify({ type: 'player-left', playerId }));

    if (this.state.players.length === 0) {
      this.state.idleCleanupAt = Date.now() + IDLE_CLEANUP_MS;
    }
    return true;
  }

  playerFor(connection) {
    const pid = connection.state?.playerId;
    if (!pid) return null;
    return this.state.players.find((p) => p.id === pid) ?? null;
  }

  /**
   * Hook: returns true when the race should be ended. Default implementation
   * counts every player. PublicRaceRoom overrides this to ignore bots.
   */
  isRaceComplete() {
    return this.state.players.every((p) => p.dropped || p.score >= this.state.raceLength);
  }

  publicState() {
    // Strip server-only Player fields (attempts/streak counters, identity).
    return { ...this.state, players: this.state.players.map(publicPlayer) };
  }

  broadcastState() {
    // Each connection gets its own youAre, so we can't use this.broadcast.
    for (const c of this.getConnections()) {
      const youAre = c.state?.playerId ?? null;
      c.send(JSON.stringify({ type: 'state', state: this.publicState(), youAre }));
    }
  }

  sendError(connection, code, message) {
    connection.send(JSON.stringify({ type: 'error', code, message }));
  }

  async persist() {
    await this.ctx.storage.put('state', this.state);
  }

  async scheduleNextAlarm() {
    const candidates = [];
    if (this.state.countdownAt != null) candidates.push(this.state.countdownAt);
    if (this.state.idleCleanupAt != null) candidates.push(this.state.idleCleanupAt);
    for (const dl of Object.values(this.state.disconnectDeadlines)) candidates.push(dl);

    if (candidates.length === 0) {
      const cur = await this.ctx.storage.getAlarm();
      if (cur != null) await this.ctx.storage.deleteAlarm();
      return;
    }
    const next = Math.min(...candidates);
    const cur = await this.ctx.storage.getAlarm();
    if (cur !== next) await this.ctx.storage.setAlarm(next);
  }
}
