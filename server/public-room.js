// PublicRaceRoom — public quickmatch race room.
// Extends RaceRoom and overrides behavior per docs/superpowers/specs/2026-06-04-matchmaking-design.md §4.2.
//
// Key differences vs RaceRoom:
//   - No "creator" concept; manual start, set-config, and rematch are all disabled.
//   - Difficulty locks at first hello; mismatched difficulty on later hellos is rejected.
//   - Auto-start timer fires the race after a configurable countdown.
//   - Remaining seats filled with bots; bot timelines are precomputed (no per-tick alarms).

import { RaceRoom, freshState as baseFreshState, IDLE_CLEANUP_MS } from './room.js';
import { MAX_PLAYERS, computeAutoStartDeadline } from '../public/src/auto-start.js';

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
