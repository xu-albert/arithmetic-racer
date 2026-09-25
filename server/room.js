import { Server } from 'partyserver';
import { generateHandle } from '../public/src/handles.js';
import { generateSequence, validateAnswer, DIFFICULTIES } from '../public/src/game.js';
import { isConfigurableState } from '../public/src/room-config-rules.js';
import { EXPIRED_ROOM_STATE, ROOM_EXPIRED_TYPE } from '../public/src/room-expiry.js';
import { insertRaceResult, MAX_DEVICE_ID_LENGTH } from '../worker/race-result-store.js';
import { CAPTCHA_PROBLEM_COUNT } from '../worker/plausibility.js';
import { containsProfanity } from '../worker/username-validator.js';
import { logError, KINDS } from '../worker/logger.js';
import { buildRaceResultPayload } from './room-stats.js';
import {
  needsCaptchaTrigger, newCaptchaSeed, captchaProblems, captchaWireProblems, captchaDeadline,
} from './captcha.js';
import { createSocketLimiter } from './socket-limit.js';

// Mirrors public/src/runner.js values. The default race length is not here —
// it is `raceLength` in freshState() below, which the leaderboards filter on.
export const COUNTDOWN_SECONDS = 3;
export const IDLE_CLEANUP_MS = 5 * 60 * 1000;
export const RECONNECT_GRACE_MS = 30 * 1000;
export const ROOM_MAX_AGE_MS = 24 * 60 * 60 * 1000;

// Once the first racer crosses the line the race has a deadline: everyone still
// answering gets this long before finishRace() marks them dnf. This is the rule
// docs/phase-6-private-rooms-plan.md specified and main shipped without, and
// without it a racer who simply stops answering holds the room — and everyone
// who already finished — open indefinitely.
//
// The value deliberately differs from the solo game's GRACE_PERIOD_MS (5s, in
// public/src/runner.js). There the grace is armed by the human's own finish, so
// the only racers it ever cuts off are bots. Here they are people, so the window
// is scaled to the race rather than to the leader's reaction time: roughly a
// second race's worth of extra time, however long that race is.
export const RACE_GRACE_MS_PER_PROBLEM = 6 * 1000;

// Ceiling on a whole race, measured from raceStartedAt. The grace above only
// arms when somebody finishes; a race where nobody ever does — every human idle,
// or every socket half-live — needs its own bound, and public rooms have no idle
// winddown to fall back on. Generous on purpose: a minute per problem is an order
// of magnitude slower than any real racer, so only a dead race reaches it.
export const RACE_MAX_MS_PER_PROBLEM = 60 * 1000;

/** The post-first-finisher grace for a race of `raceLength` problems. */
export function raceGraceMs(raceLength) {
  return RACE_GRACE_MS_PER_PROBLEM * raceLength;
}

// A private room that sees no activity for this long winds down: its state is
// replaced by a tombstone, its alarm is cleared, and everyone still attached is
// sent to the "room expired" screen. "Activity" is any client touching the
// room — a socket connecting or closing, or any recognized room message — so
// both an empty room and a room full of AFK tabs qualify. Race *ticks* are not
// activity; a race nobody is answering is idle by this definition.
export const PRIVATE_ROOM_IDLE_MS = 30 * 60 * 1000;

// The same winddown, on a much shorter fuse, for a room that was reserved by
// `POST /api/rooms` and that nobody has joined yet. Reserving writes live state
// before there is anyone in the room, so an unauthenticated caller can take
// names out of a 13,248-name namespace as fast as it can post; holding each one
// for the full 30 minutes would let a few requests per second deny room
// creation to everybody. The creator's socket is already opening while the
// response is in flight, so two minutes is generous for the only client that
// legitimately has a reservation. The moment a seat is claimed the room is an
// ordinary private room on PRIVATE_ROOM_IDLE_MS — including after it empties
// out again, since the idle-cleanup re-mint deliberately carries that clock
// forward rather than marking the room unjoined a second time. `reserveRoomName`
// and `onStart` are the two places live state is minted with nobody in the room,
// and both mark it.
export const UNJOINED_ROOM_IDLE_MS = 2 * 60 * 1000;

// How long the tombstone answers for the room name before it is reusable.
// Room ids come from a 13k-combination word list, so holding one forever
// would eventually stamp "expired" on a brand-new room; a day is long enough
// that a stale invite link explains itself.
export const EXPIRED_ROOM_TTL_MS = 24 * 60 * 60 * 1000;

// The race-result outbox (state.pendingResults) retries a failed insert on
// this cadence, woken by the room's shared alarm. The insert itself is
// idempotent (worker/race-result-store.js), so a retry that follows a write
// which secretly succeeded inserts nothing rather than a duplicate row.
export const RESULT_RETRY_MS = 30 * 1000;

// How long the outbox keeps retrying one row before giving up. An outage
// longer than this loses the row the way the old fire-and-forget write did,
// so it is set far past any transient D1 failure; the cap exists because a
// room (or its tombstone) would otherwise hold an alarm and retry forever.
export const RESULT_OUTBOX_TTL_MS = 60 * 60 * 1000;

