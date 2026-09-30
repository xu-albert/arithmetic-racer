import { describe, it, expect } from "vitest";
import { env, SELF, runInDurableObject } from "cloudflare:test";
import { ADMISSION_PASS_TTL_MS, issueAdmissionPass, verifyAdmissionPass } from "./admission-pass.js";
import { ADMISSION_PASS_REFRESH_MS } from "./room.js";
import { ROOM_EXPIRED_TYPE, INVITE_EXPIRED_REASON } from "../public/src/room-expiry.js";

const tick = (ms = 10) => new Promise((resolve) => setTimeout(resolve, ms));

const privateRoom = (name) => env.RaceRoom.get(env.RaceRoom.idFromName(name));
const publicRoom = (name) => env.PublicRaceRoom.get(env.PublicRaceRoom.idFromName(name));

async function open(party, roomId, admission) {
  const query = admission ? `?admission=${encodeURIComponent(admission)}` : "";
  const res = await SELF.fetch(`https://admission.test/parties/${party}/${roomId}${query}`, {
    headers: { Upgrade: "websocket" },
  });
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
    hello(handle) {
      ws.send(JSON.stringify({
        type: "hello", playerId: crypto.randomUUID(), handle, deviceId: crypto.randomUUID(),
      }));
    },
    passes() {
      return messages.filter((m) => m.type === "admission-pass").map((m) => m.admissionPass);
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

async function expectRefused(client, roomId) {
  const refusal = await client.wait((m) => m.type === ROOM_EXPIRED_TYPE);
  expect(refusal).toEqual({ type: ROOM_EXPIRED_TYPE, reason: INVITE_EXPIRED_REASON, roomId });
  for (let i = 0; i < 100 && !client.closed; i++) await tick(5);
  expect(client.closed).toBe(true);
  // Refused before the room was reached: it never pushed its own snapshot.
  expect(client.messages.some((m) => m.type === "state")).toBe(false);
}

describe("the Worker admits nobody to a room without a pass", () => {
  it("refuses a pass-less socket, says why, and leaves the name unminted", async () => {
    const name = `adm-nopass-${crypto.randomUUID()}`;
    await expectRefused(await open("race-room", name), name);
    // Nothing was written under the name, so a real creation still gets it.
    expect(await privateRoom(name).reserveRoomName()).toBe(true);
  });

  it("refuses a plain request without a pass before the room can mint state", async () => {
    const name = `adm-get-${crypto.randomUUID()}`;
    const res = await SELF.fetch(`https://admission.test/parties/race-room/${name}`);
    expect(res.status).toBe(403);
    expect(await privateRoom(name).reserveRoomName()).toBe(true);
  });

  it("never creates a public room at a name the matchmaker did not hand out", async () => {
    const name = `m-adm-${crypto.randomUUID()}`;
    expect((await SELF.fetch(`https://admission.test/parties/public-race-room/${name}`)).status).toBe(403);
    await expectRefused(await open("public-race-room", name), name);
    // A private pass for the same name is the wrong mode.
    const privatePass = await issueAdmissionPass(env, name, "private");
    await expectRefused(await open("public-race-room", name, privatePass), name);
    await runInDurableObject(publicRoom(name), async (_room, state) => {
      expect(await state.storage.get("state")).toBeUndefined();
    });
  });

  it("refuses a pass issued for another room, and any other routable party", async () => {
    const name = `adm-other-${crypto.randomUUID()}`;
    const elsewhere = await issueAdmissionPass(env, `adm-elsewhere-${crypto.randomUUID()}`, "private");
    await expectRefused(await open("race-room", name, elsewhere), name);
    const lobbyRouter = await SELF.fetch(
      `https://admission.test/parties/lobby-router/medium?admission=${encodeURIComponent(elsewhere)}`,
    );
    expect(lobbyRouter.status).toBe(403);
  });

  it("caps room creation attempts from one IP", async () => {
    const responses = [];
    for (let i = 0; i < 11; i++) {
      responses.push(await SELF.fetch("https://admission.test/api/rooms", {
        method: "POST",
        headers: { "cf-connecting-ip": "203.0.113.77" },
      }));
    }
    expect(responses.slice(0, 10).every((response) => response.status === 200)).toBe(true);
    expect(responses[10].status).toBe(429);
    expect(responses[10].headers.get("retry-after")).toBe("60");
  });
});

describe("a live private room keeps its invite link working", () => {
  it("hands each seat a fresh pass that still admits after the original lapses", async () => {
    const name = `adm-fresh-${crypto.randomUUID()}`;
    expect(await privateRoom(name).reserveRoomName()).toBe(true);
    // Minted so that it lapses one second from now.
    const original = await issueAdmissionPass(env, name, "private", Date.now() - ADMISSION_PASS_TTL_MS + 1000);

    const host = await open("race-room", name, original);
    host.hello("Host");
    await host.wait((m) => m.type === "hello-ack");
    const { admissionPass: fresh } = await host.wait((m) => m.type === "admission-pass");

    await tick(1100);
    await expectRefused(await open("race-room", name, original), name);

    const guest = await open("race-room", name, fresh);
    guest.hello("Guest");
    await guest.wait((m) => m.type === "hello-ack");
    await guest.wait((m) => m.type === "admission-pass");
    host.close();
    guest.close();
  });

  it("re-issues seated members a pass on the refresh cadence, and stops once none is connected", async () => {
    const name = `adm-refresh-${crypto.randomUUID()}`;
    expect(await privateRoom(name).reserveRoomName()).toBe(true);
    const host = await open("race-room", name, await issueAdmissionPass(env, name, "private"));
    host.hello("Host");
    await host.wait((m) => m.type === "admission-pass");

    await runInDurableObject(privateRoom(name), async (room) => {
      const due = room.state.admissionRefreshAt;
      expect(due).toBeGreaterThan(Date.now());
      expect(due).toBeLessThanOrEqual(Date.now() + ADMISSION_PASS_REFRESH_MS);
      expect(await room.ctx.storage.getAlarm()).toBeLessThanOrEqual(due);

      room.state.admissionRefreshAt = Date.now() - 1;
      await room.onAlarm();
      expect(room.state.admissionRefreshAt).toBeGreaterThan(Date.now());
    });
    await host.wait(() => host.passes().length >= 2);
    const refreshed = host.passes()[1];
    expect(await verifyAdmissionPass(env, refreshed, { roomId: name, mode: "private" })).toBe(true);

    host.close();
    await tick(50);
    await runInDurableObject(privateRoom(name), async (room) => {
      room.state.admissionRefreshAt = Date.now() - 1;
      await room.onAlarm();
      expect(room.state.admissionRefreshAt).toBeNull();
    });
  });

  it("gives a public seat its pass at hello without arming a refresh", async () => {
    const name = `m-adm-${crypto.randomUUID()}`;
    const racer = await open("public-race-room", name, await issueAdmissionPass(env, name, "public"));
    racer.hello("Racer");
    await racer.wait((m) => m.type === "hello-ack");
    const { admissionPass } = await racer.wait((m) => m.type === "admission-pass");
    expect(await verifyAdmissionPass(env, admissionPass, { roomId: name, mode: "public" })).toBe(true);
    await runInDurableObject(publicRoom(name), async (room) => {
      expect(room.state.admissionRefreshAt ?? null).toBeNull();
    });
    racer.close();
  });
});
