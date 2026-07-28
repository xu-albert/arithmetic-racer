// Structured error logging.
//
// Every call emits exactly one JSON line so Workers Observability can index
// the fields. Query by `kind` to find a class of failure without grepping
// free-form message text — `kind` is a closed vocabulary (see KINDS below),
// deliberately stable so saved queries and any future alerting keep working
// even when the surrounding message wording changes.
//
// The hard rule here: a logger must never throw. It runs inside catch blocks,
// so throwing would convert a handled error into an unhandled one and lose the
// original failure. Every input is treated as hostile.

/**
 * Closed vocabulary of log kinds. Documented rather than enforced — a typo'd
 * kind should still log rather than throw.
 */
export const KINDS = {
  RACE_RESULT_DB: "race_result_db",
  ROOM_MESSAGE: "room_message",
  CLAIM_FAILED: "claim_failed",
  WELCOME_EMAIL_FAILED: "welcome_email_failed",
  EMAIL_SEND_FAILED: "email_send_failed",
  LOBBY_RELEASE_FAILED: "lobby_release_failed",
  MATCHMAKING_KV: "matchmaking_kv",
  CONTACT_DB: "contact_db",
  CONTACT_NOTIFY_FAILED: "contact_notify_failed",
  CONTACT_RATE_LIMIT: "contact_rate_limit",
  RATE_LIMIT_UNAVAILABLE: "rate_limit_unavailable",
  RACE_RESULT_RATE_LIMITED: "race_result_rate_limited",
};

/**
 * Reduce any thrown value to a plain, serializable shape.
 * `JSON.stringify(new Error("boom"))` is `"{}"` — name/message/stack are
 * non-enumerable — so Errors must be unpacked by hand or the payload is empty.
 */
function serializeErr(err) {
  if (err instanceof Error) {
    return { name: err.name, message: err.message, stack: err.stack };
  }
  if (err === null || err === undefined) {
    return { name: "NonError", message: String(err) };
  }
  // A getter on a plain object can throw; String() on a Symbol throws too.
  try {
    return { name: "NonError", message: String(err.message ?? err) };
  } catch {
    return { name: "NonError", message: "<unserializable>" };
  }
}

function emit(level, kind, err, context) {
  const sink = level === "warn" ? console.warn : console.error;
  const payload = { level, kind, err: serializeErr(err), context: context ?? {} };
  let line;
  try {
    line = JSON.stringify(payload);
  } catch {
    // Circular or otherwise unserializable context. Drop the context rather
    // than the whole log line — kind and err are the parts worth keeping.
    line = JSON.stringify({
      level,
      kind,
      err: payload.err,
      context: {},
      context_error: "unserializable",
    });
  }
  sink(line);
}

/**
 * @param {string} kind One of KINDS.
 * @param {unknown} err The caught value.
 * @param {object} [context] Extra fields to index (ids, status codes).
 */
export function logError(kind, err, context) {
  emit("error", kind, err, context);
}

/** Same contract as logError, for recoverable/degraded paths. */
export function logWarn(kind, err, context) {
  emit("warn", kind, err, context);
}
