// PublicRaceRoom — public quickmatch race room.
// Extends RaceRoom and overrides behavior per docs/superpowers/specs/2026-06-04-matchmaking-design.md §4.2.
//
// Key differences vs RaceRoom:
//   - No "creator" concept; manual start, set-config, and rematch are all disabled.
//   - Difficulty locks at first hello; mismatched difficulty on later hellos is rejected.
//   - Auto-start timer fires the race after a configurable countdown.
//   - Remaining seats filled with bots; bot timelines are precomputed (no per-tick alarms).

import { RaceRoom, freshState as baseFreshState, IDLE_CLEANUP_MS, COUNTDOWN_SECONDS, rankPlayers } from './room.js';
import { MAX_PLAYERS, computeAutoStartDeadline } from '../public/src/auto-start.js';
import { pickBotTiers } from '../public/src/bot.js';
import { computeBotTimelines, scoreBotAt } from '../public/src/bot-timeline.js';
import { seededRng } from '../public/src/seeded-rng.js';
import { generateSequence } from '../public/src/game.js';

const VALID_DIFFICULTIES = new Set(['easy', 'medium', 'hard']);

export class PublicRaceRoom extends RaceRoom {
  static options = { hibernate: true };

  freshState(id) {
    return publicFreshState(id);
  }

  async handleHello(connection, msg) {
    if (!VALID_DIFFICULTIES.has(msg?.difficulty)) {
      return this.sendError(connection, 'INVALID_INPUT', 'Missing or invalid difficulty');
    }
    if (this.state.difficulty == null) {
      this.state.difficulty = msg.difficulty;
    } else if (this.state.difficulty !== msg.difficulty) {
      return this.sendError(connection, 'BAD_DIFFICULTY',
        `This room is locked to difficulty=${this.state.difficulty}`);
    }

    // Delegate to base: handle generation, player insertion, broadcast, persist.
    await super.handleHello(connection, msg);

    if (this.state.state !== 'lobby') return;

    const { deadline, gatherTriggered } = computeAutoStartDeadline({
      playerCount: this.state.players.length,
      gatherTriggered: this.state.gatherTriggered,
      now: Date.now(),
    });
    if (deadline != null) {
      this.state.autoStartDeadline = deadline;
      this.state.gatherTriggered = gatherTriggered;
    }

    if (this.state.players.length === MAX_PLAYERS) {
      await this.releaseLobby();
    }

    await this.persist();
    await this.scheduleNextAlarm();
  }

  synthHandle(tier, n) {
    return `Bot-${tier}-${n}`;
  }

  async onAlarm() {
    const now = Date.now();
    const wasLobby = this.state.state === 'lobby';
    const wasCountdown = this.state.state === 'countdown';

    // 1) Auto-start sequence: fire if deadline elapsed in lobby.
    if (wasLobby && this.state.autoStartDeadline != null && this.state.autoStartDeadline <= now) {
      await this.runAutoStart();
      // Fall through to base onAlarm so countdown ticks can begin firing.
    }

    await super.onAlarm();

    // 2) On countdown→racing transition, compute bot timelines once.
    if (wasCountdown && this.state.state === 'racing' && this.state.botTimelines.length === 0) {
      this.state.botTimelines = computeBotTimelines({
        botSeed: this.state.botSeed,
        botTiers: this.state.botTiers,
        difficulty: this.state.difficulty,
        raceLength: this.state.raceLength,
      });
      await this.persist();
    }
  }

