// better-auth configuration for the arithmetic-racer Worker.
//
// Exports:
//   getAuth(env)                       — returns a configured better-auth instance.
//                                        The integrator mounts `auth.handler(request)`
//                                        on requests starting with `/api/auth/`.
//   runClaim(env, userId, deviceId)    — attributes prior anonymous race results
//                                        to a now-registered user. Used both by the
//                                        signup hook (email/password) and by the
//                                        OAuth-username-set flow (the integrator
//                                        invokes this from POST /api/me/username
//                                        on first-username-set when deviceId is in
//                                        the body).
//
// Required env vars (declared in wrangler.jsonc / .dev.vars):
//   GOOGLE_CLIENT_ID         — Google OAuth client id
//   GOOGLE_CLIENT_SECRET     — Google OAuth client secret
//   RESEND_API_KEY           — Resend API key (optional — email no-ops without it)
//   RESEND_FROM              — optional; default `onboarding@resend.dev`
//   BETTER_AUTH_SECRET       — random 32+ byte secret used by better-auth
//   BETTER_AUTH_URL          — optional explicit base URL (better-auth derives
//                              one from the request if absent)
//
// D1 binding (declared in wrangler.jsonc):
//   env.DB                   — the project's D1 database
//
// ---------------------------------------------------------------------------
// Better-auth 1.6.9 API NOTES (deviations from the brief's pseudocode):
//
// 1. D1 ADAPTER: there is no `database: { provider: "sqlite", d1: env.DB }`
//    syntax. The kysely-adapter auto-detects a D1 binding (it sniffs for the
//    `batch`/`exec`/`prepare` triple) and wraps it in a D1SqliteDialect.
//    So we pass the binding directly: `database: env.DB`.
//
// 2. HOOKS SHAPE: at the top level, `hooks.before` and `hooks.after` are
//    SINGLE `AuthMiddleware` functions, NOT arrays of `{ matcher, handler }`.
//    The `{ matcher, handler }` array shape is plugin-only
//    (see `to-auth-endpoints.mjs::getHooks`). For per-route logic from
//    user-level config we either:
//      a) inspect `ctx.path` inside a single `hooks.after`, or
//      b) use `databaseHooks.user.create.{before,after}` which scopes
//         naturally to user creation and exposes the endpoint context as the
//         second argument.
//    We use `databaseHooks.user.create.before` for username validation
//    (so we reject before the DB insert) and `databaseHooks.user.create.after`
//    for claim + welcome email.
//
// 3. PASSWORD-RESET ROUTES (verified against
//    node_modules/better-auth/dist/api/routes/password.mjs in v1.6.9):
//      - POST /api/auth/request-password-reset   (NOT /forget-password)
//      - POST /api/auth/reset-password           (body: { token, newPassword })
//
//    The reset confirmation page (public/reset-password.html) POSTs to
//    /api/auth/reset-password.
//
// 4. ADDITIONAL FIELDS: `user.additionalFields.username` works as documented.
//    With `input: true` (the default), the field is read from sign-up body
//    and persisted on user creation; we then validate it in the create hook.

import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { sendResetEmail, sendWelcomeEmail } from "./email.js";
import { validateUsernameSync } from "./username-validator.js";

/**
 * Build the auth instance against the Worker's D1 binding and env secrets.
 * The integrator imports `getAuth(env)` and uses `auth.handler(request)`.
 *
 * @param {object} env  Cloudflare Worker bindings + secrets
 * @returns {ReturnType<typeof betterAuth>}
 */
export function getAuth(env) {
  return betterAuth({
    // The kysely-adapter auto-detects a Cloudflare D1 binding (objects with
    // `batch`, `exec`, and `prepare`) and uses its built-in D1SqliteDialect.
    database: env.DB,

    secret: env.BETTER_AUTH_SECRET,

    // If the integrator sets BETTER_AUTH_URL we honor it; otherwise better-auth
    // derives the base URL from the request (works for the single-origin
    // Worker setup we use).
    baseURL: env.BETTER_AUTH_URL,

    emailAndPassword: {
      enabled: true,
      autoSignIn: true,
      // Resend wrapper handles the "no API key" path internally with a warn.
      sendResetPassword: async ({ user, url }) => {
        await sendResetEmail(env, { to: user.email, resetUrl: url });
      },
    },

    socialProviders: {
      google: {
        clientId: env.GOOGLE_CLIENT_ID,
        clientSecret: env.GOOGLE_CLIENT_SECRET,
      },
    },

    user: {
      additionalFields: {
        // Sourced from the sign-up body; better-auth writes it to the user
        // row on create. OAuth users won't have a username at first; the
        // username modal POSTs to /api/me/username later (Agent C's route).
        username: {
          type: "string",
          required: false,
          unique: true,
        },
      },
    },

    databaseHooks: {
      user: {
        create: {
          // Validate before insert. For OAuth signups, ctx.body has no
          // `username` field — we let those through (the user will set
          // username later via the modal + /api/me/username).
          before: async (user, ctx) => {
            const incoming = ctx?.body?.username;
            if (typeof incoming === "string" && incoming.length > 0) {
              const v = validateUsernameSync(incoming);
              if (!v.valid) {
                // Map validator reasons to error codes Agent F's auth.js can
                // surface in the inline form errors. APIError → 400 BAD_REQUEST.
                throw new APIError("BAD_REQUEST", {
                  message: `username_${v.reason}`,
                  code: `USERNAME_${v.reason.toUpperCase()}`,
                });
              }
            }
            // Don't mutate the data — return void so better-auth uses the
            // original (with `username` already in additionalUserFields).
          },

          // After the user row exists, run claim + welcome email — but ONLY
          // for the email/password signup path, not OAuth. We detect this by
          // looking at the endpoint path. For OAuth, the integrator wires the
          // claim into POST /api/me/username on first-username-set.
          after: async (user, ctx) => {
            const path = ctx?.path;
            if (path !== "/sign-up/email") return;

            const deviceId = ctx?.body?.deviceId;
            if (deviceId) {
              try {
                await runClaim(env, user.id, deviceId);
              } catch (err) {
                // Don't fail signup if claim has a hiccup; log and move on.
                console.error("[auth] claim on signup failed", err);
              }
            }
            try {
              await sendWelcomeEmail(env, { to: user.email });
            } catch (err) {
              console.error("[auth] welcome email failed", err);
            }
          },
        },
      },
    },
  });
}

/**
 * Attribute prior anonymous race results to a registered user.
 *
 * Idempotent: rows that already have a non-null user_id are left alone.
 * Safe to call multiple times.
 *
 * Used by:
 *   - the email/password signup hook (above), via the deviceId in the body
 *   - the integrator, from POST /api/me/username on first-username-set,
 *     to handle the OAuth signup case
 *
 * @param {{ DB: D1Database }} env
 * @param {string} userId
 * @param {string|undefined} deviceId
 */
export async function runClaim(env, userId, deviceId) {
  if (!deviceId || !userId) return { claimed: 0 };
  const result = await env.DB
    .prepare(
      "UPDATE race_results SET user_id = ?1 WHERE user_id IS NULL AND device_id = ?2",
    )
    .bind(userId, deviceId)
    .run();
  // D1's run() returns { meta: { changes } }. We surface the count for callers
  // that want to log it (e.g. the integrator).
  return { claimed: result?.meta?.changes ?? 0 };
}
