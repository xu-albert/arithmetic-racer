import { describe, it, expect } from "vitest";
import { env, SELF, runInDurableObject } from "cloudflare:test";
import { issueAdmissionPass } from "./admission-pass.js";
import { EXPIRED_ROOM_TTL_MS } from "./room.js";
import {
  EXPIRED_ROOM_STATE, ROOM_EXPIRED_TYPE, INVITE_EXPIRED_REASON, INVITE_INVALID_REASON,
} from "../public/src/room-expiry.js";

const MINUTE = 60 * 1000;
const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

const privateRoom = (name) => env.RaceRoom.get(env.RaceRoom.idFromName(name));
const publicRoom = (name) => env.PublicRaceRoom.get(env.PublicRaceRoom.idFromName(name));

/** A pass for `name` issued `ageMs` ago; past ADMISSION_PASS_TTL_MS it is stale. */
const passAged = (name, mode, ageMs) => issueAdmissionPass(env, name, mode, Date.now() - ageMs);

/**
 * Runs a rate-limit flood inside one limiter window. The local ratelimit
 * simulator buckets by `floor(now / period)`, so a flood that straddles a
 * minute boundary sees its counter reset partway; when that happens the flood
 * is re-run once on a fresh key (`attempt` picks the address), which a 60s
 * window cannot cross twice in a test's span.
 */
async function inOneWindow(flood) {
  for (let attempt = 0; ; attempt++) {
    const epoch = Math.floor(Date.now() / MINUTE);
    const result = await flood(attempt);
    if (Math.floor(Date.now() / MINUTE) === epoch || attempt > 0) return result;
  }
}

const partyUrl = (party, roomId, admission) =>
  `https://admission.test/parties/${party}/${roomId}${admission ? `?admission=${encodeURIComponent(admission)}` : ""}`;

async function open(party, roomId, admission) {
  const res = await SELF.fetch(partyUrl(party, roomId, admission), { headers: { Upgrade: "websocket" } });
  expect(res.status).toBe(101);
  const ws = res.webSocket;
  const messages = [];
  let closed = false;
  ws.addEventListener("message", (event) => messages.push(JSON.parse(event.data)));
  ws.addEventListener("close", () => { closed = true; });
  ws.accept();
  return {
    messages,
    get closed() { return closed; },
    hello(handle, racerId = crypto.randomUUID()) {
      ws.send(JSON.stringify({ type: "hello", playerId: racerId, handle, deviceId: crypto.randomUUID() }));
    },
    async wait(predicate) {
      const deadline = Date.now() + 3000;
      while (Date.now() < deadline) {
        const found = messages.find(predicate);
        if (found) return found;
        await tick(5);
      }
      throw new Error(`timed out; saw ${JSON.stringify(messages.map((m) => m.type))}`);
    },
    close() {
      try { ws.close(); } catch { /* already closed */ }
    },
  };
}

/** Refused, told why, and closed — by default before the room ever ran. */
async function expectRefused(client, roomId, reason, { atHello = false } = {}) {
  const refusal = await client.wait((m) => m.type === ROOM_EXPIRED_TYPE);
  expect(refusal).toEqual({ type: ROOM_EXPIRED_TYPE, reason, roomId });
  for (let i = 0; i < 100 && !client.closed; i++) await tick(5);
  expect(client.closed).toBe(true);
  expect(client.messages.some((m) => m.type === "state")).toBe(atHello);
  expect(client.messages.some((m) => m.type === "hello-ack")).toBe(false);
}

async function storedState(stub) {
  return runInDurableObject(stub, (_room, state) => state.storage.get("state"));
}

