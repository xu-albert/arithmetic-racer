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

import { readUserId } from "../session.js";
import { sendTransactional } from "../email.js";
import { logError, logWarn, KINDS } from "../logger.js";

const MAX_MESSAGE_LEN = 5000;
const KINDS_ALLOWED = new Set(["general", "deletion"]);

// Workers KV requires expirationTtl >= 60s. Three messages an hour per IP is
// far above any genuine use and well below what makes spamming worthwhile.
const RATE_LIMIT_MAX = 3;
const RATE_LIMIT_WINDOW_S = 3600;

// Deliberately permissive: this only catches obvious typos so we can tell the
// user immediately. Real validation of an address is whether mail to it works.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function bad(error) {
  return Response.json({ error }, { status: 400 });
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

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (message.length === 0) return bad("empty_message");
  if (message.length > MAX_MESSAGE_LEN) return bad("message_too_long");

  const kind = body.kind ?? "general";
  if (!KINDS_ALLOWED.has(kind)) return bad("invalid_kind");

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

  const id = crypto.randomUUID();
  try {
    await env.DB.prepare(
      `INSERT INTO contact_messages
         (id, email, message, kind, user_id, device_id, handled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)`
    )
      .bind(id, email, message, kind, userId ?? null, deviceId, Date.now())
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
