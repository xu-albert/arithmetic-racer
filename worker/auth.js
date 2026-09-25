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
//   LOOPS_API_KEY            — Loops API key (optional — email no-ops without it)
//   LOOPS_TEMPLATE_WELCOME   — transactionalId for the welcome template
//   LOOPS_TEMPLATE_RESET     — transactionalId for the password-reset template
//                              (template must declare a `resetUrl` variable)
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
//    for claim + welcome email. `databaseHooks.account.create.before` refuses
//    an OAuth link into an unverified user, and the single `hooks.after` names
//    that refusal on the error redirect (see `linksIntoUnverifiedUser`).
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
import { APIError, createAuthMiddleware } from "better-auth/api";
import { sendResetEmail, sendWelcomeEmail } from "./email.js";
import { validateUsernameSync } from "./username-validator.js";
import { logError, KINDS } from "./logger.js";

// The error code a refused Google link reaches the client with. The client's
// mapAuthError (public/src/auth.js) turns it into the explanation.
const LINK_REFUSED = "ACCOUNT_LINK_REQUIRES_VERIFIED_EMAIL";

/**
 * Build the auth instance against the Worker's D1 binding and env secrets.
 * The integrator imports `getAuth(env)` and uses `auth.handler(request)`.
 *
 * @param {object} env  Cloudflare Worker bindings + secrets
 * @returns {ReturnType<typeof betterAuth>}
 */
export function getAuth(env) {
  // Requests whose OAuth link the account hook refused, so the after hook can
  // name the reason better-auth's own error redirect drops.
  const refusedLinks = new WeakSet();

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
      // Only whoever reads the address can use a reset link, so a completed
      // reset is the proof of ownership sign-up never asked for. It is what
      // lets the owner of a squatted address take it back: the reset verifies
      // the email (opening Google sign-in to this account) and ends every
      // session, the squatter's included.
      onPasswordReset: async ({ user }) => {
        await env.DB
          .prepare(`UPDATE "user" SET "emailVerified" = 1 WHERE id = ?`)
          .bind(user.id)
          .run();
      },
      revokeSessionsOnPasswordReset: true,
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
              // Uniqueness check (case-insensitive). Without this the DB's
              // UNIQUE constraint would fire and surface as a generic 500;
              // we want a specific code so the modal can render
              // "That display name is already taken." inline.
              const collision = await env.DB
                .prepare(`SELECT id FROM "user" WHERE LOWER(username) = LOWER(?)`)
                .bind(incoming)
                .first();
              if (collision) {
                throw new APIError("CONFLICT", {
                  message: "username_taken",
                  code: "USERNAME_IS_ALREADY_TAKEN",
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
                logError(KINDS.CLAIM_FAILED, err, { trigger: "signup", userId: user.id });
              }
            }
            try {
              await sendWelcomeEmail(env, { to: user.email });
            } catch (err) {
              logError(KINDS.WELCOME_EMAIL_FAILED, err, { userId: user.id });
            }
          },
        },
      },
      account: {
        create: {
          before: async (account, ctx) => {
            if (!(await linksIntoUnverifiedUser(env, account))) return;
            if (ctx?.request) refusedLinks.add(ctx.request);
            throw new APIError("FORBIDDEN", {
              message: "account_link_requires_verified_email",
              code: LINK_REFUSED,
            });
          },
        },
      },
    },

    hooks: {
      // better-auth reports the refusal above as a generic
      // `error=unable_to_link_account` on its error redirect. Name the real
      // reason instead, so the client can tell the user what to do.
      after: createAuthMiddleware(async (ctx) => {
        if (!refusedLinks.has(ctx.request)) return;
        const location = ctx.context.responseHeaders?.get("location");
        if (!location) return;
        const url = new URL(location, ctx.context.baseURL);
        url.searchParams.set("error", LINK_REFUSED);
        throw ctx.redirect(url.href);
      }),
    },
  });
}

/**
 * Whether creating this account would attach an OAuth identity to an existing
 * user whose email was never verified — the join the account hook refuses.
 *
 * better-auth 1.6.9 signs a Google user in by email: if a user row already has
 * that address, it links the Google account into it and marks the email
 * verified (`handleOAuthUserInfo` in oauth2/link-account.mjs), trusting only
 * Google's claim and never the local row's. Nothing verifies email on sign-up,
 * so anyone can register a password account under someone else's address,
 * wait for the owner to sign in with Google, and keep a password that opens
 * the owner's account. 1.7 closes this upstream with
 * `accountLinking.requireLocalEmailVerified` (default on); 1.6.9 has no such
 * setting, and `disableImplicitLinking` would also refuse verified users.
 *
 * The hook's throw is the refusal: the link sits in a try/catch that returns
 * "unable to link account" before the emailVerified update or any session is
 * created. Returning `false` from the hook would not do — 1.6.9 ignores a null
 * link and signs in anyway.
 *
 * Not a join:
 *   - credential accounts (email sign-up, password reset);
 *   - a user with no accounts yet, which is `createOAuthUser` minting a new
 *     user and its first account in the same request.
 * The only way into a squatted address is a password reset, which verifies it
 * (`onPasswordReset` above).
 */
async function linksIntoUnverifiedUser(env, account) {
  if (account.providerId === "credential") return false;

  const target = await env.DB
    .prepare(
      `SELECT u."emailVerified" AS verified,
              (SELECT COUNT(*) FROM account a WHERE a."userId" = u.id) AS accounts
         FROM "user" u WHERE u.id = ?`,
    )
    .bind(account.userId)
    .first();
  return !(target && (target.verified || target.accounts === 0));
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
