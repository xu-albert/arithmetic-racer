// LobbyRouter — one DO instance per difficulty (named via idFromName).
// Holds the "currently open public room" pointer. Atomic single-writer.
//
// Lifecycle:
//   - Worker route calls pick() → returns existing currentRoomId or mints one.
//   - PublicRaceRoom calls release(roomId) when the room locks (6 players) or
//     when it auto-starts. Idempotent if currentRoomId no longer matches.

import { DurableObject } from "cloudflare:workers";
import { generateRoomId } from "./room-id.js";

export class LobbyRouter extends DurableObject {
  async pick() {
    let currentRoomId = await this.ctx.storage.get("currentRoomId");
    if (!currentRoomId) {
      currentRoomId = generateRoomId();
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
