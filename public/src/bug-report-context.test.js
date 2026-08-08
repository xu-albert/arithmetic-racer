// Tests for the bug-report context descriptor and the two functions derived
// from it. The invariant worth defending here is that the disclosure the
// reporter reads and the payload the form sends come from the same declaration:
// a field can be added, but it cannot be added silently.

import test from "node:test";
import assert from "node:assert/strict";
import {
  BUG_CONTEXT_FIELDS,
  collectBugPayload,
  describeBugContext,
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

const serverKeys = () =>
  BUG_CONTEXT_FIELDS.filter((f) => f.source === "server").map((f) => f.key);

/** Every key the payload actually carries, context blob and columns alike. */
function sentKeys(payload) {
  return [...Object.keys(payload.context), ...Object.keys(payload).filter((k) => k !== "context")];
}

test("collects the technical context the browser can see", () => {
  const { context } = collectBugPayload(fakeWindow());
  assert.equal(context.screen, "3024x1964");
  assert.equal(context.viewport, "1512x845");
  assert.equal(context.dpr, 2);
  assert.equal(context.page, "/race/hard");
});

test("sends no device id unless the reporter opted in", () => {
  const payload = collectBugPayload(fakeWindow());
  assert.equal("device_id" in payload, false);
  assert.equal("device_id" in payload.context, false);
});

test("sends the device id when the reporter opted in", () => {
  const payload = collectBugPayload(fakeWindow(), { optIn: ["device_id"] });
  assert.equal(payload.device_id, "dev-abc");
  // It belongs to the row, not the context blob — that is where the column is.
  assert.equal("device_id" in payload.context, false);
});

test("omits the device id when opted in but the browser has none stored", () => {
  const payload = collectBugPayload(fakeWindow({ store: {} }), { optIn: ["device_id"] });
  assert.equal("device_id" in payload, false);
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
  const payload = collectBugPayload(hostile, { optIn: ["device_id"] });
  assert.equal("device_id" in payload, false);
  assert.equal("screen" in payload.context, false);
  assert.equal(payload.context.viewport, "1512x845");
});

test("the disclosure lists exactly what is sent, plus the server-supplied fields", () => {
  // The reason the descriptor exists: a hand-written disclosure drifts from the
  // payload, a generated one cannot. Holds with the opt-in box either way.
  const win = fakeWindow();
  for (const optIn of [[], ["device_id"]]) {
    const shown = describeBugContext(win, { optIn }).map((row) => row.key);
    const expected = [...sentKeys(collectBugPayload(win, { optIn })), ...serverKeys()];
    assert.deepEqual(shown.slice().sort(), expected.slice().sort());
  }
});

test("the disclosure omits a field the browser could not collect", () => {
  const win = fakeWindow({ referrer: "" });
  assert.equal(
    describeBugContext(win).some((row) => row.key === "page"),
    false
  );
});

test("shows the real user agent rather than describing it", () => {
  const row = describeBugContext(fakeWindow()).find((r) => r.key === "ua");
  assert.equal(row.value, UA);
});

test("describes the server-derived fields the browser cannot know", () => {
  const rows = describeBugContext(fakeWindow());
  for (const key of ["browser", "os", "app_version", "signed_in", "user_id"]) {
    const row = rows.find((r) => r.key === key);
    assert.ok(row, `${key} must appear in the disclosure even though the client never sends it`);
    assert.ok(row.value.length > 0);
    assert.ok(row.label.length > 0);
  }
});

test("discloses the account link the request carries without the client sending it", () => {
  // The session cookie rides along on a same-origin submit, so a signed-in
  // report is linked to the account whatever the reporter ticks. The client
  // must not try to supply it, and the disclosure must still name it.
  const win = fakeWindow();
  const payload = collectBugPayload(win, { optIn: ["device_id"] });
  assert.equal("user_id" in payload, false);
  assert.equal("user_id" in payload.context, false);
  assert.ok(describeBugContext(win).some((row) => row.key === "user_id"));
});

test("every declared field carries what both sides need to handle it", () => {
  for (const field of BUG_CONTEXT_FIELDS) {
    assert.ok(field.label, `${field.key} needs a label to be disclosable`);
    assert.ok(["client", "server"].includes(field.source));
    assert.ok(["context", "column"].includes(field.storedIn));
    if (field.source === "client") assert.equal(typeof field.collect, "function");
    if (field.type === "text" && field.source === "client") {
      assert.equal(typeof field.maxLength, "number");
    }
    if (field.optIn) {
      assert.ok(field.optInLabel, `${field.key} is opt-in and needs a checkbox label`);
      assert.ok(field.optInHint, `${field.key} is opt-in and needs to say what ticking it means`);
    }
  }
});
