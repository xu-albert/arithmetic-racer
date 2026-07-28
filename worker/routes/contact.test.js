// Tests for POST /api/contact.
//
// vitest-pool-workers gives an ephemeral in-memory D1 per test file; the schema
// is applied from migrations/ by worker/test-setup.js.

import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { handleContact } from "./contact.js";

beforeEach(async () => {
  await env.DB.exec("DELETE FROM contact_messages");
});

afterEach(() => {
  vi.restoreAllMocks();
});

function post(body, headers = {}) {
  return new Request("https://example.com/api/contact", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/** env with notification configured and a stub KV that never rate-limits. */
function testEnv(overrides = {}) {
  const store = new Map();
  return {
    ...env,
    LOOPS_TEMPLATE_CONTACT: "contact-notification",
    CONTACT_EMAIL: "owner@example.test",
    CONTACT_LIMITS: {
      get: async (k) => store.get(k) ?? null,
      put: async (k, v) => void store.set(k, v),
    },
    ...overrides,
  };
}

async function rows() {
  const { results } = await env.DB.prepare("SELECT * FROM contact_messages").all();
  return results;
}

describe("POST /api/contact — validation", () => {
  it("rejects a non-JSON body", async () => {
    const res = await handleContact(post("not json"), testEnv());
    expect(res.status).toBe(400);
  });

  it("rejects an empty message", async () => {
    const res = await handleContact(post({ message: "   " }), testEnv());
    expect(res.status).toBe(400);
    expect(await rows()).toHaveLength(0);
  });

  it("rejects a message over the length cap", async () => {
    const res = await handleContact(post({ message: "x".repeat(5001) }), testEnv());
    expect(res.status).toBe(400);
  });

  it("rejects an unknown kind", async () => {
    const res = await handleContact(post({ message: "hi", kind: "urgent" }), testEnv());
    expect(res.status).toBe(400);
  });

  it("rejects a malformed email when one is supplied", async () => {
    const res = await handleContact(post({ message: "hi", email: "nope" }), testEnv());
    expect(res.status).toBe(400);
  });

  it("accepts a submission with no email at all", async () => {
    const res = await handleContact(post({ message: "anonymous question" }), testEnv());
    expect(res.status).toBe(200);
    const [row] = await rows();
    expect(row.email).toBe(null);
    expect(row.message).toBe("anonymous question");
  });
});

describe("POST /api/contact — persistence", () => {
  it("stores the submission and returns its id", async () => {
    const res = await handleContact(
      post({ message: "please delete my data", email: "a@b.com", kind: "deletion" }),
      testEnv()
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.id).toBeTruthy();

    const [row] = await rows();
    expect(row.message).toBe("please delete my data");
    expect(row.email).toBe("a@b.com");
    expect(row.kind).toBe("deletion");
    expect(row.handled).toBe(0);
    expect(row.created_at).toBeGreaterThan(0);
  });

  it("defaults kind to general", async () => {
    await handleContact(post({ message: "hello" }), testEnv());
    expect((await rows())[0].kind).toBe("general");
  });

  it("trims surrounding whitespace from the message", async () => {
    await handleContact(post({ message: "  spaced  " }), testEnv());
    expect((await rows())[0].message).toBe("spaced");
  });
});

describe("POST /api/contact — email notification", () => {
  it("emails a notification when configured", async () => {
    const sendMail = vi.fn().mockResolvedValue({ ok: true });
    await handleContact(post({ message: "ping" }), testEnv(), { sendMail });
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it("still succeeds and still stores when the email fails", async () => {
    // The row is the durable record; mail is only a notification. A Loops
    // outage must not lose the user's message or show them an error.
    const sendMail = vi.fn().mockRejectedValue(new Error("loops down"));
    const res = await handleContact(post({ message: "ping" }), testEnv(), { sendMail });
    expect(res.status).toBe(200);
    expect(await rows()).toHaveLength(1);
  });

  it("skips the notification entirely when it is not configured", async () => {
    const sendMail = vi.fn();
    const e = testEnv({ LOOPS_TEMPLATE_CONTACT: undefined, CONTACT_EMAIL: undefined });
    const res = await handleContact(post({ message: "ping" }), e, { sendMail });
    expect(res.status).toBe(200);
    expect(sendMail).not.toHaveBeenCalled();
    expect(await rows()).toHaveLength(1);
  });

  it("does not put the submitted message body in the notification email", async () => {
    // The notification goes to an inbox; the message itself may contain
    // personal data and belongs in the admin dashboard behind the token.
    const sendMail = vi.fn().mockResolvedValue({ ok: true });
    await handleContact(post({ message: "my secret situation" }), testEnv(), { sendMail });
    expect(JSON.stringify(sendMail.mock.calls[0])).not.toContain("my secret situation");
  });
});

describe("POST /api/contact — rate limiting", () => {
  it("blocks the fourth submission from one IP in a window", async () => {
    const e = testEnv();
    for (let i = 0; i < 3; i++) {
      expect((await handleContact(post({ message: `m${i}` }), e)).status).toBe(200);
    }
    const res = await handleContact(post({ message: "spam" }), e);
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBeTruthy();
    expect(await rows()).toHaveLength(3);
  });

  it("tracks each IP separately", async () => {
    const e = testEnv();
    for (let i = 0; i < 3; i++) await handleContact(post({ message: `m${i}` }), e);
    const other = await handleContact(post({ message: "hi" }, { "cf-connecting-ip": "198.51.100.4" }), e);
    expect(other.status).toBe(200);
  });

  it("accepts the submission when the rate-limit store is unavailable", async () => {
    // Failing open: a KV outage should not silently swallow contact messages,
    // which are the only channel for deletion requests.
    const e = testEnv({
      CONTACT_LIMITS: {
        get: async () => { throw new Error("kv down"); },
        put: async () => { throw new Error("kv down"); },
      },
    });
    const res = await handleContact(post({ message: "hi" }), e);
    expect(res.status).toBe(200);
  });
});
