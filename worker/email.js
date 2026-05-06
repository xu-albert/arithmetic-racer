// Resend email wrapper for the arithmetic-racer Worker.
//
// Two flavors of mail get sent from auth flows:
//   - sendWelcomeEmail   — fired on email/password signup (passive verification)
//   - sendResetEmail     — fired by better-auth's `sendResetPassword` callback
//
// In environments without a `RESEND_API_KEY` (CI, fresh local dev) the wrapper
// no-ops with a console warning so signup flows don't fail. The integrator
// is responsible for putting a real key in `.dev.vars` or `wrangler secret put`
// before manual E2E.
//
// Required env vars:
//   RESEND_API_KEY   — Resend account API key (optional in dev/CI)
//   RESEND_FROM      — optional `from` address; defaults to `onboarding@resend.dev`
//                      which works without a verified domain on Resend's free tier.

const RESEND_URL = "https://api.resend.com/emails";

/**
 * Internal helper. Sends an email via Resend. No-ops if RESEND_API_KEY is unset.
 * @param {{ RESEND_API_KEY?: string, RESEND_FROM?: string }} env
 * @param {{ to: string, subject: string, html: string }} input
 */
export async function sendEmail(env, { to, subject, html }) {
  if (!env.RESEND_API_KEY) {
    // In CI or local without keys, log instead of failing the auth flow.
    console.warn("[email] no RESEND_API_KEY; would send:", { to, subject });
    return { skipped: true };
  }
  const res = await fetch(RESEND_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: env.RESEND_FROM ?? "onboarding@resend.dev",
      to,
      subject,
      html,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error("[email] resend failed", res.status, text);
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