/** The outbox entries in `state` still inside their retry window at `now`. */
function owedResults(state, now) {
  return (state?.pendingResults ?? []).filter((e) => e.raceAt + RESULT_OUTBOX_TTL_MS > now);
}

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
  ['captcha-answer', (room, conn, msg) => room.handleCaptchaAnswer(conn, msg)],
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
// Seats a private room holds. Public rooms pre-gate at auto-start's
// MAX_PLAYERS (6) before delegating here, so this never binds them.
export const PRIVATE_ROOM_MAX_PLAYERS = 10;
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
    // What the most recently finished race actually was: its difficulty and
    // its raceLength. Both live fields can move while that race's results are
    // still on screen and still being written (the host may reconfigure
    // between races), so the finished scoreboard reads its denominator here
    // and every persisted row reads its tier and length here.
    lastRace: null,
    players: [],
    problemSequence: [],
    raceStartedAt: null,
    // When the post-first-finisher grace expires, or null until somebody
    // finishes. Armed by armRaceGrace(); enforced through raceDeadlineAt().
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
    // Active-verification challenges, keyed by broadcast id: a superhuman-paced
    // finish waits here until that racer answers, fails, or runs out of their
    // own time, and the challenge holds a snapshot of the result row until
    // then. Self-contained on purpose — it carries the difficulty it was drawn
    // at and the race it belongs to, so nothing the room does afterwards can
    // change what it grades or what it stores. Server-only: stripped from
    // publicState() like every other secret, and the wire carries only the
    // problem strings, only to the challenged seat.
    captchaChallenges: {},
    // Rows this room owes D1: built before the first insert attempt, carried
    // here until the write lands, retried by the alarm when it fails, and
    // carried across idle re-mints and the expiry tombstone while still
    // within RESULT_OUTBOX_TTL_MS. Server-only — publicState() strips it.
    pendingResults: [],
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
  state.players = state.players.filter((p) => !p.departed);
  for (const p of state.players) {
    p.score = 0;
    p.attempts = 0;
    p.longestStreak = 0;
    p.currentStreak = 0;
    p.finishMs = null;
    p.dropped = false;
    p.dnf = false;
    p.resultHeld = false;
  }
  state.problemSequence = [];
  state.raceStartedAt = null;
  state.graceDeadline = null;
  state.countdownN = null;
  state.countdownAt = null;
  // captchaChallenges deliberately survives: a challenge belongs to the racer
  // who earned it, not to the race, and only their answers or their own
  // deadline may settle it. pendingResults survives for the same shape of
  // reason: those rows are owed to D1 by races already run, and a rematch
  // must not abandon them.
}

