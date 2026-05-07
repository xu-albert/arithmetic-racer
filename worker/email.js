// Brevo (formerly Sendinblue) email wrapper for the arithmetic-racer Worker.
//
// Two flavors of mail get sent from auth flows:
//   - sendWelcomeEmail   — fired on email/password signup (passive verification)
//   - sendResetEmail     — fired by better-auth's `sendResetPassword` callback
//
// In environments without a `BREVO_API_KEY` (CI, fresh local dev) the wrapper
// no-ops with a console warning so signup flows don't fail. The integrator
// is responsible for putting a real key in `.dev.vars` or `wrangler secret put`
// before manual E2E.
//
// Required env vars:
//   BREVO_API_KEY    — Brevo account API key (optional in dev/CI)
//   BREVO_FROM       — verified `from` address for arithmeticracer.com.
//                      Optionally `Display Name <addr@domain.tld>` for a
//                      friendlier inbox preview. Required at delivery time —
//                      Brevo (unlike Resend's onboarding@resend.dev) does
//                      NOT provide a generic fallback sender.
//
// Provider note: this used to be Resend, swapped to Brevo because the user's
// other project already occupies their Resend free-tier domain slot. The
// only file affected by the swap is this one — auth.js calls
// sendWelcomeEmail / sendResetEmail by name; the names didn't change.

const BREVO_URL = "https://api.brevo.com/v3/smtp/email";

// "Display Name <addr@domain.tld>" or just "addr@domain.tld".
// Brevo wants the sender as { email, name } separately, so we parse.
function parseFrom(raw) {
  if (!raw) return null;
  const m = raw.match(/^\s*(.+?)\s*<([^>]+)>\s*$/);
  if (m) return { email: m[2].trim(), name: m[1].trim() };
  return { email: raw.trim() };
}

/**
 * Internal helper. Sends an email via Brevo. No-ops if BREVO_API_KEY is unset.
 * @param {{ BREVO_API_KEY?: string, BREVO_FROM?: string }} env
 * @param {{ to: string, subject: string, html: string }} input
 */
export async function sendEmail(env, { to, subject, html }) {
  if (!env.BREVO_API_KEY) {
    // In CI or local without keys, log instead of failing the auth flow.
    console.warn("[email] no BREVO_API_KEY; would send:", { to, subject });
    return { skipped: true };
  }
  const sender = parseFrom(env.BREVO_FROM);
  if (!sender) {
    console.error("[email] BREVO_FROM not set; refusing to send");
    return { ok: false, status: 0, reason: "no_from" };
  }
  const res = await fetch(BREVO_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      accept: "application/json",
      "api-key": env.BREVO_API_KEY,
    },
    body: JSON.stringify({
      sender,
      to: [{ email: to }],
      subject,
      htmlContent: html,
    }),
  });
  // Brevo returns 201 Created on success; treat 2xx as ok.
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error("[email] brevo failed", res.status, text);
    return { ok: false, status: res.status };
  }
  return { ok: true };
}

/**
 * Welcome email sent on email/password signup.
 * @param {object} env
 * @param {{ to: string }} input
 */
export async function sendWelcomeEmail(env, { to }) {
  return sendEmail(env, {
    to,
    subject: "Welcome to Arithmetic Racer",
    html: `
      <h1>Welcome to Arithmetic Racer.</h1>
      <p>Your account is ready. If you didn't sign up, you can safely ignore this email.</p>
      <p>Race fast.</p>
    `,
  });
}

/**
 * Password-reset email. better-auth supplies the full callback URL with a
 * one-time token; we just embed it.
 * @param {object} env
 * @param {{ to: string, resetUrl: string }} input
 */
export async function sendResetEmail(env, { to, resetUrl }) {
  return sendEmail(env, {
    to,
    subject: "Reset your Arithmetic Racer password",
    html: `
      <p>Click the link below to reset your password. The link expires in 1 hour.</p>
      <p><a href="${resetUrl}">Reset password</a></p>
      <p>If you didn't request this, ignore this email.</p>
    `,
  });
}
