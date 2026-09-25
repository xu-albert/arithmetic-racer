// Mirrors public/src/runner.js so attachRaceUI works unchanged.
// The local player's id is aliased to 'player' so ui.js's `.id === 'player'` checks Just Work.
// The `laneId` carried by these events (and written to `lane.dataset.laneId` in ui.js) is
// that lane key — the server's ephemeral broadcast id, or the 'player' alias — never the
// localStorage racerId, which is the reconnect secret and leaves this browser only inside
// `hello` (see identity.js).

import { validateAnswer } from './game.js';
import { scoreBotAt } from './bot-timeline.js';
import { rankRacers } from './rankings.js';

const PLAYER_ALIAS = 'player';

function aliasId(id, youAre) {
  return id === youAre ? PLAYER_ALIAS : id;
}

// Append the guest marker inline so it shows up on race lanes + podium without
// modifying ui.js. The server broadcasts isGuest (no account); the badge only
// encodes account status, so bots carry it too — bot backfill is disclosed in
// the lobby copy, not hidden on the wire (isBot/tier stay in the payload).
function displayHandle(rawHandle, isGuest) {
  return isGuest ? `${rawHandle} (Guest)` : rawHandle;
}

// One wire player → one local racer, in the shape ui.js and rankings.js read.
function toRacer(p, youAre) {
  return {
    id: aliasId(p.id, youAre),
    handle: displayHandle(p.handle, !!p.isGuest),
    isBot: !!p.isBot,
    tier: p.tier ?? null,
    score: p.score ?? 0,
    finishMs: p.finishMs ?? null,
    dropped: !!p.dropped,
    dnf: !!p.dnf,
  };
}

function buildRacers(players, youAre) {
  return players.map((p) => toRacer(p, youAre));
}

