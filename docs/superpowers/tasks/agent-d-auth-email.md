# Agent D — Auth + Email

**Spec:** `docs/superpowers/specs/2026-05-06-users-auth-stats-design.md`
**Plan:** `docs/superpowers/plans/2026-05-06-users-auth-stats-implementation.md`
**API contracts:** `worker/api-contracts.js` (frozen)

---

## Mission

Configure better-auth on the Worker. Provide:
- Google OAuth + email/password sign-up and sign-in.
- Password reset via email (Resend).
- Welcome email on email/password signup (passive verification).
- Anon→registered claim hook that fires inside the signup flow.
- A standalone reset-password page served by static assets.

This is the most config-heavy slice. Agent D's output is a single `auth` export that the integrator mounts on `/api/auth/*` and a small `email.js` helper used by the auth hooks.

## Files you own

- `worker/auth.js` — better-auth config, hooks, exported `auth` instance.
- `worker/email.js` — Resend wrapper with two templates (welcome, reset).
- `public/reset-password.html` — standalone reset page.
- `public/css/reset-password.css` — styles for the reset page.

## Files you must NOT touch

`worker/index.js` (integrator), `worker/routes/*` (other agents), `public/index.html`, `public/style-a.css`, anything in `public/src/` (Agent F owns the auth client wrapper).

## Contract

The integrator will mount your `auth.handler` on requests starting with `/api/auth/`. Better-auth's standard route layout under that prefix gives you (as defaults):

- `POST /api/auth/sign-up/email`
- `POST /api/auth/sign-in/email`
- `POST /api/auth/sign-out`
- `GET  /api/auth/sign-in/social?provider=google` (redirect)
- `GET  /api/auth/callback/google`
- `POST /api/auth/forget-password`
- `POST /api/auth/reset-password`
- `GET  /api/auth/get-session`

(Exact paths come from better-auth — verify against the version installed. If they differ, update the contract doc and notify the integrator before merging.)

## Implementation

### `worker/auth.js`

```js
import { betterAuth } from "better-auth";
import { sendWelcomeEmail, sendResetEmail } from "./email.js";
import { validateUsernameSync } from "./username-validator.js";

/**
 * Build the auth instance against the Worker's D1 binding and env secrets.
 * The integrator imports `getAuth(env)` and uses `auth.handler(request)`.
 */
export function getAuth(env) {
  return betterAuth({
    database: {
      provider: "sqlite",
      // better-auth's D1 adapter pattern — verify the exact import in the installed version.
      // Likely: import { d1Adapter } from "better-auth/adapters/d1" then `database: d1Adapter(env.DB)`.
      // Use the documented form for the installed version.
      d1: env.DB,
    },
    secret: env.BETTER_AUTH_SECRET,
    emailAndPassword: {
      enabled: true,
      autoSignIn: true,
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
        username: { type: "string", required: false, unique: true },
      },
    },
    hooks: {
      after: [
        {
          matcher: (ctx) => ctx.path === "/sign-up/email",
          handler: async (ctx) => {
            // Validate username from the signup body.
            const { username, deviceId } = ctx.body ?? {};
            const v = validateUsernameSync(username);
            if (!v.valid) {
              throw new Error(`username_${v.reason}`);
            }
            // Set the username on the freshly-created user.
            const userId = ctx.context.newSession?.user?.id;
            if (userId) {
              await env.DB.prepare("UPDATE user SET username = ? WHERE id = ?")
                .bind(username, userId).run();
              await runClaim(env, userId, deviceId);
              await sendWelcomeEmail(env, { to: ctx.context.newSession.user.email });
            }
          },
        },
        {
          matcher: (ctx) => ctx.path?.startsWith("/callback/"),
          handler: async (ctx) => {
            // OAuth signup/login. If new user, claim runs after the username
            // modal POSTs to /api/me/username for the first time. We don't run
            // claim here — leave it to the username-set route. (Agent C: when
            // a user sets username for the first time AND has no claimed
            // races yet AND the request body includes deviceId, run claim.)
            // Document as INTEGRATION NOTE — coordinated with agent C / integrator.
          },
        },
      ],
    },
  });
}

/**
 * Claim anonymous races for a device by setting their user_id.
 * Used by the email/password signup hook and exported for the integrator
 * to call from the username-set flow on first set.
 */
export async function runClaim(env, userId, deviceId) {
  if (!deviceId) return;
  await env.DB
    .prepare("UPDATE race_results SET user_id = ? WHERE user_id IS NULL AND device_id = ?")
    .bind(userId, deviceId)
    .run();
}
```

**Important:** the exact better-auth API names (`hooks.after.matcher`, `additionalFields`, the D1 adapter import path) are subject to the installed library version. If the installed version differs, **read its README before changing the shape and write a comment** documenting the version-specific path you used.

### `worker/email.js`

```js
const RESEND_URL = "https://api.resend.com/emails";

async function sendEmail(env, { to, subject, html }) {
  if (!env.RESEND_API_KEY) {
    // In CI or local without keys, log instead of failing the flow.
    console.warn("[email] no RESEND_API_KEY; would send:", { to, subject });
    return;
  }
  const res = await fetch(RESEND_URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${env.RESEND_API_KEY}`,
    },
    body: JSON.stringify({
      from: env.RESEND_FROM ?? "onboarding@resend.dev",
      to, subject, html,
    }),
  });
  if (!res.ok) {
    console.error("[email] resend failed", res.status, await res.text());
  }
}

export async function sendWelcomeEmail(env, { to }) {
  await sendEmail(env, {
    to,
    subject: "Welcome to Arithmetic Racer",
    html: `
      <h1>Welcome to Arithmetic Racer.</h1>
      <p>Your account is ready. If you didn't sign up, you can ignore this email.</p>
      <p>Race fast.</p>
    `,
  });
}

