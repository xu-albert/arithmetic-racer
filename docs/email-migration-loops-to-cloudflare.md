# Email migration: Loops → Cloudflare Email Service

Handoff notes. Everything you need to pick this up cold.

## Why

Transactional email is scattered across projects — this Worker is on Loops, albertxu.com is on
Resend. The trigger was Resend's free tier allowing only **one domain**, which doesn't work across
`arithmeticracer.com`, `albertxu.com`, and `arithmeticroyale.com`. Rather than pay $20/mo for
Resend Pro or run a service per project, consolidate on one provider.

**Cloudflare Email Service won over AWS SES** on:

- **No credentials in the Worker.** It's a binding (`env.EMAIL.send`), not an API key + fetch.
- **Bounce handling is automatic** — suppression list, soft-bounce retries, ISP feedback loops.
  On SES you build an SNS pipeline yourself or your sender reputation quietly rots.
- **DNS is already on Cloudflare**, so domain onboarding auto-writes SPF + DKIM.
- **No 24-hour wait.** SES requires a production-access review; until it clears you're capped at
  200/day to verified addresses only.
- **Cost.** 3,000 emails/month included on Workers Paid. SES would be ~$0.25/mo — the price gap is
  irrelevant at this volume, so it wasn't the deciding factor.

Known tradeoff: Email Service has been in **public beta since April 2026**. That risk is bounded —
email is confined to `worker/email.js`, which has already survived Resend → Brevo → Loops without
`auth.js` noticing.

## Current state

Three send paths, all funnelling through `worker/email.js`:

| Path | Caller | Template var | Notes |
|---|---|---|---|
| Welcome | `worker/auth.js:172` | `LOOPS_TEMPLATE_WELCOME` | signup, no variables |
| Password reset | `worker/auth.js:93` | `LOOPS_TEMPLATE_RESET` | better-auth callback, passes `resetUrl` |
| Contact notification | `worker/routes/contact.js:99-105` | `LOOPS_TEMPLATE_CONTACT` | to `CONTACT_EMAIL`, body deliberately excluded |

Files in scope:

- `worker/email.js` — the whole wrapper. `sendTransactional` + `sendWelcomeEmail` +
  `sendResetEmail` + the `sendEmail` back-compat alias.
- `worker/email.test.js` — 9 tests, all built on mocking `globalThis.fetch`.
- `worker/auth.js:64` — imports `sendResetEmail`, `sendWelcomeEmail`.
- `worker/routes/contact.js:42` — DI seam: `const sendMail = deps.sendMail ?? sendTransactional`.
- `worker/routes/contact.test.js:47,145` — asserts on `LOOPS_TEMPLATE_CONTACT`.

Env vars to retire: `LOOPS_API_KEY`, `LOOPS_TEMPLATE_WELCOME`, `LOOPS_TEMPLATE_RESET`,
`LOOPS_TEMPLATE_CONTACT`. **`CONTACT_EMAIL` stays.**

## Target state

```jsonc
// wrangler.jsonc — top level AND the named preview env
{ "send_email": [{ "name": "EMAIL" }] }
```

```js
await env.EMAIL.send({
  to,
  from: { email: "noreply@arithmeticracer.com", name: "Arithmetic Racer" },
  subject,
  html,
  text,
});
```

No API key, no `authorization` header, no `transactionalId`.

## Steps

1. **`wrangler login`** — there's no wrangler config on this machine today.
2. **Onboard the domain:** `npx wrangler email sending enable arithmeticracer.com`.
   Auto-writes SPF + DKIM into the Cloudflare zone. Confirm with
   `npx wrangler email sending dns get arithmeticracer.com`. Propagation is 5–15 min.
3. **Add the binding** to `wrangler.jsonc` — see the preview-env gotcha below.
4. **Port the three templates into code.** They currently live in the Loops dashboard. Either
   export the HTML from Loops first or write fresh ones. See "Templates move into code" below.
5. **Rewrite `worker/email.js`.** Keep `sendWelcomeEmail(env, {to})` and
   `sendResetEmail(env, {to, resetUrl})` signatures byte-identical so `auth.js` doesn't change.
   Keep the no-op-when-unconfigured behaviour, but key it on the **binding** being absent rather
   than `LOOPS_API_KEY`.
6. **Update `contact.js`** to the new `sendTransactional` shape, preserving the `deps.sendMail`
   seam. Drop the `env.LOOPS_TEMPLATE_CONTACT &&` guard — it becomes `env.CONTACT_EMAIL &&` alone.
