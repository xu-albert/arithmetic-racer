import { Server } from 'partyserver';
import { generateHandle } from '../public/src/handles.js';
import { generateSequence, validateAnswer, DIFFICULTIES } from '../public/src/game.js';
import { isConfigurableState } from '../public/src/room-config-rules.js';
import { EXPIRED_ROOM_STATE, ROOM_EXPIRED_TYPE } from '../public/src/room-expiry.js';
import { insertRaceResult } from '../worker/race-result-store.js';
import { containsProfanity } from '../worker/username-validator.js';
import { logError, KINDS } from '../worker/logger.js';
import { buildRaceResultPayload } from './room-stats.js';
import { createSocketLimiter } from './socket-limit.js';

// Mirrors public/src/runner.js values. The default race length is not here —
// it is `raceLength` in freshState() below, which the leaderboards filter on.
export const COUNTDOWN_SECONDS = 3;
export const IDLE_CLEANUP_MS = 5 * 60 * 1000;
export const RECONNECT_GRACE_MS = 30 * 1000;
export const ROOM_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// A private room that sees no activity for this long winds down: its state is
// replaced by a tombstone, its alarm is cleared, and everyone still attached is
// sent to the "room expired" screen. "Activity" is any client touching the
// room — a socket connecting or closing, or any recognized room message — so
// both an empty room and a room full of AFK tabs qualify. Race *ticks* are not
// activity; a race nobody is answering is idle by this definition.
export const PRIVATE_ROOM_IDLE_MS = 30 * 60 * 1000;

// How long the tombstone answers for the room name before it is reusable.
// Room ids come from a 13k-combination word list, so holding one forever
// would eventually stamp "expired" on a brand-new room; a day is long enough
// that a stale invite link explains itself.
export const EXPIRED_ROOM_TTL_MS = 24 * 60 * 60 * 1000;

// How far a deadline may drift later than the alarm already on disk before
// scheduleNextAlarm() pays for a rewrite, in rooms that expire when idle. The
// idle clock moves on every client frame, so without this an answer costs a
// durable setAlarm — on the hottest path of a feature whose point is
// conserving resources. Firing early is harmless: onAlarm re-derives
// idleExpiryAt() and falls through to reschedule when the deadline has not
// been reached yet. An *earlier* deadline is never skipped; missing one of
// those would drop a real timer.
export const ALARM_SLOP_MS = 60 * 1000;

// Public wire payload for a wound-down room. Sent to anyone attached when the
// winddown happens, and to anyone who connects to the tombstone afterwards.
export function expiredMessage(roomId) {
  return JSON.stringify({ type: ROOM_EXPIRED_TYPE, reason: 'idle', roomId });
}

// The room's whole client protocol: dispatch table and activity gate at once,
// so a handler can never be wired up as one without being the other. Called
// with the room rather than bound at module load, so subclass overrides win.
const MESSAGE_HANDLERS = new Map([
  ['hello', (room, conn, msg) => room.handleHello(conn, msg)],
  ['set-handle', (room, conn, msg) => room.handleSetHandle(conn, msg)],
  ['set-config', (room, conn, msg) => room.handleSetConfig(conn, msg)],
  ['start-race', (room, conn) => room.handleStartRace(conn)],
  ['answer', (room, conn, msg) => room.handleAnswer(conn, msg)],
  ['quit', (room, conn) => room.handleQuit(conn)],
  ['rematch', (room, conn) => room.handleRematch(conn)],
]);

function closeQuietly(connection, reason) {
  // The socket may already be gone (hibernated peer, half-open close); a throw
  // here would abort the winddown for every other connection.
  try {
    connection.close(1000, reason);
  } catch {
    /* already closed */
  }
}

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
    // raceLength of the most recently finished race. The live `raceLength` can
    // move while results are still on screen (the host may reconfigure between
    // races), so the finished scoreboard reads its denominator from here.
    lastRaceLength: null,
    players: [],
    problemSequence: [],
    raceStartedAt: null,
    graceDeadline: null,
    countdownN: null,
    countdownAt: null,
    idleCleanupAt: null,
    // Drives the private-room idle winddown. Bumped by touchActivity(); see
    // PRIVATE_ROOM_IDLE_MS for what counts as activity.
    lastActivityAt: Date.now(),
    // Counter behind the ephemeral broadcast ids handed out by nextBroadcastId.
    nextPid: 1,
    disconnectDeadlines: {}, // broadcast id -> deadline ms (Task 9 reconnection grace)
  };
}

