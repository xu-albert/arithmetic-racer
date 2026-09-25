// Account-linking tests for the better-auth config in worker/auth.js.
//
// Drives the real auth handler against this file's D1: email sign-up, the
// Google OAuth redirect and callback, and explicit linking. Only Google itself
// is stubbed — its token endpoint answers with an id_token carrying whatever
// identity the test chooses, which better-auth 1.6.9 decodes without verifying
// (a code-flow token comes straight from Google over TLS).

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { env } from "cloudflare:test";
import { getAuth } from "./auth.js";

const ORIGIN = "http://localhost";
const EMAIL = "victim@gmail.com";
const PASSWORD = "attacker-password-123";
const GOOGLE_SUB = "google-sub-victim";

const authEnv = {
  ...env,
  BETTER_AUTH_URL: ORIGIN,
  BETTER_AUTH_SECRET: "test-secret-test-secret-test-secret-0123",
  GOOGLE_CLIENT_ID: "test-client-id",
  GOOGLE_CLIENT_SECRET: "test-client-secret",
};

let auth;
// The identity Google's stubbed token endpoint vouches for next.
let googleIdentity;

beforeEach(async () => {
  await env.DB.exec("DELETE FROM race_results");
  await env.DB.exec("DELETE FROM session");
  await env.DB.exec("DELETE FROM account");
  await env.DB.exec(`DELETE FROM "user"`);
  auth = getAuth(authEnv);
  googleIdentity = null;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = input instanceof Request ? input.url : String(input);
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

async function signUpWithPassword(email = EMAIL) {
  const res = await call("/sign-up/email", {
    method: "POST",
    body: { email, password: PASSWORD, name: "Squatter" },
  });
  expect(res.status).toBe(200);
  return (await res.json()).user;
}

async function signInWithPassword(email = EMAIL) {
  const jar = new Map();
  const res = await call("/sign-in/email", {
    method: "POST",
    body: { email, password: PASSWORD },
    jar,
  });
  return { res, jar };
}

/**
 * Run the Google redirect round trip: start it from `startPath`, then land on
 * the callback as Google would. Returns the callback response and the cookie
 * jar the browser ends up holding.
 */
async function googleRoundTrip(identity, { startPath = "/sign-in/social", jar = new Map() } = {}) {
  googleIdentity = identity;
  const start = await call(startPath, {
    method: "POST",
    body: { provider: "google", callbackURL: "/?auth=google" },
    jar,
  });
  expect(start.status).toBe(200);
  const { url } = await start.json();
  const state = new URL(url).searchParams.get("state");
  const res = await call(`/callback/google?code=test-code&state=${state}`, { jar });
  return { res, jar };
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

// --- tests -----------------------------------------------------------------

describe("Google sign-in into a pre-registered unverified account", () => {
  it("refuses the link: no Google account, no verified flag, no session", async () => {
    // A stranger registers the victim's address with a password and never
    // verifies it; later the victim signs in with Google.
    const squatter = await signUpWithPassword();
    expect((await userRow()).emailVerified).toBe(0);

    const { res, jar } = await googleRoundTrip({ sub: GOOGLE_SUB, email: EMAIL });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toContain("error=unable_to_link_account");
    expect(await sessionUser(jar)).toBeNull();
    expect(await accountsFor(squatter.id)).toEqual([
      { providerId: "credential", accountId: squatter.id },
    ]);
    expect((await userRow()).emailVerified).toBe(0);
  });

  it("keeps refusing on a second attempt", async () => {
    await signUpWithPassword();
    await googleRoundTrip({ sub: GOOGLE_SUB, email: EMAIL });
    const { res, jar } = await googleRoundTrip({ sub: GOOGLE_SUB, email: EMAIL });

    expect(res.headers.get("location")).toContain("error=unable_to_link_account");
    expect(await sessionUser(jar)).toBeNull();
  });
});

describe("Google sign-in that must keep working", () => {
  it("creates a new verified user on first sign-in", async () => {
    const { res, jar } = await googleRoundTrip({ sub: GOOGLE_SUB, email: EMAIL });

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?auth=google");
    const user = await sessionUser(jar);
    expect(user?.email).toBe(EMAIL);
    expect(user?.emailVerified).toBe(true);
    expect(await accountsFor(user.id)).toEqual([{ providerId: "google", accountId: GOOGLE_SUB }]);
  });

  it("creates a new user even when Google reports the email unverified", async () => {
    const { res, jar } = await googleRoundTrip({
      sub: GOOGLE_SUB,
      email: EMAIL,
      emailVerified: false,
    });

    expect(res.headers.get("location")).toBe("/?auth=google");
    expect((await sessionUser(jar))?.email).toBe(EMAIL);
  });

  it("signs a returning Google user back in", async () => {
    const first = await googleRoundTrip({ sub: GOOGLE_SUB, email: EMAIL });
    const id = (await sessionUser(first.jar)).id;

    const { res, jar } = await googleRoundTrip({ sub: GOOGLE_SUB, email: EMAIL });

    expect(res.headers.get("location")).toBe("/?auth=google");
    expect((await sessionUser(jar))?.id).toBe(id);
    expect(await accountsFor(id)).toHaveLength(1);
  });

  it("links Google into an existing verified password account", async () => {
    const owner = await signUpWithPassword();
    await env.DB.prepare(`UPDATE "user" SET "emailVerified" = 1 WHERE id = ?`).bind(owner.id).run();

    const { res, jar } = await googleRoundTrip({ sub: GOOGLE_SUB, email: EMAIL });

    expect(res.headers.get("location")).toBe("/?auth=google");
    expect((await sessionUser(jar))?.id).toBe(owner.id);
    expect(await accountsFor(owner.id)).toEqual([
      { providerId: "credential", accountId: owner.id },
      { providerId: "google", accountId: GOOGLE_SUB },
    ]);
  });

  it("lets a signed-in unverified user explicitly link their own Google account", async () => {
    // /link-social runs with the target account's session and requires the
    // Google email to match it, so it proves ownership the implicit path cannot.
    const owner = await signUpWithPassword();
    const { res: signIn, jar } = await signInWithPassword();
    expect(signIn.status).toBe(200);

    const { res } = await googleRoundTrip(
      { sub: GOOGLE_SUB, email: EMAIL },
      { startPath: "/link-social", jar },
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/?auth=google");
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
