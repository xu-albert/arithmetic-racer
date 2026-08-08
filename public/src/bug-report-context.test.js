// Tests for the bug-report context descriptor, the payload built from it, and
// the privacy page held to it.
//
// The invariant worth defending is that one list governs three places: what the
// browser attaches, what the Worker will read out of a request body, and what
// the reporter can read about it. The form itself says nothing about data, so
// the privacy page is the only account there is — G2 below is what stops a
// field being collected without one.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  BUG_CONTEXT_FIELDS,
  CLIENT_CONTEXT_FIELDS,
  COLUMN_FIELDS,
  collectBugPayload,
} from "./bug-report-context.js";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/141.0.0.0";

function fakeWindow(overrides = {}) {
  const { referrer = "https://racer.test/race/hard", store = { deviceId: "dev-abc" } } = overrides;
  return {
    document: { referrer },
    location: { origin: "https://racer.test", href: "https://racer.test/bug-report" },
    screen: { width: 3024, height: 1964 },
    innerWidth: 1512,
    innerHeight: 845,
    devicePixelRatio: 2,
    navigator: { userAgent: UA },
    localStorage: { getItem: (key) => store[key] ?? null },
    ...overrides.window,
  };
}

test("collects the technical context the browser can see", () => {
  const { context } = collectBugPayload(fakeWindow());
  assert.equal(context.screen, "3024x1964");
  assert.equal(context.viewport, "1512x845");
  assert.equal(context.dpr, 2);
  assert.equal(context.page, "/race/hard");
});

test("attaches the device id on every report", () => {
  // No checkbox and no conditional send: the form asks nothing and promises
  // nothing, and public/privacy.html accounts for what that means.
  const payload = collectBugPayload(fakeWindow());
  assert.equal(payload.device_id, "dev-abc");
  // It belongs to the row's own column, not the context blob.
  assert.equal("device_id" in payload.context, false);
});

test("omits the device id when the browser has none stored", () => {
  const payload = collectBugPayload(fakeWindow({ store: {} }));
  assert.equal("device_id" in payload, false);
});

test("never sends a server-determined field from the client", () => {
  // The account id is read from the session and the user agent from the
  // request header; a report must not be able to claim either.
  const payload = collectBugPayload(fakeWindow());
  const sent = new Set([...Object.keys(payload.context), ...Object.keys(payload)]);
  for (const field of BUG_CONTEXT_FIELDS.filter((f) => f.source === "server")) {
    assert.equal(sent.has(field.key), false, `${field.key} must not be client-sent`);
  }
});

test("keeps no page for a cross-origin referrer", () => {
  const { context } = collectBugPayload(fakeWindow({ referrer: "https://elsewhere.test/x" }));
  assert.equal("page" in context, false);
});

test("keeps no page when there is no referrer at all", () => {
  const { context } = collectBugPayload(fakeWindow({ referrer: "" }));
  assert.equal("page" in context, false);
});

test("a browser that refuses to answer does not block the report", () => {
  // Blocked localStorage, no screen: collection is a convenience and must
  // degrade to less context rather than to a thrown submit handler.
  const hostile = fakeWindow({
    window: {
      localStorage: {
        getItem() {
          throw new Error("blocked");
        },
      },
      screen: undefined,
    },
  });
  const payload = collectBugPayload(hostile);
  assert.equal("device_id" in payload, false);
  assert.equal("screen" in payload.context, false);
  assert.equal(payload.context.viewport, "1512x845");
});

test("the request-body allowlist admits only context-blob fields", () => {
  // The Worker reads nothing else out of a submitted body. Declaring a cookie,
  // a rate-limit record or a new column must never widen that, which is why the
  // allowlist narrows on storedIn and not only on source.
  for (const field of CLIENT_CONTEXT_FIELDS) {
    assert.equal(field.storedIn, "context");
    assert.equal(field.source, "client");
  }
  const admitted = new Set(CLIENT_CONTEXT_FIELDS.map((f) => f.key));
  for (const field of BUG_CONTEXT_FIELDS) {
    if (field.storedIn !== "context" || field.source !== "client") {
      assert.equal(admitted.has(field.key), false, `${field.key} must stay out of the allowlist`);
    }
  }
});

test("every declared field carries what its consumers need", () => {
  const seen = new Set();
  for (const field of BUG_CONTEXT_FIELDS) {
    assert.equal(seen.has(field.key), false, `duplicate key ${field.key}`);
    seen.add(field.key);
    assert.ok(["client", "server"].includes(field.source));
    assert.ok(["context", "column", "request", "rate-limit"].includes(field.storedIn));
    if (field.source === "client") assert.equal(typeof field.collect, "function");
    if (field.source === "server") assert.equal(field.collect, undefined);
    if (field.type === "text" && field.source === "client") {
      assert.equal(typeof field.maxLength, "number");
    }
  }
  assert.deepEqual(
    COLUMN_FIELDS.map((f) => f.key).sort(),
    BUG_CONTEXT_FIELDS.filter((f) => f.storedIn === "column").map((f) => f.key).sort()
  );
});

// --- G2: the privacy page documents every declared field --------------------
//
// public/privacy.html is served byte-for-byte to the reporter, and the
// `data-collects` attribute in its "what is stored" table is a deliberately
// owned contract: each value names the descriptor key that the sentence it
// wraps documents. That attribute set — not the prose around it — is what this
// asserts on, so rewording a sentence is free and dropping a field is not.

const PRIVACY_HTML = join(dirname(fileURLToPath(import.meta.url)), "..", "privacy.html");

function documentedFieldKeys() {
  const html = readFileSync(PRIVACY_HTML, "utf8");
  const keys = new Set();
  for (const [, value] of html.matchAll(/\sdata-collects="([^"]*)"/g)) {
    for (const key of value.split(/\s+/).filter(Boolean)) keys.add(key);
  }
  return keys;
}

test("the privacy page documents every field the descriptor declares", () => {
  const documented = documentedFieldKeys();
  const missing = BUG_CONTEXT_FIELDS.map((f) => f.key).filter((key) => !documented.has(key));
  assert.deepEqual(
    missing,
    [],
    `collected but not documented on the privacy page: ${missing.join(", ")}`
  );
});

test("the privacy page documents nothing the descriptor does not declare", () => {
  // The other direction, so a marker left behind by a removed field is caught
  // rather than quietly claiming something is collected when it is not.
  const declared = new Set(BUG_CONTEXT_FIELDS.map((f) => f.key));
  const stale = [...documentedFieldKeys()].filter((key) => !declared.has(key));
  assert.deepEqual(stale, [], `documented but not collected: ${stale.join(", ")}`);
});
