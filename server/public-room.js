// PublicRaceRoom — public quickmatch race room.
// Extends RaceRoom and overrides behavior per docs/superpowers/specs/2026-06-04-matchmaking-design.md §4.2.
//
// Key differences vs RaceRoom:
//   - No "creator" concept; manual start, set-config, and rematch are all disabled.
//   - Difficulty locks at first hello; mismatched difficulty on later hellos is rejected.
//   - Auto-start timer fires the race after a configurable countdown.
//   - Remaining seats filled with bots; bot timelines are precomputed (no per-tick alarms).

import { RaceRoom, freshState as baseFreshState } from './room.js';
import { MAX_PLAYERS } from '../public/src/auto-start.js';

export class PublicRaceRoom extends RaceRoom {
  static options = { hibernate: true };

  freshState(id) {
    return publicFreshState(id);
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
