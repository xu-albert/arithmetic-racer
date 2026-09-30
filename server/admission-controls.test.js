import { describe, it, expect } from "vitest";
import { SELF } from "cloudflare:test";

async function connect(roomId) {
  const res = await SELF.fetch(`https://admission.test/parties/race-room/${roomId}`, {
    headers: { Upgrade: "websocket" },
  });
  expect(res.status).toBe(101);
  const ws = res.webSocket;
  const messages = [];
  ws.addEventListener("message", (event) => messages.push(JSON.parse(event.data)));
  ws.accept();
  ws.send(JSON.stringify({
    type: "hello",
    playerId: crypto.randomUUID(),
    handle: "Uninvited",
    deviceId: crypto.randomUUID(),
  }));
  await new Promise((resolve) => setTimeout(resolve, 10));
  ws.close();
  return messages;
}

describe("room admission controls", () => {
  it("does not let a client self-select a room and take a seat", async () => {
    const messages = await connect(`self-selected-${crypto.randomUUID()}`);
    expect(messages.some((message) => message.type === "hello-ack")).toBe(false);
    expect(messages.find((message) => message.type === "error")?.code).toBe("ADMISSION_REQUIRED");
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
