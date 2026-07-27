// Loops transactional email wrapper for the arithmetic-racer Worker.
//
// Two flavors of mail get sent from auth flows:
//   - sendWelcomeEmail   — fired on email/password signup (passive verification)
//   - sendResetEmail     — fired by better-auth's `sendResetPassword` callback
//
// Loops is template-based: the HTML lives in the Loops dashboard, not in code.
// We send a `transactionalId` (a slug you pick when creating the template, e.g.
// "welcome", "password-reset") plus a `dataVariables` object for any template
// placeholders. Editing copy = editing the template in Loops, not a code deploy.
//
// In environments without a `LOOPS_API_KEY` (CI, fresh local dev) the wrapper
// no-ops with a console warning so signup flows don't fail. The integrator
// is responsible for creating templates in Loops and putting the right
// transactionalIds + key into `.dev.vars` (or `wrangler secret put`) before
// manual E2E.
//
// Required env vars:
//   LOOPS_API_KEY            — Loops account API key (optional in dev/CI)
//   LOOPS_TEMPLATE_WELCOME   — transactionalId for the welcome template
//   LOOPS_TEMPLATE_RESET     — transactionalId for the reset template
//                              (template must declare `resetUrl` variable)
//
// Provider history: Resend → Brevo → Loops. Brevo's marketing UI was too
// noisy; Loops is purely transactional/email-tooling and template-first.
// The only file affected by these swaps is this one — auth.js calls
// sendWelcomeEmail / sendResetEmail by name; the names didn't change.

import { logError, logWarn, KINDS } from "./logger.js";

const LOOPS_URL = "https://app.loops.so/api/v1/transactional";

/**
 * Reduce an address to `***@domain` for logging.
 *
 * Observability runs at head_sampling_rate 1, so anything logged here is
 * retained wholesale. The domain is enough to tell "all Gmail deliveries are
 * failing" from "one address is bad" without putting user addresses in logs.
 */
function redactEmail(address) {
  if (typeof address !== "string") return null;
  const at = address.lastIndexOf("@");
  return at === -1 ? "***" : `***@${address.slice(at + 1)}`;
}

/**
 * Internal helper. Fires one transactional send.
 * No-ops if `LOOPS_API_KEY` is unset.
 *
 * @param {{ LOOPS_API_KEY?: string }} env
 * @param {{ transactionalId: string, to: string, dataVariables?: object }} input
 */
export async function sendTransactional(env, { transactionalId, to, dataVariables = {} }) {
  if (!env.LOOPS_API_KEY) {
    logWarn(KINDS.EMAIL_SEND_FAILED, "no LOOPS_API_KEY configured", {
      transactionalId,
      to: redactEmail(to),
      outcome: "skipped",
    });
    return { skipped: true };
  }
  if (!transactionalId) {
    logError(KINDS.EMAIL_SEND_FAILED, "missing transactionalId; refusing to send", {
      to: redactEmail(to),
    });
    return { ok: false, status: 0, reason: "no_template" };
  }
  const res = await fetch(LOOPS_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.LOOPS_API_KEY}`,
    },
    body: JSON.stringify({
      transactionalId,
      email: to,
      dataVariables,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    logError(KINDS.EMAIL_SEND_FAILED, `loops responded ${res.status}`, {
      status: res.status,
      body: text.slice(0, 500),
      transactionalId,
      to: redactEmail(to),
    });
    return { ok: false, status: res.status };
  }
  return { ok: true };
}

/**
 * Welcome email sent on email/password signup.
 *
 * Template ID comes from `LOOPS_TEMPLATE_WELCOME`. The template can be
 * static (no variables) or include any variables you want — pass them
 * here in the second arg if you ever extend it.
 *
 * @param {object} env
 * @param {{ to: string }} input
 */
export async function sendWelcomeEmail(env, { to }) {
  return sendTransactional(env, {
    transactionalId: env.LOOPS_TEMPLATE_WELCOME,
    to,
    // No variables today — keep the template static. Add fields here if
    // the template grows (e.g., username, signup-time tip-of-the-day).
    dataVariables: {},
  });
}

/**
 * Password-reset email. better-auth supplies the full callback URL with a
 * one-time token; we hand it to the template as `resetUrl`.
 *
 * The Loops template must declare a `resetUrl` variable (case-sensitive).
 * Use it in the email body / button as `{{resetUrl}}`.
 *
 * @param {object} env
 * @param {{ to: string, resetUrl: string }} input
 */
export async function sendResetEmail(env, { to, resetUrl }) {
  return sendTransactional(env, {
    transactionalId: env.LOOPS_TEMPLATE_RESET,
    to,
    dataVariables: { resetUrl },
  });
}

// Internal alias — keep the old name available so other callers that
// imported `sendEmail` directly don't break. Prefer `sendTransactional`
// in new code.
export const sendEmail = sendTransactional;
