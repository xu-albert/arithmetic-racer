// Account-linking tests for the better-auth config in worker/auth.js.
//
// Drives the real auth handler against this file's D1: email sign-up, the
// Google OAuth redirect and callback, and password reset. Only the outside
// services are stubbed. Google's token endpoint answers with an id_token
// carrying whatever identity the test chooses, which better-auth 1.6.9 decodes
// without verifying (a code-flow token comes straight from Google over TLS).
// Loops records the emails it is asked to send, which is how a test reads the
// reset link out of the owner's inbox.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { getAuth } from "./auth.js";

const ORIGIN = "http://localhost";
const EMAIL = "victim@gmail.com";
const PASSWORD = "attacker-password-123";
const NEW_PASSWORD = "owner-password-456";
const GOOGLE_SUB = "google-sub-victim";
const STRANGER_SUB = "google-sub-stranger";
const GOOGLE_RETURN_URL = "/?auth=google";
const RESET_TEMPLATE = "test-reset-template";
// Every password hash or check is a scrypt run of well over a second under
// workerd, so a test that signs up, resets and signs in twice outlasts
// vitest's 5s default.
const PASSWORD_TEST_TIMEOUT_MS = 30_000;

const authEnv = {
  ...env,
  BETTER_AUTH_URL: ORIGIN,
  BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-0123",
  GOOGLE_CLIENT_ID: "test-client-id",
  GOOGLE_CLIENT_SECRET: "test-client-secret",
  LOOPS_API_KEY: "test-loops-key",
  LOOPS_TEMPLATE_WELCOME: "test-welcome-template",
  LOOPS_TEMPLATE_RESET: RESET_TEMPLATE,
};

let auth;
// The identity Google's stubbed token endpoint vouches for next.
let googleIdentity;
// Every email the stubbed Loops endpoint was asked to send.
let emails;

