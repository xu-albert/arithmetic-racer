// Tests for the rate-limit seam.
//
// The seam exists because the native binding is not injectable: it arrives on
// `env` and has no local implementation to construct. These tests drive it with
// hand-written stand-ins so the *policy* (what happens when the limiter says no,
// is missing, or breaks) is verified without depending on binding availability.
// Whether the real binding works under vitest-pool-workers is a separate
// question, asserted at the bottom of this file.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { allowRequest, _resetFailOpenWarnings } from "./rate-limit.js";

const allowing = { limit: async () => ({ success: true }) };
const blocking = { limit: async () => ({ success: false }) };

// The fail-open warnings latch per condition and the latches are module state,
// so without this a test's log expectations would depend on whether an earlier
// test had already tripped the same condition.
beforeEach(() => _resetFailOpenWarnings());
afterEach(() => vi.restoreAllMocks());

describe("allowRequest", () => {
  it("allows a request the limiter accepts", async () => {
    expect(await allowRequest(allowing, "device-1")).toBe(true);
  });

  it("blocks a request the limiter rejects", async () => {
    expect(await allowRequest(blocking, "device-1")).toBe(false);
  });

  it("passes the key through to the binding unchanged", async () => {
    let seen;
    const spy = { limit: async (arg) => { seen = arg; return { success: true }; } };
    await allowRequest(spy, "device-abc");
    expect(seen).toEqual({ key: "device-abc" });
  });

  it("allows the request when the binding is absent", async () => {
    // Local dev and any environment where `ratelimits` was not configured.
    // Failing closed here would take the whole endpoint down.
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await allowRequest(undefined, "device-1")).toBe(true);
  });

  it("allows the request when the binding throws", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken = { limit: async () => { throw new Error("binding exploded"); } };
    expect(await allowRequest(broken, "device-1")).toBe(true);
  });

  it("logs a warning when it fails open so the degradation is visible", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken = { limit: async () => { throw new Error("binding exploded"); } };
    await allowRequest(broken, "device-1");
    expect(warn).toHaveBeenCalledTimes(1);
    const logged = JSON.parse(warn.mock.calls[0][0]);
    expect(logged.kind).toBe("rate_limit_unavailable");
    expect(logged.context.outcome).toBe("failed_open");
    expect(logged.context.cause).toBe("limiter_threw");
  });

  it("says it once, not once per request", async () => {
    // The condition is a property of the deployment or of an ongoing incident,
    // and this helper is consulted on every board load. A line per call would
    // scale with traffic while telling an operator nothing the first line did
    // not — and every call must still be allowed through.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken = { limit: async () => { throw new Error("binding exploded"); } };
    for (let i = 0; i < 5; i++) {
      expect(await allowRequest(broken, `device-${i}`)).toBe(true);
    }
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("latches the two fail-open causes apart", async () => {
    // A missing binding is a config mistake that will not fix itself; a
    // throwing binding is usually transient. Silencing one must not silence
    // the other, or an incident during a misconfiguration goes unreported.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const broken = { limit: async () => { throw new Error("binding exploded"); } };

    await allowRequest(broken, "device-1");
    await allowRequest(broken, "device-2");
    expect(warn).toHaveBeenCalledTimes(1);

    expect(await allowRequest(undefined, "device-3")).toBe(true);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls.map((c) => JSON.parse(c[0]).context.cause))
      .toEqual(["limiter_threw", "no_binding"]);
  });

  it("treats a malformed limiter response as a block rather than a pass", async () => {
    // A binding that returns something unexpected should not be read as
    // permission. This is the one case where failing open would let a
    // misbehaving binding silently disable the limit entirely.
    const weird = { limit: async () => ({}) };
    expect(await allowRequest(weird, "device-1")).toBe(false);
  });
});

describe("the real binding under vitest-pool-workers", () => {
  it("is present on env and enforces the configured limit", async () => {
    // Documents an unknown flagged during design: the Cloudflare docs do not
    // state whether vitest-pool-workers implements `ratelimits`. If this fails,
    // the seam above is what keeps the route testable anyway.
    expect(env.RACE_RESULT_LIMIT).toBeDefined();

    const key = `test-${crypto.randomUUID()}`;
    const verdicts = [];
    for (let i = 0; i < 8; i++) {
      verdicts.push(await allowRequest(env.RACE_RESULT_LIMIT, key));
    }
    expect(verdicts.slice(0, 6)).toEqual([true, true, true, true, true, true]);
    expect(verdicts[6]).toBe(false);
    expect(verdicts[7]).toBe(false);
  });
});
