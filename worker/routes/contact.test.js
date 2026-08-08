// Tests for POST /api/contact.
//
// Mirrors migrations/0005_contact_messages.sql as amended by
// migrations/0007_contact_bug_reports.sql, inline, matching the pattern in
// race-result.test.js (vitest-pool-workers gives an ephemeral in-memory D1 per
// test file). If those migrations change, update this block to match — and
// note that D1's exec() runs one statement per line, which is why this is a
// single-line paraphrase rather than the file itself. The migration files
// proper are executed and asserted on in migrations/migrations.test.js.

import { describe, it, expect, beforeAll, beforeEach, vi, afterEach } from "vitest";
import { env } from "cloudflare:test";
import { handleContact } from "./contact.js";
import { APP_VERSION } from "../version.js";
import { BUG_CONTEXT_FIELDS, COLUMN_FIELDS } from "../../public/src/bug-report-context.js";
import { _setTestUserId } from "../session.js";

beforeAll(async () => {
  // Mirror of migrations/0001_better_auth.sql (user table only). Present so the
  // foreign key below is real and a signed-in submission can be exercised.
  await env.DB.exec(
    `CREATE TABLE IF NOT EXISTS "user" (` +
      `"id" text not null primary key, ` +
      `"name" text not null, ` +
      `"email" text not null unique, ` +
      `"emailVerified" integer not null, ` +
      `"image" text, ` +
      `"createdAt" date not null, ` +
      `"updatedAt" date not null, ` +
      `"username" text unique` +
      `)`
  );
  await env.DB.exec(
    "CREATE TABLE IF NOT EXISTS contact_messages (" +
      "id TEXT PRIMARY KEY, " +
      "email TEXT, " +
      "message TEXT NOT NULL, " +
      "kind TEXT NOT NULL DEFAULT 'general' CHECK (kind IN ('general','deletion','bug')), " +
      `user_id TEXT REFERENCES "user"(id) ON DELETE SET NULL, ` +
      "device_id TEXT, " +
      "handled INTEGER NOT NULL DEFAULT 0 CHECK (handled IN (0,1)), " +
      "created_at INTEGER NOT NULL, " +
      "context TEXT" +
      ")"
  );
});

beforeEach(async () => {
  await env.DB.exec("DELETE FROM contact_messages");
  await env.DB.exec(`DELETE FROM "user"`);
  _setTestUserId(null);
});

