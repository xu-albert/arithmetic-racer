// Tests for the per-connection message limiter.
//
// The clock is injected so window expiry is asserted directly instead of by
// sleeping — a real 1s wait per case would make this the slowest file in the
// suite and still be timing-flaky under load.

import { describe, it, expect } from "vitest";
import { createSocketLimiter, MAX_MESSAGES_PER_WINDOW, WINDOW_MS } from "./socket-limit.js";

/** A limiter driven by a clock the test controls. */
function limiterAt(startMs = 1_000) {
  let now = startMs;
  const limiter = createSocketLimiter({ now: () => now });
  return { limiter, advance: (ms) => { now += ms; } };
}

describe("createSocketLimiter", () => {
  it("allows messages up to the per-window maximum", () => {
    const { limiter } = limiterAt();
    for (let i = 0; i < MAX_MESSAGES_PER_WINDOW; i++) {
      expect(limiter.allow("conn-1")).toBe(true);
    }
  });

  it("blocks the message after the maximum", () => {
    const { limiter } = limiterAt();
    for (let i = 0; i < MAX_MESSAGES_PER_WINDOW; i++) limiter.allow("conn-1");
    expect(limiter.allow("conn-1")).toBe(false);
  });

  it("keeps blocking while the flood continues inside the window", () => {
    const { limiter } = limiterAt();
    for (let i = 0; i < MAX_MESSAGES_PER_WINDOW; i++) limiter.allow("conn-1");
    expect(limiter.allow("conn-1")).toBe(false);
    expect(limiter.allow("conn-1")).toBe(false);
  });

  it("lets the connection resume once the window has elapsed", () => {
    const { limiter, advance } = limiterAt();
    for (let i = 0; i < MAX_MESSAGES_PER_WINDOW; i++) limiter.allow("conn-1");
    expect(limiter.allow("conn-1")).toBe(false);

    advance(WINDOW_MS);
    expect(limiter.allow("conn-1")).toBe(true);
  });

  it("counts each connection independently", () => {
    const { limiter } = limiterAt();
    for (let i = 0; i < MAX_MESSAGES_PER_WINDOW; i++) limiter.allow("noisy");
    expect(limiter.allow("noisy")).toBe(false);
    // One player flooding must not mute everyone else in the room.
    expect(limiter.allow("quiet")).toBe(true);
  });

  it("forgets a connection so closed sockets do not accumulate", () => {
    const { limiter } = limiterAt();
    for (let i = 0; i < MAX_MESSAGES_PER_WINDOW; i++) limiter.allow("conn-1");
    expect(limiter.allow("conn-1")).toBe(false);

    limiter.forget("conn-1");
    expect(limiter.size()).toBe(0);
    // A reconnecting id starts clean rather than inheriting a spent budget.
    expect(limiter.allow("conn-1")).toBe(true);
  });

  it("allows a normal race's message rate without ever tripping", () => {
    // A 10-problem race is ~10 answers over ~30s. Even a player answering far
    // faster than the game's model stays an order of magnitude under the cap.
    const { limiter, advance } = limiterAt();
    let blocked = 0;
    for (let i = 0; i < 60; i++) {
      if (!limiter.allow("player")) blocked++;
      advance(500);
    }
    expect(blocked).toBe(0);
  });
});
