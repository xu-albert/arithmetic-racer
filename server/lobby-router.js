// LobbyRouter — one DO instance per difficulty (named via idFromName).
// Holds the "currently open public room" pointer. Atomic single-writer.
//
// Lifecycle:
//   - Worker route calls pick(difficulty) → returns existing currentRoomId
//     or mints a new prefixed one ('e-...', 'm-...', 'h-...'). The prefix
//     lets PublicRaceRoom derive difficulty from its own DO name instead
//     of trusting the client's hello — closes the difficulty-hijack vector.
//   - PublicRaceRoom calls release(roomId) when the room locks (6 players) or
//     when it auto-starts. Idempotent if currentRoomId no longer matches.

import { DurableObject } from "cloudflare:workers";
import { generateRoomId } from "./room-id.js";

const DIFFICULTY_PREFIX = { easy: "e", medium: "m", hard: "h" };

export const DIFFICULTY_BY_PREFIX = { e: "easy", m: "medium", h: "hard" };

/**
 * Parse a public room name like "m-swift-koala-wombat" and return the
 * difficulty string, or null if the prefix is unrecognized.
 */
export function difficultyFromRoomName(name) {
  if (typeof name !== "string" || name.length < 2 || name[1] !== "-") return null;
  return DIFFICULTY_BY_PREFIX[name[0]] ?? null;
}

export class LobbyRouter extends DurableObject {
  async pick(difficulty) {
    const prefix = DIFFICULTY_PREFIX[difficulty];
    if (!prefix) throw new Error(`LobbyRouter.pick: unknown difficulty ${difficulty}`);
    let currentRoomId = await this.ctx.storage.get("currentRoomId");
    if (!currentRoomId) {
      currentRoomId = `${prefix}-${generateRoomId()}`;
      await this.ctx.storage.put("currentRoomId", currentRoomId);
    }
    return { roomId: currentRoomId };
  }

  async release(roomId) {
    const current = await this.ctx.storage.get("currentRoomId");
    if (current === roomId) {
      await this.ctx.storage.delete("currentRoomId");
    }
  }
}
