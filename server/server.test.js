// The trusted-identity header gate on party routes.
//
// server/server.js stamps (or deletes) x-arithmetic-user-id on requests bound
// for room Durable Objects, so a client-supplied header can never attribute
// race rows to an account the client doesn't control. partyserver tolerates
// duplicate slashes and routes /parties//race-room/<name> to the same room DO
// as the canonical path, so a gate that matches exact prefixes lets a forged
// header through on those non-canonical paths. These tests drive the real
// Worker entry (SELF.fetch) and read the seat the room actually assigns, so
// they cover every path form that can reach a room DO.

import { describe, it, expect, afterEach } from "vitest";
import { env, SELF, runInDurableObject } from "cloudflare:test";
import { _setTestUserId } from "../worker/session.js";

function tick(ms = 5) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * WS upgrade through the Worker entry, then hello, then read the userId the
 * room stamped on the seat from the header the Worker forwarded.
 */
async function seatedUserId(pathname, { header, sessionUserId }) {
  _setTestUserId(sessionUserId ?? null);
  try {
    // Public rooms derive difficulty from an e-/m-/h- name prefix (lobby-router
    // mints them); a name without the prefix gets BAD_ROOM_ID at hello.
    const name = pathname.includes("public-race-room")
      ? `e-${crypto.randomUUID()}`
      : `gate-${crypto.randomUUID()}`;
    const res = await SELF.fetch(`https://gate.test${pathname.replace("<name>", name)}`, {
      headers: {
        Upgrade: "websocket",
        ...(header ? { "x-arithmetic-user-id": header } : {}),
      },
    });
    expect(res.status).toBe(101);
    const ws = res.webSocket;
    ws.accept();
    const inbox = [];
    ws.addEventListener("message", (e) => inbox.push(JSON.parse(e.data)));
    ws.send(JSON.stringify({
      type: "hello",
      playerId: crypto.randomUUID(),
      handle: "GateTest",
      deviceId: "gate-device",
    }));

    const binding = pathname.includes("public-race-room") ? env.PublicRaceRoom : env.RaceRoom;
    const stub = binding.get(binding.idFromName(name));
    const deadline = Date.now() + 4000;
    let seat = null;
    while (Date.now() < deadline) {
      seat = await runInDurableObject(stub, async (room) => {
        if (!room.state) await room.onStart();
        return room.state.players.length > 0 ? room.state.players[0].userId : undefined;
      });
      if (seat !== undefined) break;
      await tick();
    }
    if (seat === undefined) {
      throw new Error(`seat never appeared; saw ${JSON.stringify(inbox.map((m) => m.type))}`);
    }
    ws.close();
    return seat;
  } finally {
    _setTestUserId(null);
  }
}

afterEach(() => {
  _setTestUserId(null);
});

describe("party-route identity stamping", () => {
  it("strips a forged header on the canonical private-room route", async () => {
    expect(await seatedUserId("/parties/race-room/<name>", {
      header: "forged-user-without-session",
    })).toBeNull();
  });

  it("strips a forged header on a duplicate-slash private-room route", async () => {
    expect(await seatedUserId("/parties//race-room/<name>", {
      header: "forged-user-without-session",
    })).toBeNull();
  });

  it("strips a forged header on a duplicate-slash public-room route", async () => {
    expect(await seatedUserId("/parties//public-race-room/<name>", {
      header: "forged-user-without-session",
    })).toBeNull();
  });

  it("strips a forged header on a multi-slash route with a signed-in user absent", async () => {
    expect(await seatedUserId("/parties///race-room/<name>", {
      header: "forged-user-without-session",
    })).toBeNull();
  });

  it("overwrites a forged header with the session user on a duplicate-slash route", async () => {
    expect(await seatedUserId("/parties//race-room/<name>", {
      header: "forged-user-without-session",
      sessionUserId: "real-session-user",
    })).toBe("real-session-user");
  });

  it("overwrites a forged header with the session user on the canonical route", async () => {
    expect(await seatedUserId("/parties/race-room/<name>", {
      header: "forged-user-without-session",
      sessionUserId: "real-session-user",
    })).toBe("real-session-user");
  });
});
