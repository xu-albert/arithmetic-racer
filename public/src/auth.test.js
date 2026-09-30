// Tests for the auth modal's Google return handling and pure error-copy map.
//
// Runs on `node --test` with no DOM, so what is exercised here is the request
// that starts Google sign-in and the reading of the page it comes back to. The
// server half — that a refused sign-in redirects to errorCallbackURL with
// `error=ACCOUNT_LINK_REQUIRES_VERIFIED_EMAIL` or `error=OAUTH_EMAIL_NOT_VERIFIED`
// — is tested against the real better-auth handler in worker/auth.test.js.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  buildGoogleReturnUrl,
  startGoogleSignIn,
  readGoogleReturn,
  mapAuthError,
} from "./auth.js";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  delete globalThis.location;
});

/** Start Google sign-in against stubs; returns the body sent and the page navigated to. */
async function startSignIn(location = {}) {
  let sent = null;
  let navigatedTo = null;
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(init.body);
    return Response.json({ url: "https://accounts.google.com/o/oauth2/v2/auth", redirect: true });
  };
  globalThis.location = { search: "", pathname: "/", assign: (url) => (navigatedTo = url), ...location };
  await startGoogleSignIn();
  return { sent, navigatedTo };
}

test("Google sign-in sends success and failure callbacks to the starting page", async () => {
  const { sent, navigatedTo } = await startSignIn({
    search: "?room=wild-tapir-hare&mode=public&difficulty=medium",
  });

  assert.equal(navigatedTo, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(sent.provider, "google");
  assert.equal(sent.errorCallbackURL, sent.callbackURL);
  assert.deepEqual(readGoogleReturn(new URL(sent.callbackURL, "http://localhost").search), {
    error: null,
    query: "room=wild-tapir-hare&mode=public&difficulty=medium",
  });
});

test("buildGoogleReturnUrl: bare lobby returns to the bare lobby", () => {
  assert.equal(buildGoogleReturnUrl(""), "/?auth=google");
  assert.equal(buildGoogleReturnUrl("", "/"), "/?auth=google");
});

test("buildGoogleReturnUrl: a room sign-in returns to the room", () => {
  assert.equal(
    buildGoogleReturnUrl("?room=wild-tapir-hare"),
    "/?room=wild-tapir-hare&auth=google",
  );
});

test("buildGoogleReturnUrl: quick-match mode and difficulty survive the round trip", () => {
  assert.equal(
    buildGoogleReturnUrl("?room=m-mighty-tapir-heron&mode=public&difficulty=medium"),
    "/?room=m-mighty-tapir-heron&mode=public&difficulty=medium&auth=google",
  );
});

test("buildGoogleReturnUrl: a stale auth marker is replaced, not duplicated", () => {
  assert.equal(buildGoogleReturnUrl("?auth=google"), "/?auth=google");
});

test("a refused link comes back explaining the existing account", async () => {
  const { sent } = await startSignIn();
  const back = new URL(sent.errorCallbackURL, "http://localhost");
  back.searchParams.set("error", "ACCOUNT_LINK_REQUIRES_VERIFIED_EMAIL");

  const googleReturn = readGoogleReturn(back.search);

  assert.deepEqual(googleReturn, { error: "ACCOUNT_LINK_REQUIRES_VERIFIED_EMAIL", query: "" });
  assert.equal(
    mapAuthError(googleReturn.error),
    "An account with this email already exists. Google sign-in stays blocked for it until you reset its password with \"Forgot password?\", which confirms you own this email. Until then you can keep logging in with its password; if you didn't set that password, reset it now.",
  );
});

test("a refused sign-up from an unverified Google email comes back explaining why", async () => {
  const { sent } = await startSignIn();
  const back = new URL(sent.errorCallbackURL, "http://localhost");
  back.searchParams.set("error", "OAUTH_EMAIL_NOT_VERIFIED");

  const googleReturn = readGoogleReturn(back.search);

  assert.deepEqual(googleReturn, { error: "OAUTH_EMAIL_NOT_VERIFIED", query: "" });
  assert.equal(
    mapAuthError(googleReturn.error),
    "Google hasn't verified this email address, so it can't be used to create an account. Verify it with Google, or sign up with email and password.",
  );
});

test("any other Google failure still comes back with a generic message", () => {
  const googleReturn = readGoogleReturn("?auth=google&error=access_denied&error_description=denied");

  assert.deepEqual(googleReturn, { error: "access_denied", query: "" });
  assert.equal(mapAuthError(googleReturn.error), "Something went wrong. Please try again.");
});

test("the return parameters are stripped and the rest of the query kept", () => {
  assert.deepEqual(readGoogleReturn("?room=brave-otter-sky&auth=google"), {
    error: null,
    query: "room=brave-otter-sky",
  });
});

test("a page load that is not a Google return is left alone", () => {
  assert.equal(readGoogleReturn(""), null);
  assert.equal(readGoogleReturn("?room=brave-otter-sky&error=nope"), null);
});

test("mapAuthError: duplicate-email signup names the real 1.6.9 code", () => {
  // Verified against a live worker: better-auth 1.6.9 returns
  // USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL (422), which used to fall through
  // to the generic message.
  assert.equal(
    mapAuthError("USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL"),
    "An account with that email already exists. Log in instead.",
  );
  assert.equal(
    mapAuthError("USER_ALREADY_EXISTS"),
    "An account with that email already exists. Log in instead.",
  );
});

test("mapAuthError: a malformed email rejected server-side says so", () => {
  assert.equal(mapAuthError("VALIDATION_ERROR"), "Enter a valid email address.");
});

test("mapAuthError: unknown codes stay generic", () => {
  assert.equal(mapAuthError("SOMETHING_NEW"), "Something went wrong. Please try again.");
  assert.equal(mapAuthError(undefined), "Something went wrong. Please try again.");
});
