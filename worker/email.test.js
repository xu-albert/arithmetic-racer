// Unit tests for worker/email.js — Resend wrapper.
// Runs under vitest-pool-workers (cloudflare workerd runtime).

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { sendEmail, sendResetEmail, sendWelcomeEmail } from "./email.js";

describe("sendEmail — no API key", () => {
  let warnSpy;
  beforeEach(() => {
    warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
  });
  afterEach(() => {
    warnSpy.mockRestore();
    vi.restoreAllMocks();
  });

  test("no-ops when RESEND_API_KEY is missing — fetch is not called", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await sendEmail(
      {},
      { to: "user@example.com", subject: "Hi", html: "<p>hi</p>" },
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

describe("sendEmail — with API key (mocked fetch)", () => {
  let fetchMock;
  beforeEach(() => {
    fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ id: "msg_123" }), {
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

  test("sends to Resend with correct method, URL, headers, and body shape", async () => {
    await sendEmail(
      { RESEND_API_KEY: "re_test_key" },
      { to: "user@example.com", subject: "Hello", html: "<p>hi</p>" },
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.resend.com/emails");
    expect(init.method).toBe("POST");
    expect(init.headers["content-type"]).toBe("application/json");
    expect(init.headers.authorization).toBe("Bearer re_test_key");
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      from: "onboarding@resend.dev",
      to: "user@example.com",
      subject: "Hello",
      html: "<p>hi</p>",
    });
  });

  test("honors RESEND_FROM override", async () => {
    await sendEmail(
      { RESEND_API_KEY: "re_test_key", RESEND_FROM: "noreply@racer.dev" },
      { to: "user@example.com", subject: "x", html: "y" },
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.from).toBe("noreply@racer.dev");
  });

  test("sendWelcomeEmail produces a welcome-shaped payload", async () => {
    await sendWelcomeEmail(
      { RESEND_API_KEY: "k" },
      { to: "newuser@example.com" },
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.to).toBe("newuser@example.com");
    expect(body.subject).toMatch(/welcome/i);
    expect(body.html).toMatch(/Welcome to Arithmetic Racer/);
  });

  test("sendResetEmail embeds the reset URL", async () => {
    const resetUrl = "https://racer.dev/reset-password?token=tok_xyz";
    await sendResetEmail(
      { RESEND_API_KEY: "k" },
      { to: "u@e.com", resetUrl },
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.subject).toMatch(/reset/i);
    expect(body.html).toContain(resetUrl);
  });

  test("logs (does not throw) when Resend returns a non-2xx", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(
      new Response("server boom", { status: 500 }),
    );
    const res = await sendEmail(
      { RESEND_API_KEY: "k" },
      { to: "u@e.com", subject: "x", html: "y" },
    );
    expect(res).toEqual({ ok: false, status: 500 });
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });
});