beforeEach(async () => {
  await env.DB.exec("DELETE FROM race_results");
  await env.DB.exec("DELETE FROM session");
  await env.DB.exec("DELETE FROM account");
  await env.DB.exec(`DELETE FROM "user"`);
  auth = getAuth(authEnv);
  googleIdentity = null;
  emails = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url === "https://app.loops.so/api/v1/transactional") {
      emails.push(JSON.parse(init.body));
      return Response.json({ success: true });
    }
    if (!url.startsWith("https://oauth2.googleapis.com/token")) {
      throw new Error(`unexpected outbound fetch: ${url}`);
    }
    return Response.json({
      access_token: "google-access-token",
      id_token: googleIdToken(googleIdentity),
      token_type: "Bearer",
      expires_in: 3600,
      scope: "openid email profile",
    });
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

// --- helpers ---------------------------------------------------------------

function b64url(obj) {
  return btoa(JSON.stringify(obj)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function googleIdToken(identity) {
  return `${b64url({ alg: "RS256", typ: "JWT" })}.${b64url({
    iss: "https://accounts.google.com",
    aud: authEnv.GOOGLE_CLIENT_ID,
    sub: identity.sub,
    email: identity.email,
    email_verified: identity.emailVerified ?? true,
    name: "Google Name",
  })}.sig`;
}

/** Merge a response's Set-Cookie headers into a `name=value; ...` jar. */
function absorbCookies(jar, res) {
  for (const line of res.headers.getSetCookie()) {
    const [pair] = line.split(";");
    const eq = pair.indexOf("=");
    jar.set(pair.slice(0, eq).trim(), pair.slice(eq + 1));
  }
  return jar;
}

function cookieHeader(jar) {
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}

async function call(path, { method = "GET", body, jar = new Map() } = {}) {
  const headers = { origin: ORIGIN };
  if (body) headers["content-type"] = "application/json";
  if (jar.size) headers.cookie = cookieHeader(jar);
  const res = await auth.handler(
    new Request(`${ORIGIN}/api/auth${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      redirect: "manual",
    }),
  );
  absorbCookies(jar, res);
  return res;
}

/** Register a password account; `jar` ends up holding its autoSignIn session. */
async function signUpWithPassword(jar = new Map()) {
  const res = await call("/sign-up/email", {
    method: "POST",
    body: { email: EMAIL, password: PASSWORD, name: "Squatter" },
    jar,
  });
  expect(res.status).toBe(200);
  return (await res.json()).user;
}

async function signInWithPassword(password = PASSWORD) {
  const jar = new Map();
  const res = await call("/sign-in/email", {
    method: "POST",
    body: { email: EMAIL, password },
    jar,
  });
  return { res, jar };
}

/**
 * Run the Google redirect round trip the way the client starts it, then land
 * on the callback as Google would. Returns the callback response and the
 * cookie jar the browser ends up holding.
 */
async function googleRoundTrip(identity) {
  googleIdentity = identity;
  const jar = new Map();
  const start = await call("/sign-in/social", {
    method: "POST",
    body: {
      provider: "google",
      callbackURL: GOOGLE_RETURN_URL,
      errorCallbackURL: GOOGLE_RETURN_URL,
    },
    jar,
  });
  expect(start.status).toBe(200);
  const { url } = await start.json();
  const state = new URL(url).searchParams.get("state");
  const res = await call(`/callback/google?code=test-code&state=${state}`, { jar });
  return { res, jar };
}

/** The app page a redirect lands on, reduced to what the client reads off it. */
function landing(res) {
  const url = new URL(res.headers.get("location"), ORIGIN);
  return {
    path: url.pathname,
    auth: url.searchParams.get("auth"),
    error: url.searchParams.get("error"),
  };
}

/** Request a reset, follow the link from the emailed message, set a new password. */
async function resetPassword() {
  const request = await call("/request-password-reset", {
    method: "POST",
    body: { email: EMAIL, redirectTo: `${ORIGIN}/reset-password.html` },
  });
  expect(request.status).toBe(200);
  const email = emails.findLast((e) => e.transactionalId === RESET_TEMPLATE && e.email === EMAIL);
  const token = new URL(email.dataVariables.resetUrl).pathname.split("/").pop();

  const res = await call("/reset-password", {
    method: "POST",
    body: { token, newPassword: NEW_PASSWORD },
  });
  expect(res.status).toBe(200);
}

async function sessionUser(jar) {
  const res = await call("/get-session", { jar });
  const body = await res.json();
  return body?.user ?? null;
}

async function accountsFor(userId) {
  const { results } = await env.DB
    .prepare(`SELECT "providerId", "accountId" FROM account WHERE "userId" = ? ORDER BY "providerId"`)
    .bind(userId)
    .all();
  return results;
}

async function userRow(email = EMAIL) {
  return env.DB.prepare(`SELECT id, "emailVerified" FROM "user" WHERE email = ?`).bind(email).first();
}

/**
 * The row a stranger's unverified Google identity left before such sign-ups
 * were refused: an unverified user whose only account is that identity.
 */
async function seedGoogleSquat() {
  const id = "google-squat-user";
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB
      .prepare(
        `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt")
         VALUES (?, 'Stranger', ?, 0, ?, ?)`,
      )
      .bind(id, EMAIL, now, now),
    env.DB
      .prepare(
        `INSERT INTO account (id, "accountId", "providerId", "userId", "createdAt", "updatedAt")
         VALUES ('google-squat-account', ?, 'google', ?, ?, ?)`,
      )
      .bind(STRANGER_SUB, id, now, now),
  ]);
  return id;
}

// --- tests -----------------------------------------------------------------

describe("Google sign-in into a pre-registered unverified account", { timeout: PASSWORD_TEST_TIMEOUT_MS }, () => {
  it("refuses the link: no Google account, no verified flag, no session", async () => {
    // A stranger registers the victim's address with a password and never
    // verifies it; later the victim signs in with Google.
    const squatter = await signUpWithPassword();
    expect((await userRow()).emailVerified).toBe(0);

    const { res, jar } = await googleRoundTrip({ sub: GOOGLE_SUB, email: EMAIL });

    expect(res.status).toBe(302);
    expect(await sessionUser(jar)).toBeNull();
    expect(await accountsFor(squatter.id)).toEqual([
      { providerId: "credential", accountId: squatter.id },
    ]);
    expect((await userRow()).emailVerified).toBe(0);
  });

  it("sends the browser back into the app with the reason, not to better-auth's error page", async () => {
    await signUpWithPassword();

    const { res } = await googleRoundTrip({ sub: GOOGLE_SUB, email: EMAIL });

    expect(landing(res)).toEqual({
      path: "/",
      auth: "google",
      error: "ACCOUNT_LINK_REQUIRES_VERIFIED_EMAIL",
    });
  });

  it("keeps refusing on a second attempt", async () => {
    await signUpWithPassword();
    await googleRoundTrip({ sub: GOOGLE_SUB, email: EMAIL });
    const { res, jar } = await googleRoundTrip({ sub: GOOGLE_SUB, email: EMAIL });

    expect(landing(res).error).toBe("ACCOUNT_LINK_REQUIRES_VERIFIED_EMAIL");
    expect(await sessionUser(jar)).toBeNull();
  });
});

describe("the owner taking a squatted address back with a password reset", { timeout: PASSWORD_TEST_TIMEOUT_MS }, () => {
  it("verifies the email, so the owner's Google sign-in then joins the account", async () => {
    const squatter = await signUpWithPassword();

    await resetPassword();
    expect((await userRow()).emailVerified).toBe(1);

    const { res, jar } = await googleRoundTrip({ sub: GOOGLE_SUB, email: EMAIL });
    expect(res.headers.get("location")).toBe(GOOGLE_RETURN_URL);
    expect((await sessionUser(jar))?.id).toBe(squatter.id);
    expect(await accountsFor(squatter.id)).toEqual([
      { providerId: "credential", accountId: squatter.id },
      { providerId: "google", accountId: GOOGLE_SUB },
    ]);
  });

  it("signs the squatter out and locks their password out", async () => {
    const squatterJar = new Map();
    await signUpWithPassword(squatterJar);
    expect(await sessionUser(squatterJar)).not.toBeNull();

    await resetPassword();

    expect(await sessionUser(squatterJar)).toBeNull();
    expect((await signInWithPassword(PASSWORD)).res.status).toBe(401);
    expect((await signInWithPassword(NEW_PASSWORD)).res.status).toBe(200);
  });

  it("detaches a stranger's Google identity, so only the owner's Google sign-in reaches the account", async () => {
    const squatId = await seedGoogleSquat();
    const stranger = { sub: STRANGER_SUB, email: EMAIL, emailVerified: false };
    const owner = { sub: GOOGLE_SUB, email: EMAIL };
    const strangerJar = (await googleRoundTrip(stranger)).jar;
    expect((await sessionUser(strangerJar))?.id).toBe(squatId);

    const refused = await googleRoundTrip(owner);
    expect(landing(refused.res).error).toBe("ACCOUNT_LINK_REQUIRES_VERIFIED_EMAIL");
    expect(await sessionUser(refused.jar)).toBeNull();

    await resetPassword();

    expect(await sessionUser(strangerJar)).toBeNull();
    expect(await sessionUser((await googleRoundTrip(stranger)).jar)).toBeNull();

    const { res, jar } = await googleRoundTrip(owner);
    expect(res.headers.get("location")).toBe(GOOGLE_RETURN_URL);
    expect((await sessionUser(jar))?.id).toBe(squatId);
    expect(await accountsFor(squatId)).toEqual([
      { providerId: "credential", accountId: squatId },
      { providerId: "google", accountId: GOOGLE_SUB },
    ]);
  });

  it("keeps the Google identity of an already verified user", async () => {
    const first = await googleRoundTrip({ sub: GOOGLE_SUB, email: EMAIL });
    const id = (await sessionUser(first.jar)).id;

    await resetPassword();

    expect(await accountsFor(id)).toEqual([
      { providerId: "credential", accountId: id },
      { providerId: "google", accountId: GOOGLE_SUB },
    ]);
    const { jar } = await googleRoundTrip({ sub: GOOGLE_SUB, email: EMAIL });
    expect((await sessionUser(jar))?.id).toBe(id);
  });
});

describe("Google sign-up with an email Google has not verified", () => {
  it("is refused before any user row is written", async () => {
    const { res, jar } = await googleRoundTrip({
      sub: STRANGER_SUB,
      email: EMAIL,
      emailVerified: false,
    });

    expect(res.status).toBe(302);
    expect(await sessionUser(jar)).toBeNull();
    expect(await userRow()).toBeNull();
    expect(await env.DB.prepare(`SELECT COUNT(*) AS n FROM account`).first("n")).toBe(0);
  });

  it("sends the browser back into the app with the reason", async () => {
    const { res } = await googleRoundTrip({
      sub: STRANGER_SUB,
      email: EMAIL,
      emailVerified: false,
    });

    expect(landing(res)).toEqual({
      path: "/",
      auth: "google",
      error: "OAUTH_EMAIL_NOT_VERIFIED",
    });
  });
});

describe("Google sign-in that must keep working", { timeout: PASSWORD_TEST_TIMEOUT_MS }, () => {
  it("creates a new verified user on first sign-in", async () => {
    const { res, jar } = await googleRoundTrip({ sub: GOOGLE_SUB, email: EMAIL });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe(GOOGLE_RETURN_URL);
    const user = await sessionUser(jar);
    expect(user?.email).toBe(EMAIL);
    expect(user?.emailVerified).toBe(true);
    expect(await accountsFor(user.id)).toEqual([{ providerId: "google", accountId: GOOGLE_SUB }]);
  });

  it("signs a returning Google user back in", async () => {
    const first = await googleRoundTrip({ sub: GOOGLE_SUB, email: EMAIL });
    const id = (await sessionUser(first.jar)).id;

    const { res, jar } = await googleRoundTrip({ sub: GOOGLE_SUB, email: EMAIL });

    expect(res.headers.get("location")).toBe(GOOGLE_RETURN_URL);
    expect((await sessionUser(jar))?.id).toBe(id);
    expect(await accountsFor(id)).toHaveLength(1);
  });

  it("links Google into an existing verified password account", async () => {
    const owner = await signUpWithPassword();
    await env.DB.prepare(`UPDATE "user" SET "emailVerified" = 1 WHERE id = ?`).bind(owner.id).run();

    const { res, jar } = await googleRoundTrip({ sub: GOOGLE_SUB, email: EMAIL });

    expect(res.headers.get("location")).toBe(GOOGLE_RETURN_URL);
    expect((await sessionUser(jar))?.id).toBe(owner.id);
    expect(await accountsFor(owner.id)).toEqual([
      { providerId: "credential", accountId: owner.id },
      { providerId: "google", accountId: GOOGLE_SUB },
    ]);
  });

  it("still lets the password owner sign in after a refused link", async () => {
    await signUpWithPassword();
    await googleRoundTrip({ sub: GOOGLE_SUB, email: EMAIL });

    const { res } = await signInWithPassword();
    expect(res.status).toBe(200);
  });
});
