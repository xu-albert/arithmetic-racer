// POST /api/contact handler.
//
// This is a public, unauthenticated write endpoint — the one kind of surface
// that attracts spam by default — so it is rate limited per IP before it
// touches the database.
//
// Submissions are both stored and emailed. The D1 row is the durable record;
// the email is only a notification. Delivery is best-effort and deliberately
// cannot fail the request: contact is the only channel for deletion requests,
// so losing a message to a provider outage would be worse than a missed email.
//
// Nothing here authenticates the sender. `email` is whatever was typed in. A
// deletion request arriving through this endpoint must be verified out-of-band
// before anything is deleted — see docs on the privacy page.
//
// Bug reports (`kind: "bug"`, from /bug-report) come in as separate fields
// rather than one blob and are composed into `message` here, so that "what
// went wrong" and "what did you expect" are actually required rather than
// merely marked required in the form. They also carry a context snapshot; see
// CONTEXT_TEXT_FIELDS for what is and is not kept.

import { readUserId } from "../session.js";
import { sendTransactional } from "../email.js";
import { logError, logWarn, KINDS } from "../logger.js";
import { describeUserAgent } from "../user-agent.js";
import { APP_VERSION } from "../version.js";

const MAX_MESSAGE_LEN = 5000;
const KINDS_ALLOWED = new Set(["general", "deletion", "bug"]);

// Per-field cap for the bug form. Three of these still fit inside
// MAX_MESSAGE_LEN once composed, so a valid set of fields can never produce a
// message the length check then rejects.
const MAX_BUG_FIELD_LEN = 1500;

// Workers KV requires expirationTtl >= 60s. Three messages an hour per IP is
// far above any genuine use and well below what makes spamming worthwhile.
const RATE_LIMIT_MAX = 3;
const RATE_LIMIT_WINDOW_S = 3600;

// Deliberately permissive: this only catches obvious typos so we can tell the
// user immediately. Real validation of an address is whether mail to it works.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Allowlist, not passthrough. `context` arrives from the page, so storing it
// as sent would mean storing whatever anyone chose to put in it. Every key not
// named here is dropped: no cookies, no tokens, no auth headers, no
// localStorage. Adding a key is a deliberate decision that the field is safe.
//
// `page` is a path only. It deliberately excludes the query string, which on
// this site can hold a one-time password-reset token (/reset-password?token=)
// or a private room's invite slug (?room=) — neither belongs in a bug report,
// and neither is worth the debugging value of the rest of the URL.
const CONTEXT_TEXT_FIELDS = {
  page: 256,     // same-origin path the reporter came from
  screen: 32,    // "1512x982"
  viewport: 32,  // "1200x800"
};

// Numeric context, same allowlist rule.
const CONTEXT_NUMBER_FIELDS = new Set(["dpr"]);

function bad(error) {
  return Response.json({ error }, { status: 400 });
}