export function createRemoteRunner({ roomClient, initialState, youAre, onLocalQuit }) {
  const raceLength = initialState.raceLength;
  // Mutated in place and never reassigned: ui.js keeps a reference to it.
  const racers = buildRacers(initialState.players, youAre);
  let sequence = initialState.problemSequence ?? [];
  const listeners = new Set();
  let stopped = false;
  // `raceStarted` is this runner's view of the race being live. It is normally
  // set by the `race-start` push, which listeners are always attached for. The
  // exception is a reconnect: the runner is constructed from an already-`racing`
  // snapshot, before attachRaceUI has subscribed, so the start is owed at that
  // point and paid out on the first `on()` — `startDelivered` keeps it to one.
  let raceStarted = false;
  let startDelivered = false;
  let raceSettled = false;
  let raceStartedAtMs = initialState.raceStartedAt ?? null;
  let lastCountdownN = null;

  // How far the room's clock is ahead of this browser's. Every race time on
  // the wire — `raceStartedAt`, the bot timelines, the finish the room stamps
  // — is on the room's clock, so a device whose own clock is a minute fast
  // would otherwise read the bot timelines a minute ahead and see every bot
  // finish at once. The room stamps `serverNow` on each message the runner
  // takes race time from. A stamp left the server a network hop before it
  // arrived, so each sample undershoots by that hop: the largest is the best
  // estimate, and one late delivery cannot drag the bots backwards.
  let clockOffsetMs = null;
  function observeServerClock(serverNow) {
    if (!Number.isFinite(serverNow)) return;
    const sample = serverNow - Date.now();
    if (clockOffsetMs == null || sample > clockOffsetMs) clockOffsetMs = sample;
  }
  observeServerClock(initialState.serverNow);

  // Time since the race started, on the room's clock as best this browser
  // can tell. Callers check `raceStartedAtMs` first.
  function raceElapsedMs() {
    return Date.now() + (clockOffsetMs ?? 0) - raceStartedAtMs;
  }

  // Bot timeline state (public mode only)
  let botTimelines = null;
  let botRafId = null;

  // Move every bot to where its timeline puts it at `elapsed` and hand back the
  // ones that moved. Mutating and announcing are separate because a bot's
  // progress only exists on the client: the room keeps every bot row at score 0
  // until it finalizes them, so a snapshot replay has to catch them up from the
  // timelines before it paints anything that ranks the racers against them.
  function catchUpBots(elapsed) {
    const moved = [];
    if (!botTimelines) return moved;
    for (let i = 0; i < botTimelines.length; i++) {
      const bot = racers.find((r) => r.id === `bot-${i + 1}`);
      if (!bot || bot.finishMs != null || bot.dropped || bot.dnf) continue;
      const newScore = scoreBotAt(botTimelines[i], elapsed);
      if (newScore === bot.score) continue;
      bot.score = newScore;
      if (newScore >= raceLength) bot.finishMs = botTimelines[i][raceLength - 1];
      moved.push(bot);
    }
    return moved;
  }

  function botStillRunning() {
    return botTimelines.some((_, i) => {
      const bot = racers.find((r) => r.id === `bot-${i + 1}`);
      return bot && bot.finishMs == null && !bot.dropped && !bot.dnf;
    });
  }

  function tickBots() {
    if (!botTimelines || stopped) return;
    for (const bot of catchUpBots(raceElapsedMs())) {
      emit('advance', { laneId: bot.id, score: bot.score, finishMs: bot.finishMs });
    }
    if (botStillRunning() && !stopped) {
      botRafId = requestAnimationFrame(tickBots);
    }
  }

  function emit(event, data) {
    if (stopped) return;
    for (const l of listeners) l(event, data);
  }

  function currentProblemFor(laneId) {
    const r = racers.find((x) => x.id === laneId);
    return r ? sequence[r.score] ?? null : null;
  }

  // `bot-timelines` is sent once, so a client that arrives afterwards only ever
  // learns them from a snapshot. First set wins: the local ticker is already
  // driving the bot scores off it.
  function adoptBotTimelines(timelines) {
    if (!timelines?.length || botTimelines) return;
    botTimelines = timelines;
    if (botRafId) cancelAnimationFrame(botRafId);
    botRafId = requestAnimationFrame(tickBots);
  }

  // The race screen opens with input disabled, every car at 0 and the score at
  // 0/N; 'start' is what unlocks it and 'advance' is what moves a car. A racer
  // who reloads mid-race therefore needs both replayed from the snapshot, or
  // they land on a live race they cannot type into with everyone at the line.
  // Bots are part of that world and are not in the snapshot at all, so they are
  // caught up first and then replayed alongside everyone else.
  //
  // `dropped` has to be replayed too, and it is the one field that gates the
  // start: a seat the room dropped (reconnect grace expired, or they quit) is
  // kept in `state.players` so the race can still record a DNF, and both
  // `submitAnswer` and the server ignore its answers. Enabling the input for
  // one would hand back a box where typing does nothing at all.
  function deliverStart() {
    if (startDelivered) return;
    startDelivered = true;
    if (raceStartedAtMs != null) catchUpBots(raceElapsedMs());
    const me = racers.find((r) => r.id === PLAYER_ALIAS);
    if (!me?.dropped) emit('start', { problem: currentProblemFor(PLAYER_ALIAS) });
    for (const r of racers) {
      if (r.score > 0 || r.finishMs != null) {
        emit('advance', { laneId: r.id, score: r.score, finishMs: r.finishMs });
      }
      if (r.dropped) emit('drop', { laneId: r.id });
    }
  }

  // Idempotent: whichever arrives first — the one-shot `race-start` push or a
  // snapshot that already says `racing` — starts the race exactly once.
  function beginRace() {
    if (raceStarted) return;
    raceStarted = true;
    deliverStart();
  }

  // Apply an authoritative snapshot to the local racers and hand back the ones
  // whose painted state moved. The server is allowed to contradict us: a score
  // it never received rolls back, and a finish it never acknowledged is revoked
  // by a null. Bots are the one exception — the room parks them at 0 until it
  // finalizes them, so their progress lives only here.
  function reconcilePlayers(players, roomState) {
    // Additions to the roster stop when the room stops gathering players for a
    // race this runner has not begun. Past that — a countdown that has handed
    // off, a race in flight, a `finished` snapshot carrying somebody who took
    // the invite link after the race ended — an unknown seat has no lane and no
    // car on the mounted screen, and rankRacers would tier it above the
    // player's own dnf row on the podium it draws. Only that direction: nothing
    // here removes a seat the room spliced out of its own player list.
    const rosterOpen = !raceStarted && roomState === 'lobby';
    const changed = [];
    for (const p of players ?? []) {
      const aliased = aliasId(p.id, youAre);
      const existing = racers.find((r) => r.id === aliased);
      if (!existing) {
        if (rosterOpen) racers.push(toRacer(p, youAre));
        continue;
      }
      const before = { score: existing.score, finishMs: existing.finishMs, dropped: existing.dropped };
      existing.handle = displayHandle(p.handle, !!p.isGuest);
      if (existing.isBot) {
        if (p.finishMs != null) existing.finishMs = p.finishMs;
      } else {
        if (p.score != null) existing.score = p.score;
        existing.finishMs = p.finishMs ?? null;
      }
      existing.dropped = !!p.dropped;
      existing.dnf = !!p.dnf;
      if (
        existing.score !== before.score
        || existing.finishMs !== before.finishMs
        || existing.dropped !== before.dropped
      ) changed.push(existing);
    }
    return changed;
  }

  // The room's own final rows for the bots, off a `finished` snapshot. The
  // room strips bots from `state.players` as it ends a Quick Match, so these
  // ride on `lastRace` instead; they are what the `finish` broadcast ranked,
  // and they replace whatever the local ticker made of the timelines while
  // this socket was away — a bot it carried over the line after the race had
  // already ended included. Applied verbatim, as the `finish` path does.
  function adoptFinalBotRows(rows) {
    const changed = [];
    for (const row of rows ?? []) {
      const bot = findRacer(row.id);
      if (!bot?.isBot) continue;
      const before = { score: bot.score, finishMs: bot.finishMs, dropped: bot.dropped };
      bot.score = row.score ?? 0;
      bot.finishMs = row.finishMs ?? null;
      bot.dropped = !!row.dropped;
      bot.dnf = !!row.dnf;
      if (
        bot.score !== before.score
        || bot.finishMs !== before.finishMs
        || bot.dropped !== before.dropped
      ) changed.push(bot);
    }
    return changed;
  }

  function announce(changed) {
    for (const r of changed) {
      emit('advance', { laneId: r.id, score: r.score, finishMs: r.finishMs });
      if (r.dropped) emit('drop', { laneId: r.id });
    }
  }

  // The terminal transition, delivered exactly once however it is learned: the
  // `finish` broadcast, or a `finished` snapshot for a socket that missed it.
  // Rankings come from the local racers, never from the snapshot's player list:
  // PublicRaceRoom strips bots and departed seats from `state.players` as it
  // ends the race, so that list is not the podium. Bots are absent from it
  // entirely and their progress is client-driven, so the race end has to stop
  // them here: the ticker is cancelled, and a bot still short of the line is a
  // dnf rather than a row that keeps crossing it over the results screen.
  //
  // On the `finish` path that loop is a no-op — the payload has already said
  // so — and on the snapshot path it is too, whenever the snapshot carries the
  // room's final bot rows (see adoptFinalBotRows). It still matters against a
  // room that predates those rows: there a bot the local ticker carried over
  // the line while the socket was down keeps its client-side finish, because
  // nothing else here can contradict it.
  function settleRace() {
    if (raceSettled) return;
    raceSettled = true;
    raceStarted = true;
    if (botRafId) { cancelAnimationFrame(botRafId); botRafId = null; }
    for (const r of racers) {
      if (r.isBot && r.finishMs == null && !r.dropped) r.dnf = true;
    }
    emit('finish', { rankings: getRankings() });
  }

  function findRacer(serverPlayerId) {
    const aliased = aliasId(serverPlayerId, youAre);
    return racers.find((r) => r.id === aliased);
  }

  function getRankings() {
    return rankRacers(racers);
  }

  const unsubscribe = roomClient.on((msg) => {
    if (stopped) return;

    switch (msg.type) {
      case 'state': {
        // A snapshot is the authority on everyone the room counts. Reconcile the
        // model *and* say what changed: once the race screen is mounted it paints
        // from events, so a silent mutation leaves a stale screen — the score, the
        // cars, the lanes and the banner all keep whatever the last event said.
        // Whether the screen was already painted *before* this snapshot: if the
        // snapshot is itself what starts the race, `deliverStart` replays the
        // whole world below and announcing again would double every event.
        const wasMounted = startDelivered;
        observeServerClock(msg.state.serverNow);
        const changed = reconcilePlayers(msg.state.players, msg.state.state);
        if (msg.state.state === 'finished' && !raceSettled) {
          changed.push(...adoptFinalBotRows(msg.state.lastRace?.botRows));
        }
        if (msg.state.problemSequence?.length) sequence = msg.state.problemSequence;
        // Replay countdown if we joined mid-countdown and haven't seen a countdown event yet.
        if (msg.state.state === 'countdown' && msg.state.countdownN != null && lastCountdownN == null) {
          lastCountdownN = msg.state.countdownN;
          emit('countdown', { n: msg.state.countdownN });
        }
        // Reconnect bootstrap. Both `race-start` and `bot-timelines` are sent
        // once, at the countdown→racing transition; a client that joins or
        // reconnects after it gets a snapshot, never a replay. So the snapshot
        // has to do their job: adopt the shared race clock, pick up the bot
        // timelines (without this all bots stay frozen at 0), and start the
        // race — which is what enables the answer input.
        if (msg.state.state === 'racing') {
          if (msg.state.raceStartedAt) raceStartedAtMs = msg.state.raceStartedAt;
          adoptBotTimelines(msg.state.botTimelines);
          beginRace();
        }
        // `beginRace` replays everything itself on its first delivery. Past that
        // the runner is already mounted — an auto-reconnect reuses it — so the
        // snapshot's own corrections are what the screen has not seen yet.
        if (wasMounted) announce(changed);
        // The room can also end while this socket is away: the one-shot `finish`
        // is not replayed, so a `finished` snapshot has to settle the race.
        if (msg.state.state === 'finished') settleRace();
        break;
      }
      case 'countdown': {
        lastCountdownN = msg.n;
        emit('countdown', { n: msg.n });
        break;
      }
      case 'race-start': {
        observeServerClock(msg.serverNow);
        sequence = msg.sequence;
        raceStartedAtMs = msg.raceStartedAt;
        beginRace();
        break;
      }
      case 'bot-timelines': {
        // Public-mode only: server sends this right after race-start with precomputed timelines.
        botTimelines = msg.botTimelines;
        observeServerClock(msg.serverNow);
        if (msg.raceStartedAt) raceStartedAtMs = msg.raceStartedAt;
        if (botRafId) cancelAnimationFrame(botRafId);
        botRafId = requestAnimationFrame(tickBots);
        break;
      }
      case 'advance': {
        const r = findRacer(msg.playerId);
        if (!r) break;
        // Mostly the server's echo of what submitAnswer already applied
        // optimistically, and suppressed as such. Two things still come back
        // from the server: a score it is ahead on (a dropped optimistic
        // frame), and `finishMs` — which is the only finish time here measured
        // on the room's clock. The optimistic one is only this browser's
        // estimate of that clock (see observeServerClock), a network hop out
        // at best, and it is ranked against opponents' times the room stamped
        // itself.
        if (r.id === PLAYER_ALIAS) {
          const ahead = msg.score > r.score;
          const restamped = msg.finishMs != null && msg.finishMs !== r.finishMs;
          if (!ahead && !restamped) break;
          if (ahead) r.score = msg.score;
          if (msg.finishMs != null) r.finishMs = msg.finishMs;
          emit('advance', { laneId: r.id, score: r.score, finishMs: r.finishMs });
          if (ahead) {
            const next = sequence[r.score] ?? null;
            if (next) emit('problem', { problem: next });
          }
          break;
        }
        // Opponents: update from server.
        r.score = msg.score;
        if (msg.finishMs != null) r.finishMs = msg.finishMs;
        emit('advance', { laneId: r.id, score: r.score, finishMs: r.finishMs });
        break;
      }
      case 'wrong': {
        // Local player's wrong was already shown optimistically; suppress.
        // Opponents' wrong answers don't shake anyone's input by design.
        break;
      }
      case 'drop': {
        const r = findRacer(msg.playerId);
        if (!r) break;
        r.dropped = true;
        emit('drop', { laneId: r.id });
        break;
      }
      case 'finish': {
        // Sync ranking-relevant fields from server payload.
        for (const sp of msg.rankings) {
          const r = findRacer(sp.id);
          if (!r) continue;
          r.score = sp.score;
          r.finishMs = sp.finishMs;
          r.dropped = !!sp.dropped;
          r.dnf = !!sp.dnf;
        }
        settleRace();
        break;
      }
    }
  });

  // Reconnect/mid-race join: the handoff in lobby.js builds this runner from an
  // already-`racing` snapshot, so neither `race-start` nor `bot-timelines` is
  // still coming. The race screen is attached a moment later, so the start
  // waits for it; the bot ticker does not, and its first frame is async anyway.
  if (initialState.state === 'racing') {
    raceStarted = true;
    adoptBotTimelines(initialState.botTimelines);
  }

  return {
    racers,
    // A getter, not a copy: a snapshot or `race-start` replaces the sequence
    // wholesale, and a value captured here would keep serving the one this
    // runner was built with.
    get sequence() { return sequence; },
    raceLength,
    getRankings,
    on(handler) {
      listeners.add(handler);
      // Pay a start owed from before anybody was listening (see deliverStart).
      if (raceStarted) deliverStart();
      return () => listeners.delete(handler);
    },
    start() { /* no-op; server drives countdown */ },
    submitAnswer(raw) {
      // The race is over: the room ignores answers past its own finish, so
      // scoring one locally would only invent progress the server will deny.
      if (raceSettled) return { correct: true };
      // Always relay to server; server is the source of truth.
      roomClient.send({ type: 'answer', value: raw });
      // Optimistic local update — your own car moves on press, no waiting on
      // the server round-trip. Server's later `advance`/`wrong` for self is
      // suppressed unless server's score gets ahead of ours (rare).
      const me = racers.find((r) => r.id === PLAYER_ALIAS);
      if (!me || me.dropped || me.score >= raceLength) return { correct: true };
      const problem = sequence[me.score];
      if (!problem) return { correct: true };
      if (validateAnswer(problem, raw)) {
        me.score += 1;
        // Provisional, and only an estimate of the room's clock: the room
        // restamps it on its own the moment its `advance` echoes back.
        if (me.score >= raceLength && me.finishMs == null && raceStartedAtMs != null) {
          me.finishMs = raceElapsedMs();
        }
        emit('advance', { laneId: me.id, score: me.score, finishMs: me.finishMs });
        const next = sequence[me.score] ?? null;
        if (next) emit('problem', { problem: next });
        return { correct: true };
      }
      emit('wrong', { laneId: me.id });
      return { correct: false };
    },
    currentProblemFor,
    getState() {
      if (raceSettled) return 'finished';
      return raceStarted ? 'racing' : 'idle';
    },
    quit() {
      roomClient.send({ type: 'quit' });
      if (typeof onLocalQuit === 'function') onLocalQuit();
    },
    stop() {
      stopped = true;
      if (botRafId) { cancelAnimationFrame(botRafId); botRafId = null; }
      unsubscribe();
    },
  };
}