/**
 * Mint the next ephemeral, per-room broadcast id.
 *
 * This — not the client's racerId — is what every other client sees and keys
 * off. It is deliberately not a UUID: UUID_V4_RE gates `hello`, so a broadcast
 * id can never be replayed back as a reconnect secret. Monotone, so an id is
 * never reused by a later player in the same room.
 */
export function nextBroadcastId(state) {
  const n = state.nextPid ?? 1;
  state.nextPid = n + 1;
  return `p-${n}`;
}

/**
 * Re-key players persisted before the broadcast-id split, where player.id WAS
 * the racerId and therefore rode along in every state push. Returns true if
 * anything changed (the caller then persists).
 */
export function adoptBroadcastIds(state) {
  let changed = false;
  for (const p of state.players ?? []) {
    if (p.isBot || p.racerId) continue;
    const oldId = p.id;
    p.racerId = oldId;
    p.id = nextBroadcastId(state);
    const deadline = state.disconnectDeadlines?.[oldId];
    if (deadline != null) {
      state.disconnectDeadlines[p.id] = deadline;
      delete state.disconnectDeadlines[oldId];
    }
    changed = true;
  }
  return changed;
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
  // Screened here rather than at each call site so every path that assigns a
  // handle (hello, reconnect, set-handle) is covered by construction.
  if (containsProfanity(t)) return false;
  return true;
}

export function publicPlayer(p) {
  // Strip server-only bookkeeping (attempts/streak counters, identity)
  // before broadcasting to WS clients. Expose only a boolean guest flag.
  // `isBot` and `tier` stay in the payload by decision — bot backfill is
  // disclosed in the UI copy, not hidden on the wire.
  //
  // racerId is the reconnect secret: whoever presents it in `hello` takes over
  // the seat, so it must never reach another client. connId names the socket
  // currently holding the seat — server-only bookkeeping for the eviction
  // path. What survives here is `id`, the ephemeral per-room broadcast id
  // (see nextBroadcastId).
  const { attempts, longestStreak, currentStreak, deviceId, userId, racerId, connId, ...rest } = p;
  return { ...rest, isGuest: !userId };
}

/**
 * True when `connection` is the socket that most recently claimed this seat.
 *
 * A seat has exactly one current owner, re-stamped by every accepted `hello`.
 * Requires a real recorded owner AND a real connection id, so two unknowns
 * never read as a match.
 */