describe("nothing without a pass creates a room or takes a new seat", () => {
  it("refuses a pass-less socket to a room that does not exist, and leaves the name unminted", async () => {
    const name = `adm-nopass-${crypto.randomUUID()}`;
    await expectRefused(await open("race-room", name), name, INVITE_EXPIRED_REASON);
    // Nothing was written under the name, so a real creation still gets it.
    expect(await privateRoom(name).reserveRoomName()).toBe(true);
  });

  it("refuses a plain request without a pass before the room can mint state", async () => {
    const name = `adm-get-${crypto.randomUUID()}`;
    expect((await SELF.fetch(partyUrl("race-room", name))).status).toBe(403);
    expect(await privateRoom(name).reserveRoomName()).toBe(true);
  });

  it("never creates a public room at a name the matchmaker did not hand out", async () => {
    const name = `m-adm-${crypto.randomUUID()}`;
    expect((await SELF.fetch(partyUrl("public-race-room", name))).status).toBe(403);
    await expectRefused(await open("public-race-room", name), name, INVITE_EXPIRED_REASON);
    // A private pass for the same name is the wrong mode: no pass at all.
    const privatePass = await issueAdmissionPass(env, name, "private");
    await expectRefused(await open("public-race-room", name, privatePass), name, INVITE_EXPIRED_REASON);
    expect(await storedState(publicRoom(name))).toBeUndefined();
  });

  it("refuses a new entrant with no pass for the room at hello, even while it is live", async () => {
    const name = `adm-other-${crypto.randomUUID()}`;
    expect(await privateRoom(name).reserveRoomName()).toBe(true);
    const host = await open("race-room", name, await issueAdmissionPass(env, name, "private"));
    host.hello("Host");
    await host.wait((m) => m.type === "hello-ack");

    const elsewhere = await issueAdmissionPass(env, `adm-elsewhere-${crypto.randomUUID()}`, "private");
    for (const admission of [elsewhere, undefined]) {
      const stranger = await open("race-room", name, admission);
      await stranger.wait((m) => m.type === "state");
      stranger.hello("Stranger");
      await expectRefused(stranger, name, INVITE_INVALID_REASON, { atHello: true });
    }
    await runInDurableObject(privateRoom(name), async (room) => {
      expect(room.state.players.map((p) => p.handle)).toEqual(["Host"]);
    });
    host.close();
  });

  it("does not let a pass-less socket keep a room nobody has joined alive", async () => {
    const name = `adm-unjoined-${crypto.randomUUID()}`;
    expect(await privateRoom(name).reserveRoomName()).toBe(true);
    const before = (await storedState(privateRoom(name))).lastActivityAt;
    await tick(5);
    await expectRefused(await open("race-room", name), name, INVITE_INVALID_REASON);
    const after = await storedState(privateRoom(name));
    expect(after.unjoined).toBe(true);
    expect(after.lastActivityAt).toBe(before);
  });

  it("refuses any other routable party outright", async () => {
    const pass = await issueAdmissionPass(env, "medium", "private");
    expect((await SELF.fetch(partyUrl("lobby-router", "medium", pass))).status).toBe(403);
  });

  it("caps room creation attempts from one IP", async () => {
    const responses = await inOneWindow(async (attempt) => {
      const flood = [];
      for (let i = 0; i < 11; i++) {
        flood.push(await SELF.fetch("https://admission.test/api/rooms", {
          method: "POST",
          headers: { "cf-connecting-ip": `203.0.113.${77 + attempt}` },
        }));
      }
      return flood;
    });
    expect(responses.slice(0, 10).every((response) => response.status === 200)).toBe(true);
    expect(responses[10].status).toBe(429);
    expect(responses[10].headers.get("retry-after")).toBe("60");
  });

  it("caps room creation from one IPv6 /64, however its addresses rotate", async () => {
    const create = (ip) => SELF.fetch("https://admission.test/api/rooms", {
      method: "POST",
      headers: { "cf-connecting-ip": ip },
    });
    const statuses = await inOneWindow(async (attempt) => {
      const flood = [];
      for (let i = 0; i < 11; i++) flood.push((await create(`2001:db8:77:${1 + 2 * attempt}::${(i + 1).toString(16)}`)).status);
      return flood;
    });
    expect(statuses.slice(0, 10).every((status) => status === 200)).toBe(true);
    expect(statuses[10]).toBe(429);
    expect((await create("2001:db8:77:2::1")).status).toBe(200);
  });

  it("caps /parties/* requests from one IPv6 /64, however its addresses rotate", async () => {
    const { statuses, retryAfter } = await inOneWindow(async (attempt) => {
      const flood = [];
      let last;
      for (let i = 0; i < 301; i++) {
        last = await SELF.fetch(partyUrl("lobby-router", `adm-flood-${i}`), {
          headers: { "cf-connecting-ip": `2001:db8:88:${1 + 2 * attempt}::${(i + 1).toString(16)}` },
        });
        flood.push(last.status);
      }
      return { statuses: flood, retryAfter: last.headers.get("retry-after") };
    });
    expect(retryAfter).toBe("60");
    expect(statuses.slice(0, 300).every((status) => status === 403)).toBe(true);
    expect(statuses[300]).toBe(429);
    const neighbour = await SELF.fetch(partyUrl("lobby-router", "adm-flood-neighbour"), {
      headers: { "cf-connecting-ip": "2001:db8:88:2::1" },
    });
    expect(neighbour.status).toBe(403);
  }, 30_000);
});

describe("a seat is its own admission", () => {
  it("lets a seated racer reconnect with no pass at all", async () => {
    const name = `adm-seat-${crypto.randomUUID()}`;
    expect(await privateRoom(name).reserveRoomName()).toBe(true);
    const racerId = crypto.randomUUID();
    const first = await open("race-room", name, await issueAdmissionPass(env, name, "private"));
    first.hello("Host", racerId);
    const { playerId } = await first.wait((m) => m.type === "hello-ack");
    first.close();
    await tick(50);

    // What a page opened before passes existed sends after a deploy drops it:
    // the same racerId, and no admission param at all. The seat is on its
    // reconnect grace, and presenting its racerId reclaims it.
    const back = await open("race-room", name);
    back.hello("Host", racerId);
    expect((await back.wait((m) => m.type === "hello-ack")).playerId).toBe(playerId);
    await runInDurableObject(privateRoom(name), async (room) => {
      expect(room.state.players).toHaveLength(1);
      expect(room.state.disconnectDeadlines).toEqual({});
    });
    back.close();
  });
});

