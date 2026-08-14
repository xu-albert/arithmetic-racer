// The single source of truth for everything a bug report carries beyond the
// words the reporter typed.
//
// Three things read this one list: public/bug-report.html builds its request
// payload from it, worker/routes/contact.js derives its storage allowlist from
// it, and public/privacy.html is held to it — a test asserts the privacy page
// documents every entry declared here, so a field cannot be collected without
// being written down somewhere the reporter can read it. The form itself makes
// no promises about data; the privacy page is the whole account.
//
// This file lives under public/src/ because that is the one place both halves
// can reach: public/ has no build step, so the browser loads it as an ES module
// exactly as written, and the Worker is esbuild-bundled, so the same file
// imports cleanly there. Keep it dependency-free — `collect` takes a window
// rather than reaching for a global, so it runs under node:test too.

/**
 * @typedef {object} BugContextField
 * @property {string} key Identifier for the field: its key in the request
 *   payload and stored row where it has one, and the value the privacy page
 *   marks the sentence documenting it with.
 * @property {"client"|"server"} source Where the value comes from. `server`
 *   means the request body is never consulted for it — it is read from the
 *   request itself or the session — so a report cannot spoof it by claiming to
 *   be something it isn't. Only `client` fields have a `collect`.
 * @property {"text"|"number"|"boolean"} type
 * @property {"context"|"column"|"request"|"rate-limit"} storedIn Where the
 *   value ends up. `context` is a key in the row's JSON blob and `column` is a
 *   column of its own; `request` travels with the request but is never written
 *   to the row, and `rate-limit` is held in Workers KV by the limiter rather
 *   than in D1. Only `context` entries can ever be read from the request body
 *   — see CLIENT_CONTEXT_FIELDS.
 * @property {number} [maxLength] Cap the server applies to a text field.
 * @property {boolean} [pathOnly] Strip query string and fragment before storing.
 * @property {(win: Window) => string|number|undefined} [collect] Client fields.
 */

/** @type {BugContextField[]} */
export const BUG_CONTEXT_FIELDS = [
  {
    key: "page",
    source: "client",
    type: "text",
    storedIn: "context",
    maxLength: 256,
    // Path only, deliberately. A URL on this site can carry a one-time
    // password-reset token (/reset-password?token=) or a private room's invite
    // slug (?room=); both are access credentials and neither is worth the
    // debugging value of the rest of the URL. The server strips them again.
    pathOnly: true,
    collect: (win) => {
      const referrer = win.document?.referrer;
      if (!referrer) return undefined;
      const from = new URL(referrer, win.location.href);
      return from.origin === win.location.origin ? from.pathname : undefined;
    },
  },
  {
    key: "screen",
    source: "client",
    type: "text",
    storedIn: "context",
    maxLength: 32,
    collect: (win) => `${win.screen.width}x${win.screen.height}`,
  },
  {
    key: "viewport",
    source: "client",
    type: "text",
    storedIn: "context",
    maxLength: 32,
    collect: (win) => `${win.innerWidth}x${win.innerHeight}`,
  },
  {
    key: "dpr",
    source: "client",
    type: "number",
    storedIn: "context",
    collect: (win) => Math.round((win.devicePixelRatio || 1) * 100) / 100,
  },
  {
    key: "ua",
    source: "server",
    type: "text",
    storedIn: "context",
  },
  {
    key: "browser",
    source: "server",
    type: "text",
    storedIn: "context",
  },
  {
    key: "os",
    source: "server",
    type: "text",
    storedIn: "context",
  },
  {
    key: "app_version",
    source: "server",
    type: "text",
    storedIn: "context",
  },
  {
    // The Cloudflare Worker Version id of the deploy that served the report —
    // the field that actually identifies a build, since app_version is bumped
    // by hand. Omitted when the runtime cannot supply one; see
    // worker/version.js.
    key: "deploy_id",
    source: "server",
    type: "text",
    storedIn: "context",
  },
  {
    key: "signed_in",
    source: "server",
    type: "boolean",
    storedIn: "context",
  },
  {
    // Read from the session, never from the body, so it is only ever the
    // account that actually filed the report.
    key: "user_id",
    source: "server",
    type: "text",
    storedIn: "column",
  },
  {
    // Joins the report to this browser's race history through
    // race_results.device_id, which is what makes a "my times are wrong"
    // report actionable for someone who never made an account.
    key: "device_id",
    source: "client",
    type: "text",
    storedIn: "column",
    maxLength: 128,
    collect: (win) => win.localStorage?.getItem("deviceId") || undefined,
  },
  {
    // Not stored on the row, but it is the reason user_id above can be known:
    // the submit is a same-origin fetch, so the browser attaches the sign-in
    // cookie by default. Declared so the privacy page has to account for it.
    key: "session_cookie",
    source: "server",
    type: "text",
    storedIn: "request",
  },
  {
    // Also not on the row: the per-IP counter the rate limiter writes to
    // Workers KV with a one-hour TTL. It outlives the request, so it belongs on
    // the same list as everything else the reporter is entitled to know about.
    key: "rate_limit_ip",
    source: "server",
    type: "text",
    storedIn: "rate-limit",
  },
];

/**
 * The Worker's allowlist: the only fields ever read out of the request body.
 * Narrowing on `storedIn === "context"` as well as `source` is what keeps a new
 * kind of declaration — a cookie, a rate-limit record, a future column — from
 * silently widening what a submitted body is allowed to write.
 */
export const CLIENT_CONTEXT_FIELDS = BUG_CONTEXT_FIELDS.filter(
  (field) => field.source === "client" && field.storedIn === "context"
);

/**
 * Fields the row keeps in a column of its own rather than in the `context`
 * blob. The guard test in worker/routes/contact.test.js compares the columns a
 * real submission persists against this list, so a column can only hold what
 * the descriptor declares.
 */
export const COLUMN_FIELDS = BUG_CONTEXT_FIELDS.filter(
  (field) => field.storedIn === "column"
);

/** @returns {BugContextField|undefined} */
export function bugContextField(key) {
  return BUG_CONTEXT_FIELDS.find((field) => field.key === key);
}

function readValue(win, read) {
  try {
    const value = read(win);
    return value === undefined || value === null || value === "" ? undefined : value;
  } catch {
    // Context is a convenience: a browser that refuses to answer (localStorage
    // blocked, screen unavailable) must never stop a report being filed.
    return undefined;
  }
}

/**
 * Build the client's half of the request payload straight from the descriptor.
 * Everything the browser can supply goes every time — the form asks nothing and
 * promises nothing, and public/privacy.html is where the reporter finds out
 * what that is.
 *
 * @param {Window} win
 * @returns {{ context: object, [key: string]: unknown }} Spread into the body.
 */
export function collectBugPayload(win) {
  const payload = { context: {} };
  for (const field of BUG_CONTEXT_FIELDS) {
    if (field.source !== "client" || !field.collect) continue;
    const value = readValue(win, field.collect);
    if (value === undefined) continue;
    if (field.storedIn === "column") payload[field.key] = value;
    else payload.context[field.key] = value;
  }
  return payload;
}