/** Seed an account so a submission can be made as a real signed-in reporter. */
async function seedUser(id) {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", username)
     VALUES (?,?,?,?,?,?,?)`
  )
    .bind(id, id, `${id}@example.com`, 0, now, now, id)
    .run();
}

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

const CHROME_MAC =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

/** A valid bug report, overridable field by field. */
function bugBody(overrides = {}) {
  return {
    kind: "bug",
    what_happened: "the race froze on problem 3",
    expected: "the next problem should have appeared",
    ...overrides,
  };
}

async function submitBug(body = {}, { headers = {}, envOverrides } = {}) {
  const res = await handleContact(
    post(bugBody(body), { "user-agent": CHROME_MAC, ...headers }),
    envOverrides ?? testEnv()
  );
  return res;
}

async function firstContext() {
  const [row] = await rows();
  return row.context == null ? null : JSON.parse(row.context);
}

describe("POST /api/contact — bug reports", () => {
  it("accepts the bug kind", async () => {
    const res = await submitBug();
    expect(res.status).toBe(200);
    expect((await rows())[0].kind).toBe("bug");
  });

  it("requires what_happened", async () => {
    const res = await submitBug({ what_happened: "   " });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "empty_what_happened" });
    expect(await rows()).toHaveLength(0);
  });

  it("requires expected", async () => {
    // Enforced here rather than only in the form: "required" that lives in
    // HTML is a suggestion, and this is the field that makes a report a bug
    // report rather than a general message.
    const res = await submitBug({ expected: "" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "empty_expected" });
    expect(await rows()).toHaveLength(0);
  });

  it("treats steps as optional", async () => {
    const res = await submitBug({ steps: undefined });
    expect(res.status).toBe(200);
    expect((await rows())[0].message).not.toContain("Steps to reproduce");
  });

  it("treats where-in-the-app as optional", async () => {
    const res = await submitBug({ where: undefined });
    expect(res.status).toBe(200);
    expect((await rows())[0].message).not.toContain("Where in the app");
  });

  it("rejects an over-long field", async () => {
    const res = await submitBug({ steps: "x".repeat(1501) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "field_too_long" });
  });

  it("rejects an over-long where-in-the-app", async () => {
    const res = await submitBug({ where: "x".repeat(201) });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "field_too_long" });
  });

  it("composes the fields into one labelled message", async () => {
    await submitBug({ where: "a Quickplay race on hard", steps: "1. start a race\n2. wait" });
    const { message } = (await rows())[0];
    expect(message).toContain("Where in the app:\na Quickplay race on hard");
    expect(message).toContain("What went wrong:\nthe race froze on problem 3");
    expect(message).toContain("What they expected:\nthe next problem should have appeared");
    expect(message).toContain("Steps to reproduce:\n1. start a race\n2. wait");
  });

  it("never composes a message the length check then rejects", async () => {
    // The per-field caps exist so that a set of fields which passes
    // field_too_long always fits inside MAX_MESSAGE_LEN once labelled. Every
    // field at its maximum is the worst case.
    const res = await submitBug({
      what_happened: "a".repeat(1500),
      expected: "b".repeat(1500),
      steps: "c".repeat(1500),
      where: "d".repeat(200),
    });
    expect(res.status).toBe(200);
    expect((await rows())[0].message.length).toBeLessThanOrEqual(5000);
  });

  it("ignores a message field sent alongside the bug fields", async () => {
    // The composed fields are the report. A stray `message` must not be able
    // to replace or bypass them.
    await submitBug({ message: "totally different text" });
    expect((await rows())[0].message).not.toContain("totally different text");
  });

  it("still requires a valid email when one is given", async () => {
    const res = await submitBug({ email: "nope" });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_email" });
  });

  it("accepts a report with no email", async () => {
    const res = await submitBug();
    expect(res.status).toBe(200);
    expect((await rows())[0].email).toBe(null);
  });

  it("is rate limited on the same counter as every other submission", async () => {
    const e = testEnv();
    for (let i = 0; i < 3; i++) {
      expect((await handleContact(post(bugBody()), e)).status).toBe(200);
    }
    expect((await handleContact(post(bugBody()), e)).status).toBe(429);
    expect(await rows()).toHaveLength(3);
  });

  it("still stores the report when the notification email fails", async () => {
    // The row is the durable record — and in this deployment it is the only
    // one, since the notification is not configured in production at all.
    const sendMail = vi.fn().mockRejectedValue(new Error("loops down"));
    const res = await handleContact(
      post(bugBody(), { "user-agent": CHROME_MAC }),
      testEnv(),
      { sendMail }
    );
    expect(res.status).toBe(200);
    expect(await rows()).toHaveLength(1);
  });

  it("does not put the report text in the notification email", async () => {
    const sendMail = vi.fn().mockResolvedValue({ ok: true });
    await handleContact(
      post(bugBody({ what_happened: "my secret situation" })),
      testEnv(),
      { sendMail }
    );
    expect(JSON.stringify(sendMail.mock.calls[0])).not.toContain("my secret situation");
  });
});

describe("POST /api/contact — captured context", () => {
  it("derives browser and OS from the request's own user agent", async () => {
    await submitBug();
    const context = await firstContext();
    expect(context.ua).toBe(CHROME_MAC);
    expect(context.browser).toBe("Chrome 141");
    expect(context.os).toBe("macOS");
  });

  it("records the deployed app version", async () => {
    await submitBug();
    expect((await firstContext()).app_version).toBe(APP_VERSION);
  });

  it("records guest submissions as not signed in", async () => {
    await submitBug();
    expect((await firstContext()).signed_in).toBe(false);
  });

  it("keeps the screen, viewport and pixel-ratio fields", async () => {
    await submitBug({ context: { screen: "3024x1964", viewport: "1512x845", dpr: 2 } });
    const context = await firstContext();
    expect(context.screen).toBe("3024x1964");
    expect(context.viewport).toBe("1512x845");
    expect(context.dpr).toBe(2);
  });

  it("keeps the page path the reporter came from", async () => {
    await submitBug({ context: { page: "/some/route" } });
    expect((await firstContext()).page).toBe("/some/route");
  });

  it("strips a query string or fragment from the page path", async () => {
    // Defence in depth. A URL on this site can carry a one-time
    // password-reset token or a private room's invite slug; neither may be
    // stored, whatever the client chose to send.
    await submitBug({ context: { page: "/reset-password?token=super-secret#frag" } });
    const context = await firstContext();
    expect(context.page).toBe("/reset-password");
    expect(JSON.stringify(context)).not.toContain("super-secret");
  });

  it("drops every context key that is not on the allowlist", async () => {
    // The context object is entirely client-controlled, so it is an allowlist
    // and not a passthrough: no cookies, no tokens, no localStorage dumps.
    await submitBug({
      context: {
        cookie: "session=abc123",
        authorization: "Bearer super-secret",
        localStorage: { everything: "here" },
        screen: "800x600",
      },
    });
    const context = await firstContext();
    expect(context).not.toHaveProperty("cookie");
    expect(context).not.toHaveProperty("authorization");
    expect(context).not.toHaveProperty("localStorage");
    expect(JSON.stringify(context)).not.toContain("super-secret");
    expect(JSON.stringify(context)).not.toContain("abc123");
    expect(context.screen).toBe("800x600");
  });

  it("does not let the client dictate the server-derived fields", async () => {
    await submitBug({
      context: { app_version: "999.0.0", signed_in: true, browser: "Netscape 1", ua: "spoofed" },
    });
    const context = await firstContext();
    expect(context.app_version).toBe(APP_VERSION);
    expect(context.signed_in).toBe(false);
    expect(context.browser).toBe("Chrome 141");
    expect(context.ua).toBe(CHROME_MAC);
  });

  it("caps an over-long context string rather than rejecting the report", async () => {
    await submitBug({ context: { viewport: "x".repeat(500) } });
    expect((await firstContext()).viewport.length).toBeLessThanOrEqual(32);
  });

  it("ignores context of the wrong shape", async () => {
    for (const context of ["a string", 42, ["an", "array"], null]) {
      await env.DB.exec("DELETE FROM contact_messages");
      const res = await submitBug({ context });
      expect(res.status).toBe(200);
      expect(await firstContext()).toMatchObject({ app_version: APP_VERSION });
    }
  });

  it("stores context that json_extract can query", async () => {
    await submitBug();
    const row = await env.DB
      .prepare("SELECT json_extract(context, '$.os') AS os FROM contact_messages")
      .first();
    expect(row.os).toBe("macOS");
  });

  it("survives a request with no user-agent header at all", async () => {
    const res = await handleContact(
      new Request("https://example.com/api/contact", {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": "203.0.113.7" },
        body: JSON.stringify(bugBody()),
      }),
      testEnv()
    );
    expect(res.status).toBe(200);
    const context = await firstContext();
    expect(context).not.toHaveProperty("browser");
    expect(context.app_version).toBe(APP_VERSION);
  });

  it("stores exactly the fields the shared descriptor declares", async () => {
    // The descriptor is the list the privacy page is held to by the guard in
    // public/src/bug-report-context.test.js, so a field stored but not declared
    // is a field captured with no account of it anywhere — and a field declared
    // but not stored is a claim that page makes and the server does not keep.
    // Both must fail here.
    const declared = BUG_CONTEXT_FIELDS.filter((f) => f.storedIn === "context");
    const sent = Object.fromEntries(
      declared
        .filter((f) => f.source === "client")
        .map((f) => [f.key, f.type === "number" ? 2 : "sample"])
    );
    await submitBug({
      context: { ...sent, cookie: "session=abc123", authorization: "Bearer super-secret" },
    });
    expect(Object.keys(await firstContext()).sort()).toEqual(declared.map((f) => f.key).sort());
  });

  it("persists no user-data column the shared descriptor does not declare", async () => {
    // The columns half of the same promise. A bug report filed while signed in
    // carries the session cookie, so the row picks up an account link nothing on
    // the form mentions — the privacy page has to name it, and this is what
    // makes that enforceable rather than aspirational. Exercised with a real
    // signed-in reporter on purpose: with user_id null the assertion cannot
    // fail, which is precisely how the account link went unnoticed.
    await seedUser("u-reporter");
    _setTestUserId("u-reporter");
    await submitBug({ device_id: "dev-abc" });

    const [row] = await rows();
    expect(row.user_id).toBe("u-reporter");

    // Columns that carry the submission itself rather than data about the
    // reporter: the id and timestamps are plumbing, message and email are what
    // they typed into visible fields, and context has its own assertion above.
    const NOT_ABOUT_THE_REPORTER = new Set([
      "id",
      "message",
      "kind",
      "created_at",
      "handled",
      "email",
      "context",
    ]);
    // Every remaining column, not just the ones this submission populated. A
    // column that is null here but filled on some other path is exactly the
    // shape of gap that let the account link go undeclared.
    const persisted = Object.keys(row).filter((column) => !NOT_ABOUT_THE_REPORTER.has(column));
    expect(persisted.sort()).toEqual(COLUMN_FIELDS.map((f) => f.key).sort());
  });

  it("leaves the account link empty for a report filed while signed out", async () => {
    await submitBug({ device_id: "dev-abc" });
    expect((await rows())[0].user_id).toBe(null);
  });

  it("stores the device id when the report carries one", async () => {
    // The form attaches this on every report; its half is covered in
    // public/src/bug-report-context.test.js.
    await submitBug({ device_id: "dev-abc" });
    expect((await rows())[0].device_id).toBe("dev-abc");
  });

  it("stores no device id when the report does not carry one", async () => {
    await submitBug();
    expect((await rows())[0].device_id).toBe(null);
  });

  it("caps an over-long device id rather than rejecting the report", async () => {
    const res = await submitBug({ device_id: "d".repeat(500) });
    expect(res.status).toBe(200);
    expect((await rows())[0].device_id.length).toBe(128);
  });

  it("captures nothing for general and deletion messages", async () => {
    // A deletion request has no reason to carry a browser fingerprint, and
    // this column exists for bug reports specifically.
    for (const kind of ["general", "deletion"]) {
      await env.DB.exec("DELETE FROM contact_messages");
      await handleContact(
        post({ message: "hello", kind, context: { screen: "800x600" } }, { "user-agent": CHROME_MAC }),
        testEnv()
      );
      expect((await rows())[0].context).toBe(null);
    }
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