describe("a pass's expiry bounds only creating or reviving a room", () => {
  it("lets a 30-minute-old invite join a live room", async () => {
    const name = `adm-old-invite-${crypto.randomUUID()}`;
    expect(await privateRoom(name).reserveRoomName()).toBe(true);
    const host = await open("race-room", name, await issueAdmissionPass(env, name, "private"));
    host.hello("Host");
    await host.wait((m) => m.type === "hello-ack");

    const guest = await open("race-room", name, await passAged(name, "private", 30 * MINUTE));
    guest.hello("Guest");
    await guest.wait((m) => m.type === "hello-ack");
    await runInDurableObject(privateRoom(name), async (room) => {
      expect(room.state.players.map((p) => p.handle).sort()).toEqual(["Guest", "Host"]);
    });
    host.close();
    guest.close();
  });

  it("lets a Quick Match seat reconnect on an 11-minute-old pass", async () => {
    const name = `m-adm-${crypto.randomUUID()}`;
    const racerId = crypto.randomUUID();
    const first = await open("public-race-room", name, await issueAdmissionPass(env, name, "public"));
    first.hello("Racer", racerId);
    const { playerId } = await first.wait((m) => m.type === "hello-ack");
    first.close();
    await tick(50);

    const back = await open("public-race-room", name, await passAged(name, "public", 11 * MINUTE));
    back.hello("Racer", racerId);
    expect((await back.wait((m) => m.type === "hello-ack")).playerId).toBe(playerId);
    back.close();
  });

  it("does not let a stale pass create a room", async () => {
    const name = `adm-stale-create-${crypto.randomUUID()}`;
    const stale = await passAged(name, "private", 11 * MINUTE);
    await expectRefused(await open("race-room", name, stale), name, INVITE_EXPIRED_REASON);
    expect((await SELF.fetch(partyUrl("race-room", name, stale))).status).toBe(403);
    expect(await privateRoom(name).reserveRoomName()).toBe(true);

    const publicName = `m-adm-stale-${crypto.randomUUID()}`;
    const stalePublic = await passAged(publicName, "public", 11 * MINUTE);
    await expectRefused(await open("public-race-room", publicName, stalePublic), publicName, INVITE_EXPIRED_REASON);
    expect(await storedState(publicRoom(publicName))).toBeUndefined();
  });

  it("does not let a stale pass revive a room that is gone, though a fresh one may", async () => {
    const name = `adm-stale-revive-${crypto.randomUUID()}`;
    expect(await privateRoom(name).reserveRoomName()).toBe(true);
    await runInDurableObject(privateRoom(name), async (room) => {
      if (!room.state) await room.onStart();
      await room.expireRoom();
      // Old enough that onStart would clear the tombstone for a new room.
      room.state.expiredAt = Date.now() - EXPIRED_ROOM_TTL_MS - 1000;
      await room.persist();
    });

    const stale = await passAged(name, "private", 11 * MINUTE);
    await expectRefused(await open("race-room", name, stale), name, INVITE_EXPIRED_REASON);
    expect((await storedState(privateRoom(name))).state).toBe(EXPIRED_ROOM_STATE);

    expect((await SELF.fetch(partyUrl("race-room", name, await issueAdmissionPass(env, name, "private")))).status)
      .toBe(404);
    expect((await storedState(privateRoom(name))).state).toBe("lobby");
  });

  it("still refuses a stale pass when the room's instance carries no name of its own", async () => {
    // An alarm can wake a room on an id with no name, and every request after
    // it lands on that instance. Its name is then only partyserver's stored
    // record, which a refusal — running before partyserver initializes — has
    // to read for itself.
    const name = `adm-nameless-${crypto.randomUUID()}`;
    const nameless = env.RaceRoom.get(env.RaceRoom.idFromString(env.RaceRoom.idFromName(name).toString()));
    await runInDurableObject(nameless, async (room, state) => {
      expect(state.id.name).toBeUndefined();
      await state.storage.put({
        state: { ...room.freshState(name), state: EXPIRED_ROOM_STATE, expiredAt: Date.now(), lastActivityAt: null },
        __ps_name: name,
      });
    });

    const stale = await passAged(name, "private", 11 * MINUTE);
    await expectRefused(await open("race-room", name, stale), name, INVITE_EXPIRED_REASON);
    await expectRefused(await open("race-room", name), name, INVITE_EXPIRED_REASON);
  });

  it("lets nothing that bypassed the Worker's check create a room", async () => {
    const name = `adm-bypass-${crypto.randomUUID()}`;
    const res = await privateRoom(name).fetch(new Request(partyUrl("race-room", name)));
    expect(res.status).toBe(403);
    expect(await privateRoom(name).reserveRoomName()).toBe(true);
  });
});
