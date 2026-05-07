// Unit tests for worker/email.js — Loops wrapper.
// Runs under vitest-pool-workers (cloudflare workerd runtime).

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  sendEmail,
  sendResetEmail,
  sendTransactional,
  sendWelcomeEmail,
} from "./email.js";

describe("sendTransactional — no API key", () => {
  let warnSpy;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
    vi.restoreAllMocks();
  });

  test("no-ops when LOOPS_API_KEY is missing — fetch is not called", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await sendTransactional(
      {},
      { transactionalId: "welcome", to: "user@example.com" },
    );
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ skipped: true });
    expect(warnSpy).toHaveBeenCalled();
  });

  test("welcome email no-ops without API key", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await sendWelcomeEmail({}, { to: "user@example.com" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("reset email no-ops without API key", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await sendResetEmail(
      {},
      { to: "user@example.com", resetUrl: "https://x/reset?token=abc" },
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("sendTransactional — with API key (mocked fetch)", () => {
  let fetchMock;
  beforeEach(() => {
    fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("posts to Loops with correct method, URL, headers, and body shape", async () => {
    await sendTransactional(
      { LOOPS_API_KEY: "loops_test_key" },
      {
        transactionalId: "welcome",
        to: "user@example.com",
        dataVariables: { foo: "bar" },
      },
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://app.loops.so/api/v1/transactional");
    expect(init.method).toBe("POST");
    expect(init.headers["content-type"]).toBe("application/json");
    expect(init.headers.authorization).toBe("Bearer loops_test_key");
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      transactionalId: "welcome",
      email: "user@example.com",
      dataVariables: { foo: "bar" },
    });
  });

  test("refuses to send when transactionalId is missing", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await sendTransactional(
      { LOOPS_API_KEY: "k" },
      { transactionalId: "", to: "u@e.com" },
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: false, status: 0, reason: "no_template" });
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  test("sendWelcomeEmail uses LOOPS_TEMPLATE_WELCOME and no variables", async () => {
    await sendWelcomeEmail(
      { LOOPS_API_KEY: "k", LOOPS_TEMPLATE_WELCOME: "welcome-tmpl" },
      { to: "newuser@example.com" },
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.transactionalId).toBe("welcome-tmpl");
    expect(body.email).toBe("newuser@example.com");
    expect(body.dataVariables).toEqual({});
  });

  test("sendResetEmail uses LOOPS_TEMPLATE_RESET and passes resetUrl", async () => {
    const resetUrl = "https://racer.dev/reset-password?token=tok_xyz";
    await sendResetEmail(
      { LOOPS_API_KEY: "k", LOOPS_TEMPLATE_RESET: "password-reset-tmpl" },
      { to: "u@e.com", resetUrl },
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.transactionalId).toBe("password-reset-tmpl");
    expect(body.email).toBe("u@e.com");
    expect(body.dataVariables).toEqual({ resetUrl });
  });

  test("logs (does not throw) when Loops returns a non-2xx", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(
      new Response("server boom", { status: 500 }),
    );
    const res = await sendTransactional(
      { LOOPS_API_KEY: "k" },
      { transactionalId: "x", to: "u@e.com" },
    );
    expect(res).toEqual({ ok: false, status: 500 });
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  test("sendEmail is a backwards-compatible alias for sendTransactional", () => {
    expect(sendEmail).toBe(sendTransactional);
  });
});