7. **Rewrite both test files.** See the testing gotcha — this is the bulk of the work.
8. **Delete the Loops secrets** once deployed and verified.

## Gotchas

**Named envs don't inherit top-level config.** `wrangler.jsonc` already carries a comment about
this for `observability` — the same applies to `send_email`. Add the binding to *both* the top
level and the `preview` env, or preview deploys silently lose email.

**Templates move into code.** This is a real change in kind, not just a refactor. Loops is
template-first: the HTML lives in the dashboard, so copy edits are a dashboard change. On
Cloudflare the HTML lives in the Worker, so **copy edits become deploys**. The upside is that
email copy finally gets version-controlled and reviewed. Decide deliberately — probably a
`worker/email-templates.js` exporting functions that return `{subject, html, text}`.

**Always send both `html` and `text`.** Some clients only render plain text, and HTML-only sends
score worse with spam filters.

**Tests need reshaping, not patching.** Every current test asserts on `globalThis.fetch` — the URL,
the `authorization` header, the JSON body. A binding send never touches `fetch`, so those
assertions become meaningless. Replace with a fake binding:

```js
const EMAIL = { send: vi.fn(async () => ({ delivered: ["u@e.com"] })) };
await sendWelcomeEmail({ EMAIL }, { to: "u@e.com" });
expect(EMAIL.send).toHaveBeenCalledWith(expect.objectContaining({ to: "u@e.com" }));
```

Keep the no-op tests — just pass `{}` (no binding) instead of `{}` (no key). The intent survives;
only the mechanism changes.

**Local dev sends real email.** `{ "send_email": [{ "name": "EMAIL", "remote": true }] }` makes
`wrangler dev` deliver for real. Use addresses you control, and take `remote` back out before
deploying.

**Marketing is not permitted.** Cloudflare's FAQ: *"Email Service is intended only for
transactional emails. We plan to support marketing emails and bulk sender tooling in the future."*
The docs don't define "transactional," so the working line is:

- ✅ Welcome, password reset, contact notification — clearly fine.
- ✅ A **personalized** stats email ("your week: 47 races, 89% accuracy") — generated from that
  user's own activity, different for every recipient. Lifecycle mail, fine.
- ❌ A tournament promo, or a digest of site-wide top scores — same content to everyone, sent to
  drive engagement. That's marketing.

The risk isn't a rejected send, it's that **limits scale on account standing**. A promo blast that
draws spam complaints throttles the whole account — including password resets. If you want
tournament announcements, use a separate tool on a **subdomain**, so its complaint rate can't reach
the auth emails. Add `List-Unsubscribe` to anything recurring regardless.

**Other limits:** 50 recipients per email, 5 MiB total message size, 30 domains per zone. None
bite here. New accounts start on a conservative daily quota that scales with reputation.

## Verify

1. `npm test` — `node --test` on `public/src/*.test.js` + `server/room-stats.test.js`, then
   `vitest run`. The email and contact suites must pass rewritten, not skipped.
2. `npx wrangler email sending dns get arithmeticracer.com` — SPF + DKIM present.
3. Local: `npm run dev` with `"remote": true`, then sign up with a real address you control.
   Confirm the welcome email lands **in the inbox, not spam**.
4. Trigger a password reset; confirm `resetUrl` renders as a working link.
5. Submit the contact form; confirm the notification reaches `CONTACT_EMAIL` and that the message
   body is still excluded (`contact.js:96-97` — it's intentional, keep it that way).
6. Deploy, repeat 3–5 against production.
7. Check `emailSendingAdaptiveGroups` in the Cloudflare dashboard for delivery status. Watch that
   `spamScore` stays well under `spamThreshold` on the first real sends.

## Open decisions

- **Reuse the Loops HTML or rewrite?** Rewriting is likely faster than exporting, and the current
  templates are plain (welcome has no variables at all).
- **Sender address.** `noreply@arithmeticracer.com` is the assumed default — worth considering a
  replyable address for contact notifications specifically.
- **Do `albertxu.com` at the same time?** It's a single `fetch` in
  `src/app/api/contact/route.ts` there. Doing both together means onboarding two domains in one
  sitting. Note the REST API uses `address` (not `email`) and `reply_to` (not `replyTo`) — it
  differs from the Workers binding shape used here.