export function ownsSeat(player, connection) {
  const owner = player?.connId;
  if (typeof owner !== 'string' || owner.length === 0) return false;
  return owner === connection?.id;
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

  // Mirror of the last lastActivityAt value written to storage. In-memory and
  // deliberately unpersisted: on a cold start it is null, so the first flush
  // writes, which is the safe direction.
  persistedActivityAt = null;

  // In-memory, per-instance. Not persisted and not shared across rooms: a
  // flood only ever needs to be stopped in the room receiving it.
  socketLimiter = createSocketLimiter();

  freshState(id) {
    return freshState(id);
  }

  /**
   * Hook: true for room types that wind down after PRIVATE_ROOM_IDLE_MS of
   * silence. PublicRaceRoom overrides this to false — quickmatch rooms are
   * single-shot and already reclaimed by the auto-start / idle-cleanup path,
   * and an "expired" screen has no meaning for a room nobody holds a link to.
   */
  expiresWhenIdle() {
    return true;
  }

  async onStart() {
    const stored = await this.ctx.storage.get('state');
    this.state = stored ?? this.freshState(this.name);
    // A room persisted by an older build still carries racerIds in player.id.
    // Re-key on load so no live room keeps broadcasting them. A socket that
    // hibernated across that deploy holds the pre-migration id in its
    // connection state and has to `hello` again to act; accepted, since the
    // alternative is leaving the secret on the wire for the room's lifetime.
    let migrated = stored ? adoptBroadcastIds(this.state) : false;

    // The tombstone only answers for EXPIRED_ROOM_TTL_MS; past that the name
    // is free again and this is an ordinary empty room.
    if (this.state.state === EXPIRED_ROOM_STATE
      && Date.now() - (this.state.expiredAt ?? 0) > EXPIRED_ROOM_TTL_MS) {
      this.state = this.freshState(this.name);
      migrated = true;
    }

    // A room persisted before the winddown shipped has no activity clock.
    // Start it now rather than deriving one from createdAt, which would expire
    // a room mid-race the first time it reloads after the deploy.
    if (this.expiresWhenIdle() && this.state.state !== EXPIRED_ROOM_STATE && this.state.lastActivityAt == null) {
      this.state.lastActivityAt = Date.now();
      migrated = true;
    }

    if (!stored || migrated) await this.persist();
  }

  async onConnect(connection, ctx) {
    // The room wound down; there is nothing to join. Say so explicitly and
    // close, so the client shows the expired screen instead of sitting on a
    // socket that will never carry a lobby.
    if (this.state.state === EXPIRED_ROOM_STATE) {
      connection.send(expiredMessage(this.name));
      closeQuietly(connection, 'room expired');
      return;
    }

    // Capture user_id from the upgrade-request header set by the Worker
    // entry. Client-supplied values are stripped/overwritten there, so this
    // is trustworthy. Null for anon users.
    const userId = ctx?.request?.headers?.get('x-arithmetic-user-id') ?? null;
    connection.setState({ ...(connection.state ?? {}), userId });

    // Don't add player yet — wait for `hello`.
    connection.send(JSON.stringify({ type: 'state', state: this.publicState(), youAre: null }));

    // Someone opening the page is activity: push the winddown out and make
    // sure an alarm exists to enforce it.
    this.touchActivity();
    await this.flushActivity();
    await this.scheduleNextAlarm();
  }

  async onMessage(connection, raw) {
    // Before parsing: a flood is cheapest to drop when we do no work on it.
    // Dropped silently rather than answered with an error — replying would
    // hand a flooding socket a response per message, which is the opposite of
    // what a limiter is for. A real client never reaches this rate.
    if (!this.socketLimiter.allow(connection.id)) return;

    let msg;
    try {
      msg = JSON.parse(typeof raw === 'string' ? raw : new TextDecoder().decode(raw));
    } catch {
      return;
    }
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;

    // A socket that survived the winddown (or an old client that reconnected
    // into the tombstone) gets the same answer as a fresh connection.
    if (this.state.state === EXPIRED_ROOM_STATE) {
      connection.send(expiredMessage(this.name));
      closeQuietly(connection, 'room expired');
      return;
    }

    const handler = MESSAGE_HANDLERS.get(msg.type);
    if (!handler) return;

    // Recorded before dispatch so whatever the handler persists carries the
    // new timestamp; unrecognized types deliberately do not count, or a client
    // could hold a room open forever with junk.
    this.touchActivity();

    try {
      await handler(this, connection, msg);
    } catch (e) {
      logError(KINDS.ROOM_MESSAGE, e, { roomId: this.name, msgType: msg.type });
    }

    // Handlers reschedule for their own deadlines, but the ones that only
    // reply with an error (or a wrong answer) do not — and the winddown clock
    // just moved for all of them.
    await this.flushActivity();
    await this.scheduleNextAlarm();
  }

  async onClose(connection) {
    // Release the bucket first — this must happen for every close, including
    // the early returns below, or a long-lived room retains an entry per
    // socket it has ever seen.
    this.socketLimiter.forget(connection.id);

    // A tab closing is the last thing a client does in this room, and it is
    // where the idle clock for an emptying room starts.
    this.touchActivity();

    // Resolved through playerFor, not by broadcast id alone: a socket whose
    // seat is gone must not open a grace window against whoever occupies that
    // id now — that would evict a live player 30s later.
    const player = this.playerFor(connection);

    // The secret alone does not make this close the seat's departure: a later
    // socket presenting the same racerId (second tab, or an auto-reconnect that
    // beat this close) took the seat over and is still live. Grace it and
    // onAlarm would evict a connected player 30s later.
    if (player && ownsSeat(player, connection)) {
      // Schedule a 30s reconnection grace (Task 9). If a fresh hello presenting
      // this seat's racerId arrives within the window, the disconnect is cancelled.
      this.state.disconnectDeadlines[player.id] = Date.now() + RECONNECT_GRACE_MS;
      await this.persist();
    } else {
      // No grace window to open, but the winddown clock still moved.
      await this.flushActivity();
    }
    await this.scheduleNextAlarm();
  }

  async onAlarm() {
    const now = Date.now();
    let mutated = false;

    // Idle winddown comes first: nothing below is worth doing in a room that
    // is about to stop existing.
    const expiryAt = this.idleExpiryAt();
    if (expiryAt != null && expiryAt <= now) {
      await this.expireRoom(now);
      return;
    }

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
      const idleSince = this.state.lastActivityAt;
      this.state = this.freshState(this.name);
      if (this.expiresWhenIdle()) {
        // The room is reborn empty, not active: keep measuring the winddown
        // from the last real activity, or this reset would silently hand it a
        // fresh 30 minutes every time it emptied out.
        this.state.lastActivityAt = idleSince ?? now;
        await this.persist();
        await this.scheduleNextAlarm();
        return;
      }
      await this.ctx.storage.delete('state');
      // Don't broadcast; nobody's listening.
      return;
    }

    // Hard ceiling: 24h.
    if (now - this.state.createdAt > ROOM_MAX_AGE_MS && this.state.players.length === 0) {
      await this.ctx.storage.delete('state');
      this.state = this.freshState(this.name);
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
    // msg.playerId is the client's racerId — a long-lived secret that lives in
    // the sender's localStorage and nowhere else on the wire. It is the ONLY
    // thing that reattaches a socket to an existing seat, so the reconnect
    // branch below is an ownership proof, not a lookup by public identifier:
    // other clients only ever learn `player.id`, which is ephemeral, non-UUID,
    // and therefore unusable here.
    if (typeof msg.playerId !== 'string' || !UUID_V4_RE.test(msg.playerId)) {
      return this.sendError(connection, 'INVALID_INPUT', 'Bad playerId');
    }
    const racerId = msg.playerId;
    const existing = this.state.players.find((p) => !p.isBot && p.racerId === racerId);

    if (existing) {
      // Reconnect — preserve all per-race fields.
      delete this.state.disconnectDeadlines[existing.id];
      const currentConnState = connection.state ?? {};
      connection.setState({ ...currentConnState, playerId: existing.id, racerId });
      // This socket is now the seat's owner; the one it displaced must no
      // longer be able to open an eviction window against it.
      existing.connId = connection.id;
      // Refresh identity from this connection (cookie may have changed).
      if (isValidDeviceId(msg.deviceId)) existing.deviceId = msg.deviceId;
      existing.userId = currentConnState.userId ?? null;
      // Optionally update handle if client sent a non-null one.
      if (typeof msg.handle === 'string' && isValidHandle(msg.handle)) {
        existing.handle = msg.handle.trim();
      }
      connection.send(JSON.stringify({
        type: 'hello-ack', playerId: existing.id, handle: existing.handle,
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
      // Wire identity: ephemeral, per-room, safe to broadcast.
      id: nextBroadcastId(this.state),
      // Reconnect secret: server-side only, stripped by publicPlayer.
      racerId,
      // Socket currently holding the seat; server-side only, and the only
      // socket whose close opens the reconnect grace.
      connId: connection.id,
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

    connection.setState({ ...currentConnState, playerId: player.id, racerId });
    connection.send(JSON.stringify({ type: 'hello-ack', playerId: player.id, handle }));
    this.broadcast(JSON.stringify({ type: 'player-joined', player: publicPlayer(player) }));
    await this.persist();
    this.broadcastState();
    await this.scheduleNextAlarm();
  }

  async handleSetHandle(connection, msg) {
    const player = this.playerFor(connection);
    if (!player) return this.sendError(connection, 'BAD_STATE', 'No player; send hello first');
    // Checked ahead of isValidHandle purely for the error message: the screen
    // lives inside isValidHandle so every assignment path is covered, but this
    // is the one path with a user watching, and "must be 1-24 chars" is a
    // baffling thing to tell someone whose handle was rejected as profane.
    if (containsProfanity(msg.handle)) {
      return this.sendError(connection, 'INVALID_INPUT', 'Please choose a different handle');
    }
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
    // Allowed in 'lobby' and 'finished' — see room-config-rules.js. Restricting
    // this to 'lobby' froze a room's difficulty after its first race, since
    // 'finished' is where the host sits until they hit Race Again.
    if (!isConfigurableState(this.state.state)) {
      return this.sendError(connection, 'BAD_STATE', 'Config can only change between races');
    }

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
    // Pin the denominator the scoreboard should use, before the host is free
    // to change raceLength for the next race.
    this.state.lastRaceLength = this.state.raceLength;
    const rankings = rankPlayers(this.state.players);
    this.broadcast(JSON.stringify({ type: 'finish', rankings: rankings.map(publicPlayer) }));

    await this.persistRaceResults();
  }

  async persistRaceResults() {
    for (const p of this.state.players) {
      if (!p.deviceId) {
        // Defensive: shouldn't happen since the client always sends deviceId
        // in `hello`, but skip rather than violate the NOT NULL constraint.
        logError(KINDS.RACE_RESULT_DB, 'skipping player with no deviceId', { roomId: this.name, playerId: p.id, phase: 'precheck' });
        continue;
      }
      try {
        await insertRaceResult(this.env, buildRaceResultPayload(p, this.state));
      } catch (e) {
        logError(KINDS.RACE_RESULT_DB, e, { roomId: this.name, playerId: p.id, phase: 'insert' });
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
    // Both halves of the seat are stamped by handleHello, and only after the
    // racerId proved ownership: playerId is the broadcast id, racerId the
    // secret behind it. The broadcast id alone is NOT sufficient proof — it is
    // drawn from a counter that lives in `state`, so an idle-cleanup reset (or
    // the legacy re-key in adoptBroadcastIds) can hand `p-<n>` to a later
    // player while some long-lived socket still carries it. Matching the
    // secret too means such a socket resolves to nobody, which is what every
    // handler and onClose need it to do.
    const pid = connection.state?.playerId;
    const racerId = connection.state?.racerId;
    if (!pid || !racerId) return null;
    // Bots hold neither a connection nor a secret; never resolvable here.
    return this.state.players.find((p) => !p.isBot && p.id === pid && p.racerId === racerId) ?? null;
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
      const youAre = this.playerFor(c)?.id ?? null;
      c.send(JSON.stringify({ type: 'state', state: this.publicState(), youAre }));
    }
  }

  sendError(connection, code, message) {
    connection.send(JSON.stringify({ type: 'error', code, message }));
  }

  async persist() {
    await this.ctx.storage.put('state', this.state);
    // What the durable copy of the idle clock now says. flushActivity() reads
    // this to skip a redundant write when a handler already persisted.
    this.persistedActivityAt = this.state.lastActivityAt ?? null;
  }

  // ---------- idle winddown ----------

  /** Record that a client touched this room. In-memory; see flushActivity. */
  touchActivity() {
    if (!this.expiresWhenIdle()) return;
    if (this.state.state === EXPIRED_ROOM_STATE) return;
    this.state.lastActivityAt = Date.now();
  }

  /**
   * Make sure the bumped clock reached storage. The alarm time is durable but
   * the timestamp behind it is not, so a DO evicted between activity and its
   * alarm would wake with a stale clock and wind the room down early.
   */
  async flushActivity() {
    if (!this.expiresWhenIdle()) return;
    if (this.state.lastActivityAt === this.persistedActivityAt) return;
    await this.persist();
  }

  /** When this room winds down if nothing else happens, or null if it never does. */
  idleExpiryAt() {
    if (!this.expiresWhenIdle()) return null;
    if (this.state.state === EXPIRED_ROOM_STATE) return null;
    const since = this.state.lastActivityAt ?? this.state.createdAt;
    if (since == null) return null;
    return since + PRIVATE_ROOM_IDLE_MS;
  }

  /**
   * Wind the room down: tell everyone still attached, replace the state with a
   * tombstone, drop the alarm. With no alarm, no players and no live sockets,
   * the DO goes dormant and stops costing anything until someone opens the
   * link again — and when they do, the tombstone answers "expired" instead of
   * quietly reviving the room under them.
   */
  async expireRoom(now = Date.now()) {
    this.broadcast(expiredMessage(this.name));
    this.state = {
      ...this.freshState(this.name),
      state: EXPIRED_ROOM_STATE,
      expiredAt: now,
      lastActivityAt: null,
    };
    await this.persist();
    await this.ctx.storage.deleteAlarm();
    for (const c of this.getConnections()) closeQuietly(c, 'room expired');
  }

  /**
   * RPC, called by `POST /api/rooms` when this name is handed out for a new
   * room. Room ids are drawn from a ~13k-combination word list, so a fresh
   * room can land on the name of one that expired; without this, its creator
   * would open the invite link straight onto the "room expired" screen.
   *
   * Reachable before onStart() — partyserver only initializes on fetch/alarm —
   * so it reads storage itself rather than trusting `this.state`.
   */
  async claimRoomName() {
    const stored = await this.ctx.storage.get('state');
    if (stored?.state !== EXPIRED_ROOM_STATE) return false;
    const fresh = this.freshState(this.name);
    await this.ctx.storage.put('state', fresh);
    // If this instance was already running on the tombstone, swap it out too;
    // onStart will not run again to do it.
    if (this.state == null || this.state.state === EXPIRED_ROOM_STATE) {
      this.state = fresh;
      this.persistedActivityAt = fresh.lastActivityAt;
    }
    return true;
  }

  extraAlarmDeadlines() {
    // Subclasses can return additional ms-timestamps to coalesce into the alarm.
    return [];
  }

  async scheduleNextAlarm() {
    const candidates = [];
    if (this.state.countdownAt != null) candidates.push(this.state.countdownAt);
    if (this.state.idleCleanupAt != null) candidates.push(this.state.idleCleanupAt);
    for (const dl of Object.values(this.state.disconnectDeadlines)) candidates.push(dl);
    for (const dl of this.extraAlarmDeadlines()) if (dl != null) candidates.push(dl);
    // Re-derived from lastActivityAt on every call, so each bump of the idle
    // clock pushes the winddown alarm out with it.
    const expiryAt = this.idleExpiryAt();
    if (expiryAt != null) candidates.push(expiryAt);

    if (candidates.length === 0) {
      const cur = await this.ctx.storage.getAlarm();
      if (cur != null) await this.ctx.storage.deleteAlarm();
      return;
    }
    const next = Math.min(...candidates);
    const cur = await this.ctx.storage.getAlarm();
    if (cur === next) return;
    // A pending alarm that is merely a little early is left alone: onAlarm
    // re-derives the deadlines and reschedules if none has been reached, so the
    // drift costs one wake-up instead of a storage write per client frame.
    // Only rooms carrying an idle clock have frames to conserve writes on; a
    // room without one moves its deadlines a handful of times per match, and
    // would trade a write it already pays for a wake-up it does not.
    if (this.expiresWhenIdle()
      && cur != null && cur > Date.now() && next > cur && next - cur < ALARM_SLOP_MS) return;
    await this.ctx.storage.setAlarm(next);
  }
}