function isValidDeviceId(s) {
  return typeof s === 'string' && s.length > 0 && s.length <= MAX_DEVICE_ID_LENGTH;
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
  const { attempts, longestStreak, currentStreak, deviceId, userId, racerId, connId, resultHeld, departed, ...rest } = p;
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
    // Minting live state here, rather than loading it, means nobody has joined
    // this room yet — and this is the boundary every such state that is not a
    // reservation crosses. partyserver runs onStart before it has even looked
    // for an Upgrade header, so a bare GET to /parties/race-room/<name>
    // persists a lobby too; unmarked and with no alarm, that row would hold the
    // name against reserveRoomName() for good, with nothing left to wake the
    // room and release it.
    let minted = !stored;
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
      minted = true;
      migrated = true;
    }

    // A room persisted before the winddown shipped has no activity clock.
    // Start it now rather than deriving one from createdAt, which would expire
    // a room mid-race the first time it reloads after the deploy.
    if (this.expiresWhenIdle() && this.state.state !== EXPIRED_ROOM_STATE && this.state.lastActivityAt == null) {
      this.state.lastActivityAt = Date.now();
      migrated = true;
    }

    // A room persisted before the result outbox shipped has no queue.
    if (!Array.isArray(this.state.pendingResults)) {
      this.state.pendingResults = [];
      if (stored) migrated = true;
    }

    if (minted && this.expiresWhenIdle()) this.state.unjoined = true;
    if (minted || migrated) await this.persist();
    // The short fuse is only a deadline until something wakes the room to
    // enforce it, and nothing on this path arms one otherwise. Owed result
    // rows need the same: a crash between queueing and settling leaves them
    // to whatever wake comes next, so make sure there is one.
    if (this.state.unjoined || this.state.pendingResults.length > 0) {
      await this.scheduleNextAlarm();
    }
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
          // The room's clock as this left it, which the client reads race
          // time against instead of its own (remote-runner.js).
          serverNow: Date.now(),
        }));
        // After the race-start frame so a subclass's own start-of-race
        // messages keep their wire order, and before the persist below so
        // whatever it derives lands in the same write as the transition.
        this.onRaceStarted();
      }
      mutated = true;
    }

    // Captcha verification deadlines. A challenge that reaches its deadline
    // records as timed-out; the player is told in the captcha-result message.
    for (const [pid, ch] of Object.entries(this.state.captchaChallenges ?? {})) {
      if (ch.deadline <= now) {
        await this.resolveCaptchaChallenge(pid, 'timeout');
        mutated = true;
      }
    }

    // Race deadline. Two bounds share this branch, both derived in
    // raceDeadlineAt(): the grace the first finisher opened, and the ceiling on
    // a race nobody has finished at all. Either way finishRace() marks whoever
    // is still racing dnf, persists every row and hands the room to the normal
    // cleanup path. Deliberately after the countdown tick above, so a race that
    // only just started is never judged in the same wake-up that began it.
    const raceDeadline = this.raceDeadlineAt();
    if (raceDeadline != null && raceDeadline <= now) {
      await this.finishRace();
      mutated = true;
    }

    // Race-result outbox. Rows are queued and persisted before their first
    // insert attempt, so a crash replays into this retry rather than losing
    // the row; the insert's own dedupe (worker/race-result-store.js) absorbs
    // a retry whose original write actually landed. Runs on tombstones too —
    // expireRoom() carries the queue across the winddown.
    if ((this.state.pendingResults ?? []).some((e) => e.nextAttemptAt == null || e.nextAttemptAt <= now)) {
      await this.drainRaceResults();
    }

    // Idle cleanup.
    if (this.state.idleCleanupAt != null && this.state.idleCleanupAt <= now && this.state.players.length === 0) {
      const idleSince = this.state.lastActivityAt;
      // Rows still owed to D1 outlive the room that ran the race: carry the
      // queue across the reset and revisit cleanup once the retry window has
      // closed, rather than deleting storage out from under them.
      const owed = owedResults(this.state, now);
      this.state = this.freshState(this.name);
      if (owed.length > 0) {
        this.state.pendingResults = owed;
        this.state.idleCleanupAt = now + RESULT_OUTBOX_TTL_MS;
      }
      if (this.expiresWhenIdle()) {
        // The room is reborn empty, not active: keep measuring the winddown
        // from the last real activity, or this reset would silently hand it a
        // fresh 30 minutes every time it emptied out.
        this.state.lastActivityAt = idleSince ?? now;
        await this.persist();
        await this.scheduleNextAlarm();
        return;
      }
      if (this.state.pendingResults.length > 0) {
        // A public room is reclaimed by deleting its storage; with rows still
        // owed that delete is the loss the outbox exists to prevent, so keep
        // a stub state until the queue settles or expires.
        await this.persist();
        await this.scheduleNextAlarm();
        return;
      }
      await this.ctx.storage.delete('state');
      // Don't broadcast; nobody's listening.
      return;
    }

    // Hard ceiling: 24h — held off, like idle cleanup, while rows are owed.
    if (now - this.state.createdAt > ROOM_MAX_AGE_MS && this.state.players.length === 0
      && owedResults(this.state, now).length === 0) {
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
      // The seat may be one PublicRaceRoom.removePlayer held past its socket's
      // departure so the race end could still write its row; it is attached
      // again, so it is no longer something to prune there.
      existing.departed = false;
      // ...and it is present again, which is exactly what succession keys on:
      // a reconnecting host keeps the flag (cleared departed reads as present
      // here), while a room whose host departed for good hands it to whoever
      // came back. Runs after departed clears so the two order themselves.
      this.ensureLiveCreator();
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
      // A challenge can be pending across a disconnect (the race ended, the
      // socket dropped before the captcha was answered). The new socket would
      // otherwise never learn about it and the race would silently record as
      // unverified at the deadline — re-offer the remaining problems.
      this.offerCaptcha(existing);
      await this.persist();
      this.broadcastState();
      await this.scheduleNextAlarm();
      return;
    }

    // New player — only allowed in lobby or finished (not mid-race).
    if (this.state.state === 'countdown' || this.state.state === 'racing') {
      return this.sendError(connection, 'BAD_STATE', 'Race already in progress');
    }

    // Reconnects returned above, so only a genuinely new seat is refused. A
    // departed seat still counts: its racer can reclaim it through the
    // reconnect branch, which is cap-exempt, so releasing its place to a
    // newcomer would let the room reach eleven. resetForRace prunes it.
    const humans = this.state.players.filter((p) => !p.isBot).length;
    if (humans >= PRIVATE_ROOM_MAX_PLAYERS) {
      return this.sendError(connection, 'ROOM_FULL',
        `This room is full (${PRIVATE_ROOM_MAX_PLAYERS}/${PRIVATE_ROOM_MAX_PLAYERS}).`);
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
      // Set when a captcha challenge takes ownership of this race's row; see
      // issueCaptchaChallenge. Server-only, stripped by publicPlayer.
      resultHeld: false,
      deviceId: isValidDeviceId(msg.deviceId) ? msg.deviceId : null,
      userId: currentConnState.userId ?? null,
    };
    this.state.players.push(player);
    this.state.idleCleanupAt = null;
    // Somebody is in the room now, so it graduates off the reservation's short
    // fuse onto the ordinary idle clock, for good.
    delete this.state.unjoined;

    // A finished room can hold a departed host nobody succeeded (everyone else
    // was gone at finishRace). A fresh join is the first live seat since — it
    // must inherit the flag or the room still cannot rematch.
    this.ensureLiveCreator();

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

      // The first finish puts the race on a clock: from here the stragglers have
      // raceGraceMs() and then the race ends with or without them.
      if (player.finishMs != null) this.armRaceGrace();

      // Verification starts here, at this racer's own finish, not at race end:
      // the fast racer is by construction the one who then waits longest for
      // the stragglers, and a challenge that opens after that wait lands on
      // somebody who has already looked away.
      if (player.finishMs != null) this.issueCaptchaChallenge(player);

      // Race ends when every non-dropped player has finished — or when the
      // deadline this finish just armed runs out (raceDeadlineAt, enforced in
      // onAlarm), which is what bounds the straggler who stops answering.
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
      // Public rooms have no activity flush to save these stats before hibernation.
      await this.persist();
    }
  }

  /**
   * Grade one captcha answer from the challenged seat. The challenge is keyed
   * to the seat (resolved through playerFor, so presenting someone else's
   * broadcast id is not enough), single-use, and silently ignored when nothing
   * is pending — a wrong guess must not learn whether a challenge exists.
   */
  async handleCaptchaAnswer(connection, msg) {
    const player = this.playerFor(connection);
    if (!player) return;
    const challenge = this.state.captchaChallenges?.[player.id];
    if (!challenge) return;

    if (Date.now() > challenge.deadline) {
      await this.resolveCaptchaChallenge(player.id, 'timeout');
      return;
    }

    const problems = captchaProblems(challenge.seed, challenge.difficulty, challenge.count);
    if (validateAnswer(problems[challenge.index], msg.value)) {
      challenge.index += 1;
      if (challenge.index >= challenge.count) {
        await this.resolveCaptchaChallenge(player.id, 'pass');
        return;
      }
      await this.persist();
    } else {
      await this.resolveCaptchaChallenge(player.id, 'failed');
    }
  }

  async handleQuit(connection) {
    const player = this.playerFor(connection);
    if (!player) return;

    if (this.state.state === 'racing') {
      this.dropRacer(player);
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
    // Pin what this race was, before the host is free to reconfigure for the
    // next one. Taken before the `finish` broadcast, so nothing a client sends
    // in reply to it can reach the room first.
    this.state.lastRace = { difficulty: this.state.difficulty, raceLength: this.state.raceLength };
    // A host who departed mid-race still holds isCreator on their kept seat.
    // The finished room is exactly where the host's one remaining power
    // (rematch) matters, so succession cannot wait past this point — and the
    // finish broadcast below carries the new flag to every client.
    this.ensureLiveCreator();
    const rankings = rankPlayers(this.state.players);
    this.broadcast(JSON.stringify({ type: 'finish', rankings: rankings.map(publicPlayer) }));

    await this.persistRaceResults(Date.now());
  }

  /**
   * TypeRacer-style active verification, chosen over tighter passive bounds:
   * a human (not bot) whose server-timed finish is faster than a plausible
   * sustained human rate must answer a few fresh arithmetic problems before
   * the result is recorded. Called the moment that racer finishes, so the
   * response budget runs from their finish rather than from an race end they
   * may be waiting minutes for.
   *
   * Server-authoritative by construction — the seed is drawn here, the
   * problems are regenerated to grade, and only the problem strings reach the
   * client. Single-use: resolveCaptchaChallenge deletes the challenge, so a
   * graded set can never be replayed.
   *
   * Config cannot change while the room is racing (room-config-rules.js), so
   * the live difficulty and length ARE this race's, and the challenge keeps
   * its own copy of both from here on.
   */
  issueCaptchaChallenge(player) {
    if (player.isBot || !player.deviceId) return;
    const race = { difficulty: this.state.difficulty, raceLength: this.state.raceLength };
    if (!needsCaptchaTrigger(player.finishMs, race.raceLength)) return;

    // Racing again without answering abandons the previous challenge, and this
    // key is about to be overwritten, so settle it rather than lose the row it
    // holds. The outcome is 'superseded', not 'timeout': the old budget was
    // still live and the racer may have been mid-answer, and the stored reason
    // has to say what actually happened or captcha_timeout rows stop
    // distinguishing genuine abandonments. Fire-and-forget: the finish path
    // must not suspend on a database write, and resolveCaptchaChallenge takes
    // the challenge out of state before it does anything asynchronous.
    if (this.state.captchaChallenges?.[player.id]) {
      this.resolveCaptchaChallenge(player.id, 'superseded')
        .catch((e) => logError(KINDS.RACE_RESULT_DB, e, { roomId: this.name, playerId: player.id, phase: 'captcha_reissue' }));
    }

    const challenge = {
      playerId: player.id,
      seed: newCaptchaSeed(),
      difficulty: race.difficulty,
      count: CAPTCHA_PROBLEM_COUNT,
      index: 0,
      deadline: captchaDeadline(Date.now()),
      // Snapshot the result row now: the build-before-insert rule from
      // queueRaceResults applies equally to a row that inserts later — a
      // reconfigured or restarted room must not rewrite a held payload.
      payload: buildRaceResultPayload(player, { id: this.state.id, lastRace: race }),
    };
    (this.state.captchaChallenges ??= {})[player.id] = challenge;
    // This race's row is the challenge's to write from here on, whichever way
    // it settles. Recorded on the player rather than inferred from the
    // challenge still being open: a challenge that settles mid-race — now the
    // normal case, since it opens at this racer's own finish — is deleted long
    // before finishRace() runs, and the race-end insert must still stand down.
    player.resultHeld = true;
    this.offerCaptcha(player, challenge);
  }

  /** Send a seat its pending challenge (or the remainder of one, on resend). */
  offerCaptcha(player, challenge = this.state.captchaChallenges?.[player.id]) {
    if (!challenge) return;
    const remaining = captchaProblems(challenge.seed, challenge.difficulty, challenge.count)
      .slice(challenge.index);
    this.sendToSeat(player, JSON.stringify({
      type: 'captcha',
      problems: captchaWireProblems(remaining),
      // Relative, not the absolute deadline: the client's clock may be minutes
      // off the DO's, and a re-offer after a reconnect has to show what is
      // actually left rather than a fresh budget.
      remainingMs: Math.max(0, challenge.deadline - Date.now()),
    }));
  }

  /**
   * Settle a challenge. 'pass' records the held row normally (the passive
   * plausibility bounds still apply to it); every other outcome records it as
   * suspect with a `captcha_<outcome>` reason, which is what excludes it from
   * leaderboards and recent-finishes: 'failed' (wrong answer), 'timeout' (the
   * racer's own deadline passed) and 'superseded' (a reissue settled it while
   * its budget was still live — see issueCaptchaChallenge). Never a ban — the
   * player keeps the row in their own history.
   */
  async resolveCaptchaChallenge(playerId, outcome) {
    const challenge = this.state.captchaChallenges?.[playerId];
    if (!challenge) return;
    delete this.state.captchaChallenges[playerId];

    // The held row goes through the same outbox as every other race row:
    // queued and persisted before the insert is attempted, retried by the
    // alarm if the database is down, deduped by the insert if a retry follows
    // a write that already landed. Dated to this settle, the moment the row
    // became owed.
    const raceAt = Date.now();
    const player = this.state.players.find((p) => p.id === playerId);
    if (outcome === 'pass') {
      this.sendToSeat(player, JSON.stringify({ type: 'captcha-result', verified: true }));
      this.queueRaceResult({ playerId, payload: challenge.payload, raceAt });
    } else {
      const reason = `captcha_${outcome}`;
      this.sendToSeat(player, JSON.stringify({ type: 'captcha-result', verified: false, reason }));
      this.queueRaceResult({ playerId, payload: challenge.payload, override: { suspect: 1, reason }, raceAt });
    }
    await this.persist();
    await this.drainRaceResults();
    await this.scheduleNextAlarm();
  }

  /**
   * Send one message to the socket currently holding a seat, if it is live.
   * getConnections() is an iterator, not an array — under `hibernate: true`
   * partyserver hands back a lazy walk over the hibernating sockets — so this
   * iterates like every other reader of it.
   */
  sendToSeat(player, raw) {
    if (!player?.connId) return;
    for (const conn of this.getConnections()) {
      if (conn.id !== player.connId) continue;
      try {
        conn.send(raw);
      } catch {
        /* socket gone; the deadline still settles the challenge */
      }
      return;
    }
  }

  async persistRaceResults(raceAt) {
    this.queueRaceResults(raceAt);
    await this.flushRaceResults();
  }

  /**
   * Build every row this race owes and queue it into the durable outbox,
   * dated to `raceAt` — the race's end, however late the write lands.
   *
   * Every payload is built before the first insert. A D1 insert is a
   * subrequest, not a storage operation, so the input gate stays open across
   * it and a `set-config` or `rematch` is delivered mid-loop; a payload read
   * from live state after that point would describe a different race.
   */
  queueRaceResults(raceAt) {
    for (const p of this.state.players) {
      if (p.isBot) continue; // bots never write rows (public quickmatch)
      if (!p.deviceId) {
        // Defensive: shouldn't happen since the client always sends deviceId
        // in `hello`, but skip rather than violate the NOT NULL constraint.
        logError(KINDS.RACE_RESULT_DB, 'skipping player with no deviceId', { roomId: this.name, playerId: p.id, phase: 'precheck' });
        continue;
      }
      if (p.resultHeld) {
        // Active verification owns this row: the snapshot taken at issue time
        // is queued by resolveCaptchaChallenge, whether it passed, failed or
        // timed out, and queueing here as well would hand a racer who ignored
        // the challenge a second, clean row.
        continue;
      }
      this.queueRaceResult({ playerId: p.id, payload: buildRaceResultPayload(p, this.state), raceAt });
    }
  }

  /**
   * Add a row to the durable outbox. The queue is only intent, not
   * durability: the caller follows with persist() (directly or through
   * flushRaceResults) before any insert is attempted.
   */
  queueRaceResult({ playerId, payload, override = null, raceAt }) {
    (this.state.pendingResults ??= []).push({ playerId, payload, override, raceAt, nextAttemptAt: null });
  }

  /** Persist the outbox, then attempt every due entry. */
  async flushRaceResults() {
    await this.persist();
    await this.drainRaceResults();
  }

  /**
   * Settle the outbox: attempt every due entry, drop what landed (the insert
   * dedupe counts a quietly successful earlier write as landed), leave what
   * failed to its retry, and retire what has outlived RESULT_OUTBOX_TTL_MS.
   * Persists if anything moved, so the settled state — not the intent — is
   * what a crash replays from.
   *
   * Every entry a drain takes is leased — handed its retry time — before the
   * first insert is awaited. A D1 insert leaves the input gate open, so other
   * handlers run mid-drain: rescheduling the alarm, or draining again when a
   * captcha settles. The lease is what makes a row in flight read as not yet
   * due to all of them, instead of as work to start now. A crash replays the
   * persisted, unleased entry, and onStart() re-arms the alarm for it.
   */
  async drainRaceResults() {
    const now = Date.now();
    let changed = false;
    // A row that has outlived its retry window is an outage report, not a
    // loop to run forever.
    const live = owedResults(this.state, now);
    if (live.length !== (this.state.pendingResults ?? []).length) {
      for (const e of this.state.pendingResults) {
        if (!live.includes(e)) {
          logError(KINDS.RACE_RESULT_DB, 'race result outbox entry expired undelivered', {
            roomId: this.name, playerId: e.playerId, phase: 'outbox_expire',
          });
        }
      }
      this.state.pendingResults = live;
      changed = true;
    }
    const due = (this.state.pendingResults ?? [])
      .filter((e) => e.nextAttemptAt == null || e.nextAttemptAt <= now);
    for (const entry of due) entry.nextAttemptAt = now + RESULT_RETRY_MS;
    for (const entry of due) {
      try {
        await insertRaceResult(this.env, entry.payload, entry.override ?? undefined, entry.raceAt);
        this.state.pendingResults = this.state.pendingResults.filter((e) => e !== entry);
      } catch (e) {
        logError(KINDS.RACE_RESULT_DB, e, { roomId: this.name, playerId: entry.playerId, phase: 'outbox_insert' });
      }
    }
    if (changed || due.length > 0) {
      await this.persist();
      await this.scheduleNextAlarm();
    }
  }

  /**
   * The one place a seat is marked dropped, because there is one rule about
   * when it may be: never once it carries a finishMs. A racer who crossed the
   * line owns that result whatever they do next, and with a race deadline in
   * play "next" is routinely quitting or closing the tab while the stragglers
   * are still answering — `dropped` would rewrite the completed race into an
   * unfinished row (buildRaceResultPayload). Returns true if it newly dropped.
   */
  dropRacer(player) {
    if (player.dropped || player.finishMs != null) return false;
    player.dropped = true;
    this.broadcast(JSON.stringify({ type: 'drop', playerId: player.id }));
    return true;
  }

  async removePlayer(playerId) {
    const idx = this.state.players.findIndex((p) => p.id === playerId);
    if (idx < 0) return false;
    const player = this.state.players[idx];
    delete this.state.disconnectDeadlines[playerId];

    // Mid-race: keep the player in state.players so finishRace persists their
    // row — a DNF for whoever was still answering, a finish for whoever was
    // not. `departed` marks it as held only for that row; it still counts toward
    // PRIVATE_ROOM_MAX_PLAYERS (its racer may reconnect) until resetForRace
    // drops it on rematch.
    if (this.state.state === 'racing') {
      player.departed = true;
      this.dropRacer(player);
      // A departed host seat keeps its result row but must not keep the host
      // flag — a finished room whose only creator is gone can never rematch.
      this.ensureLiveCreator(player);
      const allDone = this.isRaceComplete();
      if (allDone) await this.finishRace();
      return true;
    }

    // Non-racing (lobby / countdown / finished): actually remove.
    this.state.players.splice(idx, 1);
    this.cancelAbandonedCountdown();

    // The departed seat is already spliced, so its flag is only visible here
    // by being handed over explicitly.
    this.ensureLiveCreator(player);

    this.broadcast(JSON.stringify({ type: 'player-left', playerId }));

    if (this.state.players.length === 0) {
      this.state.idleCleanupAt = Date.now() + IDLE_CLEANUP_MS;
    }
    return true;
  }

  /**
   * A countdown whose last human left has nobody to race: cancel it back to an
   * empty lobby rather than let onAlarm tick a ghost race into being — one that
   * runs for minutes, burning alarm wake-ups and showing every reconnector a
   * live race that means nothing, until idle cleanup ends it. Any bots the
   * countdown seated go with it, so the caller's empty-room gates see a real
   * headcount.
   */
  cancelAbandonedCountdown() {
    if (this.state.state !== 'countdown') return;
    if (this.state.players.some((p) => !p.isBot)) return;
    this.state.players = [];
    this.state.state = 'lobby';
    this.state.countdownN = null;
    this.state.countdownAt = null;
  }

  /**
   * Hand the host flag on when the seat holding it is no longer in the room.
   *
   * Start, config and rematch all gate on isCreator, so a room whose host seat
   * is gone is a dead end — nobody can start or replay a race. The flag moves
   * to the next-longest-present player: the earliest joinedAt among seats still
   * in the room. "Gone" means spliced (a lobby/finished departure, already done
   * by the caller) or marked departed (a mid-race one, where the seat is kept
   * for its result row). A seat whose socket dropped inside its reconnect
   * grace still counts as present — the grace exists so a blip costs nothing,
   * and that includes the host badge; if the grace expires unclaimed,
   * removePlayer runs this again on the way out, so a promoted host who also
   * left passes the flag onward in turn.
   *
   * While any human seat remains, one of them holds the flag. With nobody
   * present to receive it, it is parked on the earliest remaining seat even
   * though that seat is departed, and the next seat to become present — a
   * reconnect or a fresh join, both of which run this — takes it from there.
   * Succession is otherwise final: a reconnecting ex-host comes back as an
   * ordinary player whenever someone present already holds the flag.
   *
   * Public rooms never mint a creator (PublicRaceRoom.handleHello clears it),
   * so the first check keeps this a no-op there.
   */
  ensureLiveCreator(departedSeat = null) {
    const players = this.state.players;
    // The caller may have just spliced the departing seat; its flag is the
    // proof this room ever had a host even when no remaining seat carries it.
    if (!players.some((p) => p.isCreator) && !departedSeat?.isCreator) return;
    const present = (p) => !p.isBot && !p.departed && p.id !== departedSeat?.id;
    if (players.some((p) => p.isCreator && present(p))) return;
    const earliest = (eligible) => {
      let next = null;
      for (const p of players) {
        if (eligible(p) && (!next || p.joinedAt < next.joinedAt)) next = p;
      }
      return next;
    };
    const next = earliest(present) ?? earliest((p) => !p.isBot);
    if (!next) return;
    for (const p of players) p.isCreator = false;
    next.isCreator = true;
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
   * Open the post-first-finisher window, if it is not already open. The first
   * finisher owns it: a later one must not push the deadline out, or a racer
   * finishing every few seconds would extend the wait without limit.
   */
  armRaceGrace() {
    if (this.state.state !== 'racing') return;
    if (this.state.graceDeadline != null) return;
    this.state.graceDeadline = Date.now() + raceGraceMs(this.state.raceLength);
  }

  /**
   * When this race ends regardless of who is still answering, or null outside a
   * race. The earlier of the grace the first finisher opened and the hard
   * ceiling on the race as a whole. Read by both onAlarm (to enforce) and
   * scheduleNextAlarm (to wake for it); gated on 'racing' so a stale
   * graceDeadline can never schedule an alarm or end a race twice.
   */
  raceDeadlineAt() {
    if (this.state.state !== 'racing') return null;
    const deadlines = [];
    if (Number.isFinite(this.state.graceDeadline)) deadlines.push(this.state.graceDeadline);
    // Checked because raceStartedAt is null until the countdown releases the
    // race, and a NaN deadline would reach setAlarm() and throw.
    if (Number.isFinite(this.state.raceStartedAt)) {
      deadlines.push(this.state.raceStartedAt + RACE_MAX_MS_PER_PROBLEM * this.state.raceLength);
    }
    return deadlines.length > 0 ? Math.min(...deadlines) : null;
  }

  /**
   * Hook: returns true when the race should be ended. Default implementation
   * counts every player. PublicRaceRoom overrides this to ignore bots.
   */
  isRaceComplete() {
    return this.state.players.every((p) => p.dropped || p.score >= this.state.raceLength);
  }

  /**
   * Hook: runs synchronously inside onAlarm's countdown→racing branch, after
   * the race-start broadcast and before the transition's persist, so anything
   * a subclass derives here rides the same storage write as the racing
   * snapshot. PublicRaceRoom computes its bot timelines here.
   */
  onRaceStarted() {}

  publicState() {
    // Strip server-only Player fields (attempts/streak counters, identity), the
    // captcha table (seeds, answers, held result rows), the result outbox
    // (row payloads carry deviceId/userId) and the unjoined flag (a lifecycle
    // detail no client acts on) before broadcasting.
    // `serverNow` is the room's clock at send, for a client reading race time
    // off `raceStartedAt` (remote-runner.js).
    const { captchaChallenges, unjoined, pendingResults, ...rest } = this.state;
    return { ...rest, players: this.state.players.map(publicPlayer), serverNow: Date.now() };
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
    // A reservation nobody has joined runs on the short fuse; see
    // UNJOINED_ROOM_IDLE_MS. The flag is dropped by the first seat claimed.
    return since + (this.state.unjoined ? UNJOINED_ROOM_IDLE_MS : PRIVATE_ROOM_IDLE_MS);
  }

  /**
   * Wind the room down: tell everyone still attached, replace the state with a
   * tombstone, drop the alarm — unless the outbox still owes rows, which keep
   * it armed until they settle or expire. With no alarm, no players and no
   * live sockets, the DO goes dormant and stops costing anything until someone
   * opens the link again — and when they do, the tombstone answers "expired"
   * instead of quietly reviving the room under them.
   */
  async expireRoom(now = Date.now()) {
    this.broadcast(expiredMessage(this.name));
    // Rows still owed to D1 survive the winddown: the tombstone carries the
    // outbox and keeps an alarm until they settle or expire, so a room that
    // idles out during a database outage does not take its results with it.
    const owed = owedResults(this.state, now);
    this.state = {
      ...this.freshState(this.name),
      state: EXPIRED_ROOM_STATE,
      expiredAt: now,
      lastActivityAt: null,
      pendingResults: owed,
    };
    await this.persist();
    if (owed.length > 0) {
      await this.scheduleNextAlarm();
    } else {
      await this.ctx.storage.deleteAlarm();
    }
    for (const c of this.getConnections()) closeQuietly(c, 'room expired');
  }

  /**
   * RPC, called by `POST /api/rooms` to take this name for a new room. True if
   * the name was free and is now this room's; false if a live room already
   * owns it, which is the route's signal to draw again — room ids are three
   * words from a ~13k-combination list, so a draw really can land on a room
   * somebody else is sitting in, and returning it would hand the caller a
   * lobby they did not create.
   *
   * The read-then-write *is* the reservation. A Durable Object is
   * single-threaded per name and its input gate stays shut across these
   * storage awaits, so two creations that drew the same name serialize here
   * and only the first one finds it free. Nothing weaker works: a bare
   * "is it taken?" check would let both callers see a free name and both
   * return it.
   *
   * Free means no state at all, or an expired-room tombstone — clearing that
   * is why this RPC existed in the first place, since otherwise the creator
   * opens the invite link straight onto the "room expired" screen.
   *
   * Reserving writes *live* state, so an abandoned reservation would hold its
   * name forever. Arming the alarm hands it to the idle winddown, which turns
   * it back into a reclaimable tombstone — on UNJOINED_ROOM_IDLE_MS while
   * nobody has joined, since this endpoint is unauthenticated and the namespace
   * is small, and on the ordinary PRIVATE_ROOM_IDLE_MS from the first seat
   * onwards. onStart() does the same for the live state a plain request to
   * /parties/race-room/<name> mints, so no path leaves an unjoined room holding
   * a name without a fuse on it.
   *
   * Reachable before onStart() — partyserver only initializes on fetch/alarm —
   * so it reads storage itself rather than trusting `this.state`.
   */
  async reserveRoomName() {
    const stored = await this.ctx.storage.get('state');
    if (stored != null && stored.state !== EXPIRED_ROOM_STATE) return false;
    const fresh = { ...this.freshState(this.name), unjoined: true };
    // A tombstone may still owe result rows to D1; the room taking over the
    // name inherits the queue (the alarm armed below retries it) rather than
    // the writes dying with the old room.
    const owed = owedResults(stored, Date.now());
    if (owed.length > 0) fresh.pendingResults = owed;
    // A bare RPC skips partyserver's initialization, which is what records the
    // name for an alarm wake whose ctx.id carries none. Without it the fuse
    // armed below throws on this.name in expireRoom() and never frees the name.
    await this.ctx.storage.put({ state: fresh, __ps_name: this.name });
    // If this instance was already running on the tombstone, swap it out too;
    // onStart will not run again to do it.
    if (this.state == null || this.state.state === EXPIRED_ROOM_STATE) {
      this.state = fresh;
      this.persistedActivityAt = fresh.lastActivityAt;
    }
    await this.scheduleNextAlarm();
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
    for (const ch of Object.values(this.state.captchaChallenges ?? {})) candidates.push(ch.deadline);
    // A queued row with no retry time yet is due now: the in-line drain right
    // after queueing normally settles it, and the alarm is the backstop for
    // the crash that landed in between.
    for (const e of this.state.pendingResults ?? []) candidates.push(e.nextAttemptAt ?? Date.now());
    const raceDeadline = this.raceDeadlineAt();
    if (raceDeadline != null) candidates.push(raceDeadline);
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
