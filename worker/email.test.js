// Unit tests for worker/email.js — Brevo wrapper.
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

  test("no-ops when BREVO_API_KEY is missing — fetch is not called", async () => {
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
      new Response(JSON.stringify({ messageId: "<msg_123@brevo>" }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  test("sends to Brevo with correct method, URL, headers, and body shape", async () => {
    await sendEmail(
      { BREVO_API_KEY: "xkeysib-test", BREVO_FROM: "noreply@arithmeticracer.com" },
      { to: "user@example.com", subject: "Hello", html: "<p>hi</p>" },
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.brevo.com/v3/smtp/email");
    expect(init.method).toBe("POST");
    expect(init.headers["content-type"]).toBe("application/json");
    expect(init.headers["api-key"]).toBe("xkeysib-test");
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      sender: { email: "noreply@arithmeticracer.com" },
      to: [{ email: "user@example.com" }],
      subject: "Hello",
      htmlContent: "<p>hi</p>",
    });
  });

  test("parses 'Display Name <addr@domain>' BREVO_FROM into sender object", async () => {
    await sendEmail(
      {
        BREVO_API_KEY: "k",
        BREVO_FROM: "Arithmetic Racer <noreply@arithmeticracer.com>",
      },
      { to: "u@e.com", subject: "x", html: "y" },
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.sender).toEqual({
      email: "noreply@arithmeticracer.com",
      name: "Arithmetic Racer",
    });
  });

  test("refuses to send when BREVO_FROM is missing (returns no_from)", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await sendEmail(
      { BREVO_API_KEY: "k" }, // no BREVO_FROM
      { to: "u@e.com", subject: "x", html: "y" },
    );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(res).toEqual({ ok: false, status: 0, reason: "no_from" });
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  test("sendWelcomeEmail produces a welcome-shaped payload", async () => {
    await sendWelcomeEmail(
      { BREVO_API_KEY: "k", BREVO_FROM: "noreply@arithmeticracer.com" },
      { to: "newuser@example.com" },
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.to).toEqual([{ email: "newuser@example.com" }]);
    expect(body.subject).toMatch(/welcome/i);
    expect(body.htmlContent).toMatch(/Welcome to Arithmetic Racer/);
  });

  test("sendResetEmail embeds the reset URL", async () => {
    const resetUrl = "https://racer.dev/reset-password?token=tok_xyz";
    await sendResetEmail(
      { BREVO_API_KEY: "k", BREVO_FROM: "noreply@arithmeticracer.com" },
      { to: "u@e.com", resetUrl },
    );
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.subject).toMatch(/reset/i);
    expect(body.htmlContent).toContain(resetUrl);
  });

  test("logs (does not throw) when Brevo returns a non-2xx", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce(
      new Response("server boom", { status: 500 }),
    );
    const res = await sendEmail(
      { BREVO_API_KEY: "k", BREVO_FROM: "noreply@arithmeticracer.com" },
      { to: "u@e.com", subject: "x", html: "y" },
    );
    expect(res).toEqual({ ok: false, status: 500 });
    expect(errSpy).toHaveBeenCalled();
    errSpy.mockRestore();
  });

  test("treats 201 Created as success (Brevo's normal happy-path status)", async () => {
    const res = await sendEmail(
      { BREVO_API_KEY: "k", BREVO_FROM: "noreply@arithmeticracer.com" },
      { to: "u@e.com", subject: "x", html: "y" },
    );
    expect(res).toEqual({ ok: true });
  });
});
