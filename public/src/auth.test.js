// Tests for the auth modal's Google return handling.
//
// Runs on `node --test` with no DOM, so what is exercised here is the request
// that starts Google sign-in and the reading of the page it comes back to. The
// server half — that a refused link redirects to errorCallbackURL with
// `error=ACCOUNT_LINK_REQUIRES_VERIFIED_EMAIL` — is tested against the real
// better-auth handler in worker/auth.test.js.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { startGoogleSignIn, readGoogleReturn, mapAuthError } from "./auth.js";

const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  delete globalThis.location;
});

/** Start Google sign-in against stubs; returns the body sent and the page navigated to. */
async function startSignIn() {
  let sent = null;
  let navigatedTo = null;
  globalThis.fetch = async (_url, init) => {
    sent = JSON.parse(init.body);
    return Response.json({ url: "https://accounts.google.com/o/oauth2/v2/auth", redirect: true });
  };
  globalThis.location = { assign: (url) => (navigatedTo = url) };
  await startGoogleSignIn();
  return { sent, navigatedTo };
}

test("Google sign-in asks better-auth to send failures back into the app", async () => {
  const { sent, navigatedTo } = await startSignIn();

  assert.equal(navigatedTo, "https://accounts.google.com/o/oauth2/v2/auth");
  assert.equal(sent.provider, "google");
  assert.equal(sent.errorCallbackURL, sent.callbackURL);
  assert.deepEqual(readGoogleReturn(new URL(sent.callbackURL, "http://localhost").search), {
    error: null,
    query: "",
  });
});

test("a refused link comes back explaining the existing account", async () => {
  const { sent } = await startSignIn();
  const back = new URL(sent.errorCallbackURL, "http://localhost");
  back.searchParams.set("error", "ACCOUNT_LINK_REQUIRES_VERIFIED_EMAIL");

  const googleReturn = readGoogleReturn(back.search);

  assert.deepEqual(googleReturn, { error: "ACCOUNT_LINK_REQUIRES_VERIFIED_EMAIL", query: "" });
  assert.equal(
    mapAuthError(googleReturn.error),
    "An account with this email already exists. Log in with its password, or reset the password if you didn't set it.",
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