function trimmedString(value) {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Compose the bug form's fields into the single `message` column. Labelled
 * rather than JSON-encoded because this is read by a human in the dashboard,
 * and because it keeps bug reports greppable alongside every other message.
 */
function composeBugMessage({ whatHappened, expected, steps }) {
  const sections = [
    `What went wrong:\n${whatHappened}`,
    `What they expected:\n${expected}`,
  ];
  if (steps) sections.push(`Steps to reproduce:\n${steps}`);
  return sections.join("\n\n");
}

/**
 * Build the stored context snapshot from the allowlist above plus the fields
 * the server is authoritative for. Anything the server can determine itself —
 * user agent, whether the sender is signed in, which version is deployed — is
 * taken from the server, so a report cannot misdescribe its own origin.
 *
 * @returns {object} Always an object; caller decides whether to store it.
 */
function buildContext(body, request, userId) {
  const sent =
    body.context && typeof body.context === "object" && !Array.isArray(body.context)
      ? body.context
      : {};

  const context = {};
  for (const [key, maxLen] of Object.entries(CONTEXT_TEXT_FIELDS)) {
    const value = trimmedString(sent[key]);
    if (value) context[key] = value.slice(0, maxLen);
  }
  for (const key of CONTEXT_NUMBER_FIELDS) {
    if (typeof sent[key] === "number" && Number.isFinite(sent[key])) context[key] = sent[key];
  }

  // Second line of defence on `page`: strip a query string or fragment even if
  // one reaches us, so the rule holds regardless of what the client sent.
  if (context.page) context.page = context.page.split(/[?#]/)[0];

  const ua = (request.headers.get("user-agent") ?? "").slice(0, 512);
  if (ua) context.ua = ua;
  const { browser, os } = describeUserAgent(ua);
  if (browser) context.browser = browser;
  if (os) context.os = os;

  context.app_version = APP_VERSION;
  context.signed_in = userId != null;

  return context;
}

/**
 * @param {Request} request
 * @param {object} env
 * @param {{ sendMail?: Function }} [deps] Injection seam for tests.
 */
export async function handleContact(request, env, deps = {}) {
  const sendMail = deps.sendMail ?? sendTransactional;

  let body;
  try {
    body = await request.json();
  } catch {
    return bad("invalid_body");
  }

  if (!body || typeof body !== "object") return bad("invalid_body");

  const kind = body.kind ?? "general";
  if (!KINDS_ALLOWED.has(kind)) return bad("invalid_kind");

  let message;
  if (kind === "bug") {
    const whatHappened = trimmedString(body.what_happened);
    const expected = trimmedString(body.expected);
    const steps = trimmedString(body.steps);
    // Both are required. A report of what broke without what was expected is
    // frequently unactionable — the two together are what make it a bug
    // report rather than a general message, which already has its own form.
    if (whatHappened.length === 0) return bad("empty_what_happened");
    if (expected.length === 0) return bad("empty_expected");
    if (
      whatHappened.length > MAX_BUG_FIELD_LEN ||
      expected.length > MAX_BUG_FIELD_LEN ||
      steps.length > MAX_BUG_FIELD_LEN
    ) {
      return bad("field_too_long");
    }
    message = composeBugMessage({ whatHappened, expected, steps });
  } else {
    message = trimmedString(body.message);
    if (message.length === 0) return bad("empty_message");
  }
  if (message.length > MAX_MESSAGE_LEN) return bad("message_too_long");

  // Email is optional — someone may want to raise something anonymously. But
  // if they supply one, a typo means we can never reply, so reject it loudly.
  let email = null;
  if (body.email !== undefined && body.email !== null && body.email !== "") {
    if (typeof body.email !== "string" || !EMAIL_RE.test(body.email.trim())) {
      return bad("invalid_email");
    }
    email = body.email.trim();
  }

  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const limited = await isRateLimited(env, ip);
  if (limited) {
    return Response.json(
      { error: "rate_limited" },
      { status: 429, headers: { "retry-after": String(RATE_LIMIT_WINDOW_S) } }
    );
  }

  const userId = await readUserId(request, env).catch(() => null);
  const deviceId = typeof body.device_id === "string" ? body.device_id.slice(0, 128) : null;

  // Only bug reports capture context. General and deletion messages keep
  // exactly the shape they had before this column existed — there is no reason
  // to start recording a browser fingerprint against a deletion request.
  const context = kind === "bug" ? JSON.stringify(buildContext(body, request, userId)) : null;

  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(
      `INSERT INTO contact_messages
         (id, email, message, kind, user_id, device_id, handled, created_at, context)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)`
    )
      .bind(id, email, message, kind, userId ?? null, deviceId, Date.now(), context)
      .run();
  } catch (err) {
    logError(KINDS.CONTACT_DB, err, { kind });
    return Response.json({ error: "db_error" }, { status: 500 });
  }

  // Notification only. The body is deliberately excluded — it can contain
  // personal detail and belongs behind the admin token, not in an inbox.
  try {
    if (env.LOOPS_TEMPLATE_CONTACT && env.CONTACT_EMAIL) {
      await sendMail(env, {
        transactionalId: env.LOOPS_TEMPLATE_CONTACT,
        to: env.CONTACT_EMAIL,
        dataVariables: { kind, hasEmail: email ? "yes" : "no" },
      });
    }
  } catch (err) {
    logWarn(KINDS.CONTACT_NOTIFY_FAILED, err, { id, kind });
  }

  return Response.json({ id, ok: true });
}

/**
 * Per-IP counter in KV. Fails **open**: contact is the only route for deletion
 * requests, so dropping a message because the limiter is unavailable is worse
 * than letting an extra one through.
 */
async function isRateLimited(env, ip) {
  const store = env.CONTACT_LIMITS;
  if (!store) return false;
  const key = `contact-rl:${ip}`;
  try {
    const count = parseInt((await store.get(key)) || "0", 10);
    if (count >= RATE_LIMIT_MAX) return true;
    await store.put(key, String(count + 1), { expirationTtl: RATE_LIMIT_WINDOW_S });
    return false;
  } catch (err) {
    logWarn(KINDS.CONTACT_RATE_LIMIT, err, { outcome: "failed_open" });
    return false;
  }
}
