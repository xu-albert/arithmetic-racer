import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { logError, logWarn } from "./logger.js";

let errorSpy;
let warnSpy;

beforeEach(() => {
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  errorSpy.mockRestore();
  warnSpy.mockRestore();
});

/** Parse the single argument the logger passed to console.error. */
function emitted(spy = errorSpy) {
  expect(spy).toHaveBeenCalledTimes(1);
  expect(spy.mock.calls[0].length).toBe(1);
  return JSON.parse(spy.mock.calls[0][0]);
}

describe("logError", () => {
  it("emits exactly one JSON line", () => {
    logError("race_result_db", new Error("boom"));
    const payload = emitted();
    expect(payload.kind).toBe("race_result_db");
  });

  it("serializes Error objects instead of flattening them to {}", () => {
    // JSON.stringify(new Error('boom')) is "{}" — the whole reason this exists.
    logError("race_result_db", new Error("boom"));
    const { err } = emitted();
    expect(err.message).toBe("boom");
    expect(err.name).toBe("Error");
    expect(typeof err.stack).toBe("string");
  });

  it("includes the caller's context", () => {
    logError("race_result_db", new Error("boom"), { playerId: "p1", roomId: "r1" });
    const { context } = emitted();
    expect(context).toEqual({ playerId: "p1", roomId: "r1" });
  });

  it("defaults context to an empty object", () => {
    logError("room_message", new Error("boom"));
    expect(emitted().context).toEqual({});
  });

  it("tags the level so warn and error can be filtered apart", () => {
    logError("room_message", new Error("boom"));
    expect(emitted().level).toBe("error");
  });

  it("handles non-Error throwables", () => {
    logError("room_message", "just a string");
    expect(emitted().err.message).toBe("just a string");
  });

  it("handles a null error", () => {
    logError("room_message", null);
    const { err } = emitted();
    expect(err).toBeDefined();
  });

  it("never throws on a circular context", () => {
    // A logger that throws turns a handled error into an unhandled one.
    const circular = { name: "loop" };
    circular.self = circular;
    expect(() => logError("room_message", new Error("boom"), circular)).not.toThrow();
    expect(errorSpy).toHaveBeenCalledTimes(1);
  });

  it("still reports kind and error when the context is unserializable", () => {
    const circular = {};
    circular.self = circular;
    logError("room_message", new Error("boom"), circular);
    const payload = emitted();
    expect(payload.kind).toBe("room_message");
    expect(payload.err.message).toBe("boom");
  });

  it("never throws when the error itself is exotic", () => {
    const weird = { get message() { throw new Error("nope"); } };
    expect(() => logError("room_message", weird)).not.toThrow();
  });
});

describe("logWarn", () => {
  it("routes to console.warn with level warn", () => {
    logWarn("matchmaking_kv", new Error("kv down"));
    expect(errorSpy).not.toHaveBeenCalled();
    const payload = emitted(warnSpy);
    expect(payload.level).toBe("warn");
    expect(payload.kind).toBe("matchmaking_kv");
  });
});