export async function sendResetEmail(env, { to, resetUrl }) {
  await sendEmail(env, {
    to,
    subject: "Reset your Arithmetic Racer password",
    html: `
      <p>Click the link below to reset your password. The link expires in 1 hour.</p>
      <p><a href="${resetUrl}">Reset password</a></p>
      <p>If you didn't request this, ignore this email.</p>
    `,
  });
}
```

### `public/reset-password.html`

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Reset password — Arithmetic Racer</title>
  <link rel="stylesheet" href="style-a.css" />
  <link rel="stylesheet" href="css/reset-password.css" />
</head>
<body>
  <main class="reset-card">
    <h1>Reset your password</h1>
    <form id="reset-form">
      <label>New password
        <input type="password" id="new-password" minlength="8" required />
      </label>
      <label>Confirm
        <input type="password" id="confirm-password" minlength="8" required />
      </label>
      <button type="submit">Set new password</button>
      <p class="reset-error" id="reset-error" hidden></p>
      <p class="reset-success" id="reset-success" hidden>Password updated. <a href="/">Go to lobby →</a></p>
    </form>
  </main>
  <script type="module">
    const params = new URLSearchParams(location.search);
    const token = params.get("token");
    const form = document.getElementById("reset-form");
    const errEl = document.getElementById("reset-error");
    const okEl = document.getElementById("reset-success");

    form.addEventListener("submit", async (e) => {
      e.preventDefault();
      errEl.hidden = true;
      const a = document.getElementById("new-password").value;
      const b = document.getElementById("confirm-password").value;
      if (a !== b) { errEl.textContent = "Passwords don't match."; errEl.hidden = false; return; }
      if (!token)  { errEl.textContent = "Missing token."; errEl.hidden = false; return; }
      const res = await fetch("/api/auth/reset-password", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, newPassword: a }),
      });
      if (!res.ok) {
        errEl.textContent = "Reset failed. The link may have expired.";
        errEl.hidden = false;
        return;
      }
      form.hidden = true;
      okEl.hidden = false;
    });
  </script>
</body>
</html>
```

### `public/css/reset-password.css`

```css
.reset-card {
  max-width: 22rem;
  margin: 4rem auto;
  padding: 2rem;
  border-radius: 12px;
  background: #fff;
  box-shadow: 0 6px 24px rgba(0,0,0,0.08);
  font-family: 'Quicksand', system-ui, sans-serif;
}
.reset-card h1 { margin: 0 0 1rem; font-size: 1.4rem; }
.reset-card label { display: block; margin: 1rem 0; font-weight: 500; }
.reset-card input { width: 100%; padding: .6rem; border: 1px solid #ccc; border-radius: 6px; font-size: 1rem; }
.reset-card button { width: 100%; padding: .8rem; background: #2563eb; color: white; border: 0; border-radius: 6px; font-weight: 600; cursor: pointer; }
.reset-card button:hover { background: #1d4ed8; }
.reset-error { color: #b91c1c; margin-top: .8rem; }
.reset-success { color: #15803d; margin-top: .8rem; }
```

## Testing

Auth library code paths are covered by better-auth's own test suite. **You don't need to retest the library.** Your test surface is:

1. **`worker/email.js` unit test** (`worker/email.test.js`):
   - Verify `sendEmail` no-ops when `RESEND_API_KEY` is missing (no fetch call).
   - Verify with a mocked `fetch`, the body has the right `from`, `to`, `subject`, `html`.

2. **Manual config check on `wrangler dev`** (covered by Integration I4 — not your responsibility to run, but document any setup steps in a code comment at the top of `worker/auth.js`).

The hooks (welcome email, claim) get tested end-to-end in I4 — the in-memory D1 in vitest-pool-workers can't easily simulate a full better-auth request cycle, and that's not your investment to make in v1.

## Milestones

- [ ] **M1 — `worker/email.js` + unit tests pass.** Commit: `M1: agent D — Resend email wrapper with welcome + reset templates`.
- [ ] **M2 — `worker/auth.js` exports `getAuth(env)` and `runClaim(env, ...)`.** Verifies build (`vitest run`) doesn't fail on import. Commit: `M2: agent D — better-auth config with Google OAuth + signup hooks`.
- [ ] **M3 — Reset password page + CSS.** Commit: `M3: agent D — reset-password.html static page`.

## Definition of done

1. `getAuth(env)` returns a configured better-auth instance using D1 + Resend + Google OAuth.
2. `sendWelcomeEmail` and `sendResetEmail` are exported and tested.
3. Email/password signup hook validates username via Agent A's validator and runs `runClaim`.
4. `runClaim(env, userId, deviceId)` is exported separately so the integrator can call it from the Google-OAuth username-set flow.
5. Reset password page POSTs to better-auth's reset endpoint and shows clear success/failure UI.
6. Top-of-file comment in `worker/auth.js` lists every env var needed (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `RESEND_API_KEY`, `BETTER_AUTH_SECRET`).
7. No files outside the allowlist touched.

## How the integrator uses your work

- **Integrator (I1):** routes `/api/auth/*` to `getAuth(env).handler(request)`.
- **Integrator (I1):** replaces the `readUserId` stubs in Agents B + C with calls to `auth.api.getSession({ headers: request.headers })`.
- **Integrator (I1):** adds Google-OAuth-specific claim wiring: when `POST /api/me/username` is called and the user's `username` was previously NULL, run `runClaim(env, userId, body.deviceId)` if `deviceId` is in the body. This handles the OAuth signup path.
- **Integrator (I4):** sets up Google OAuth project, Resend account, runs all flows manually.
