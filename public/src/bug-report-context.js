// The single source of truth for everything a bug report attaches beyond the
// words the reporter typed.
//
// Both halves read this one list: public/bug-report.html builds its request
// payload *and* renders its on-page disclosure from it, and
// worker/routes/contact.js derives its storage allowlist from it. That is the
// point — a hand-written disclosure can drift from what is actually sent, a
// generated one cannot. A field that is not declared here is neither collected
// nor stored; a field that is declared here is shown to the reporter before
// they press send.
//
// This file lives under public/src/ because that is the one place both sides
// can reach: public/ has no build step, so the browser loads it as an ES module
// exactly as written, and the Worker is esbuild-bundled, so the same file
// imports cleanly there. Keep it dependency-free — the `collect` and `preview`
// functions take a window rather than reaching for a global, so they run under
// node:test too.

/**
 * @typedef {object} BugContextField
 * @property {string} key Key in the request payload and in the stored row.
 * @property {string} label Human label, shown to the reporter.
 * @property {"client"|"server"} source Where the value comes from. The server
 *   never reads a server-sourced field off the request body, so those cannot be
 *   spoofed by a report claiming to be something it isn't.
 * @property {"text"|"number"|"boolean"} type
 * @property {"context"|"column"} storedIn Whether the row keeps it inside the
 *   `context` JSON blob or in a column of its own.
 * @property {number} [maxLength] Cap the server applies to a text field.
 * @property {boolean} [pathOnly] Strip query string and fragment before storing.
 * @property {boolean} [optIn] Not sent unless the reporter explicitly asks for it.
 * @property {string} [optInLabel] Checkbox label for an opt-in field.
 * @property {string} [optInHint] Explains to the reporter what ticking it means.
 * @property {(win: Window) => string|number|undefined} [collect] Client fields.
 * @property {(win: Window) => string|undefined} [preview] A server-sourced field
 *   whose real value the browser can nonetheless show truthfully.
 * @property {string} [description] Shown in place of a value when the browser
 *   cannot know what the server will record.
 */

/** @type {BugContextField[]} */
export const BUG_CONTEXT_FIELDS = [
  {
    key: "page",
    label: "Page you came from",
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
    label: "Screen size",
    source: "client",
    type: "text",
    storedIn: "context",
    maxLength: 32,
    collect: (win) => `${win.screen.width}x${win.screen.height}`,
  },
  {
    key: "viewport",
    label: "Window size",
    source: "client",
    type: "text",
    storedIn: "context",
    maxLength: 32,
    collect: (win) => `${win.innerWidth}x${win.innerHeight}`,
  },
  {
    key: "dpr",
    label: "Pixel ratio",
    source: "client",
    type: "number",
    storedIn: "context",
    collect: (win) => Math.round((win.devicePixelRatio || 1) * 100) / 100,
  },
  {
    key: "ua",
    label: "Browser and OS",
    source: "server",
    type: "text",
    storedIn: "context",
    description: "the identification string your browser sends with every request",
    preview: (win) => win.navigator?.userAgent,
  },
  {
    key: "browser",
    label: "Browser name and version",
    source: "server",
    type: "text",
    storedIn: "context",
    description: "read from the line above — for example “Chrome 141”",
  },
  {
    key: "os",
    label: "Operating system",
    source: "server",
    type: "text",
    storedIn: "context",
    description: "read from the line above — for example “macOS”",
  },
  {
    key: "app_version",
    label: "App version",
    source: "server",
    type: "text",
    storedIn: "context",
    description: "the version of Arithmetic Racer serving this page",
  },
  {
    key: "signed_in",
    label: "Whether you are signed in",
    source: "server",
    type: "boolean",
    storedIn: "context",
    description: "yes or no, from your session — not your account details",
  },
  {
    // The one opt-in field, and the only one that is an identity link rather
    // than technical context: the device ID joins this report to the reporter's
    // entire race history through race_results.device_id. Everything else above
    // describes the browser the bug happened in; this describes the person. That
    // linkage is genuinely useful when triaging a "my times are wrong" report,
    // but it is only worth having if the reporter agrees to it, so it defaults
    // off and is sent only when the box is ticked.
    key: "device_id",
    label: "Your device ID",
    source: "client",
    type: "text",
    storedIn: "column",
    maxLength: 128,
    optIn: true,
    optInLabel: "Link this report to my past races",
    optInHint:
      "Attaches the random device ID this browser saved, which lets us look up the " +
      "races you have played on this device. Off unless you tick it.",
    collect: (win) => win.localStorage?.getItem("deviceId") || undefined,
  },
];

/** Client-supplied fields the server keeps inside the `context` blob. */
export const CLIENT_CONTEXT_FIELDS = BUG_CONTEXT_FIELDS.filter(
  (field) => field.source === "client" && field.storedIn === "context"
);

/** Fields the server determines itself and never reads from the request body. */
export const SERVER_CONTEXT_FIELDS = BUG_CONTEXT_FIELDS.filter(
  (field) => field.source === "server"
);

/** @returns {BugContextField|undefined} */
export function bugContextField(key) {
  return BUG_CONTEXT_FIELDS.find((field) => field.key === key);
}

function isSent(field, optIn) {
  return !field.optIn || optIn.includes(field.key);
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
 * Build the context half of the request payload straight from the descriptor.
 *
 * @param {Window} win
 * @param {{ optIn?: string[] }} [options] Keys of opt-in fields the reporter ticked.
 * @returns {{ context: object, [key: string]: unknown }} Spread into the request body.
 */
export function collectBugPayload(win, { optIn = [] } = {}) {
  const payload = { context: {} };
  for (const field of BUG_CONTEXT_FIELDS) {
    if (field.source !== "client" || !isSent(field, optIn)) continue;
    const value = readValue(win, field.collect);
    if (value === undefined) continue;
    if (field.storedIn === "column") payload[field.key] = value;
    else payload.context[field.key] = value;
  }
  return payload;
}

/**
 * The disclosure shown to the reporter, derived from the same descriptor as the
 * payload, so the list is what is sent rather than a description of it. Client
 * fields show the value being attached; server fields show the real value where
 * the browser can know it and a plain description where it cannot.
 *
 * @param {Window} win
 * @param {{ optIn?: string[] }} [options]
 * @returns {{ key: string, label: string, value: string }[]}
 */
export function describeBugContext(win, { optIn = [] } = {}) {
  const rows = [];
  for (const field of BUG_CONTEXT_FIELDS) {
    if (!isSent(field, optIn)) continue;
    if (field.source === "client") {
      const value = readValue(win, field.collect);
      if (value === undefined) continue;
      rows.push({ key: field.key, label: field.label, value: String(value) });
      continue;
    }
    const previewed = field.preview ? readValue(win, field.preview) : undefined;
    rows.push({ key: field.key, label: field.label, value: String(previewed ?? field.description) });
  }
  return rows;
}