  async runAutoStart() {
    // Idempotent router release.
    if (this.state.difficulty) await this.releaseLobby();

    const humanCount = this.state.players.length;
    const botCount = Math.max(0, MAX_PLAYERS - humanCount);
    this.state.botSeed = (Math.random() * 0xFFFFFFFF) >>> 0;
    this.state.botTiers = pickBotTiers(this.state.difficulty, botCount, seededRng(this.state.botSeed));

    for (let i = 0; i < botCount; i++) {
      const tier = this.state.botTiers[i];
      this.state.players.push({
        id: `bot-${i + 1}`,
        handle: this.synthHandle(tier, i + 1),
        isCreator: false,
        isBot: true,
        tier,
        joinedAt: Date.now(),
        score: 0,
        finishMs: null,
        dropped: false,
        dnf: false,
      });
    }

    // Transition to countdown — mirrors base handleStartRace's tail.
    const seed = (Date.now() & 0xffffffff) >>> 0;
    this.state.problemSequence = generateSequence(this.state.difficulty, this.state.raceLength, seed);
    this.state.state = 'countdown';
    this.state.countdownN = COUNTDOWN_SECONDS;
    this.state.countdownAt = Date.now();
    this.state.autoStartDeadline = null;
    this.state.gatherTriggered = false;

    await this.persist();
    this.broadcastState();
  }

  finishRace(raceEndOffsetMs) {
    if (this.state.state === 'finished') return;

    const raceEnd = raceEndOffsetMs ?? (Date.now() - this.state.raceStartedAt);

    // Finalize bot scores from timelines.
    const bots = this.state.players.filter((p) => p.isBot);
    for (let i = 0; i < bots.length; i++) {
      const tl = this.state.botTimelines[i];
      if (!tl) continue;
      const score = scoreBotAt(tl, raceEnd);
      bots[i].score = score;
      if (score >= this.state.raceLength) {
        bots[i].finishMs = tl[this.state.raceLength - 1];
        bots[i].dnf = false;
      } else {
        bots[i].finishMs = null;
        bots[i].dnf = true;
      }
    }

    // Mark unfinished humans as DNF (mirror base finishRace semantics).
    for (const p of this.state.players) {
      if (!p.isBot && !p.dropped && p.finishMs == null) p.dnf = true;
    }

    this.state.state = 'finished';
    this.state.graceDeadline = null;
    const rankings = rankPlayers(this.state.players);
    this.broadcast(JSON.stringify({ type: 'finish', rankings }));
  }

  isRaceComplete() {
    const humans = this.state.players.filter((p) => !p.isBot);
    if (humans.length === 0) return true;
    return humans.every((p) => p.dropped || p.score >= this.state.raceLength);
  }

  async handleStartRace(connection) {
    return this.sendError(connection, 'BAD_STATE', 'Public races auto-start; manual start not allowed');
  }

  async handleSetConfig(connection /* , msg */) {
    return this.sendError(connection, 'BAD_STATE', 'Public room config is locked');
  }

  async handleRematch(connection) {
    return this.sendError(connection, 'BAD_STATE', 'Public rooms are single-shot; queue again for a new match');
  }

  async removePlayer(playerId) {
    const idx = this.state.players.findIndex((p) => p.id === playerId);
    if (idx < 0) return false;

    this.state.players.splice(idx, 1);
    delete this.state.disconnectDeadlines[playerId];
    this.broadcast(JSON.stringify({ type: 'player-left', playerId }));

    // Mid-race: treat removed unfinished player as drop for ranking.
    if (this.state.state === 'racing') {
      if (this.isRaceComplete() || this.state.players.length === 0) this.finishRace();
    }

    // If we emptied the lobby, release the router slot.
    if (this.state.players.length === 0 && this.state.state === 'lobby') {
      this.state.autoStartDeadline = null;
      this.state.gatherTriggered = false;
      if (this.state.difficulty) await this.releaseLobby();
      this.state.idleCleanupAt = Date.now() + IDLE_CLEANUP_MS;
    }

    return true;
  }

  extraAlarmDeadlines() {
    return [this.state.autoStartDeadline];
  }

  async releaseLobby() {
    try {
      const stub = this.env.LobbyRouter.get(this.env.LobbyRouter.idFromName(this.state.difficulty));
      await stub.release(this.name);
    } catch (e) {
      console.error('LobbyRouter.release failed', e);
    }
  }
}

export function publicFreshState(id) {
  return {
    ...baseFreshState(id),
    mode: 'public',
    maxPlayers: MAX_PLAYERS,
    difficulty: null,
    autoStartDeadline: null,
    gatherTriggered: false,
    botSeed: null,
    botTiers: [],
    botTimelines: [],
  };
}
