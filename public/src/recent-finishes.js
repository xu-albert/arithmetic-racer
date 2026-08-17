// The lobby's "who's racing" strip — recent finishes, auto-refreshing.
//
// The point is perceived liveness, not statistics: newest first, one compact
// line per finish, and a relative timestamp that keeps counting up between
// fetches so the strip reads as something happening rather than a table that
// was rendered once. Contract: GET /api/recent-finishes, see
// worker/api-contracts.js. Eligibility (why solo races are absent and why
// anonymous racers are present): worker/routes/recent-finishes.js.
//
// Two cadences, deliberately different:
//
//   POLL_INTERVAL_MS — how often we ask the server for new rows. 20s. The
//     endpoint is uncached and D1 bills by rows read, so this is the number
//     that costs money; it is set to the slowest rate that still feels live.
//   TICK_INTERVAL_MS — how often the "3m ago" labels are recomputed from the
//     payload already in hand. 5s, and free: no network, no new rows.
//
// Both stop while the lobby is off-screen (in a room, mid-race) or the tab is
// hidden. A background tab polling a database forever is the failure mode this
// avoids.

export const POLL_INTERVAL_MS = 20_000;
export const TICK_INTERVAL_MS = 5_000;

const DIFFICULTY_LABELS = {
  easy: "easy",
  medium: "medium",
  hard: "hard",
};

/**
 * "just now" / "42s ago" / "7m ago" / "3h ago" / "2d ago".
 *
 * A negative age (device clock ahead of the server) prints "just now" rather
 * than a finish from the future.
 *
 * @param {number} ageMs Milliseconds since the race finished.
 */
export function formatAgo(ageMs) {
  if (!Number.isFinite(ageMs) || ageMs < 5_000) return "just now";
  const seconds = Math.floor(ageMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

/**
 * PPM for display. One decimal: the difference between 41.2 and 41.7 is real,
 * and the difference between 41.23 and 41.27 is noise.
 */
export function formatPpm(ppm) {
  if (typeof ppm !== "number" || !Number.isFinite(ppm)) return null;
  return ppm.toFixed(1);
}

/**
 * Points for display, or null when the race is unscored.
 *
 * Null and 0 are different things — 0 is a score a racer can earn — so an
 * unscored race omits the number rather than printing "0 pts". Rounded to a
 * whole point: stored points are REAL so sums stay exact, and rounding is
 * exactly this layer's job (worker/race-score.js).
 */
export function formatPoints(points) {
  if (typeof points !== "number" || !Number.isFinite(points)) return null;
  return String(Math.round(points));
}

/**
 * Turn a `/api/recent-finishes` payload into display-ready rows.
 *
 * Age is measured as the server saw it (`generated_at` − `played_at`) plus
 * however long the payload has been sitting in the client since. That keeps the
 * labels honest on a device with a skewed clock while still letting them tick
 * up between fetches.
 *
 * @param {object} payload      Response body.
 * @param {number} elapsedMs    Local milliseconds since the payload arrived.
 */
export function toFeedRows(payload, elapsedMs = 0) {
  const finishes = Array.isArray(payload?.finishes) ? payload.finishes : [];
  const generatedAt = Date.parse(payload?.generated_at ?? "");
  const since = Number.isFinite(elapsedMs) && elapsedMs > 0 ? elapsedMs : 0;

  return finishes.map((f) => {
    const playedAt = Date.parse(f?.played_at ?? "");
    const serverAge = Number.isFinite(generatedAt) && Number.isFinite(playedAt)
      ? generatedAt - playedAt
      : NaN;
    return {
      // A finish with no username is an anonymous racer. "Guest" is the label
      // the race screen already uses for one (public/main.js), so the feed
      // matches it rather than inventing a second word for the same thing.
      name: f?.username || "Guest",
      isGuest: !f?.username,
      difficulty: DIFFICULTY_LABELS[f?.difficulty] ?? f?.difficulty ?? "",
      ppm: formatPpm(f?.ppm),
      points: formatPoints(f?.points),
      ago: formatAgo(serverAge + since),
    };
  });
}

// --- DOM -------------------------------------------------------------------

/**
 * Render rows into `listEl`. Text is set with textContent throughout — a
 * username is user-supplied and must never be parsed as markup.
 *
 * Rebuilds the list rather than diffing it: at most 8 rows, once every few
 * seconds. Diffing here would be more code defending a smaller number.
 */
export function renderFeed(listEl, rows, { doc = listEl?.ownerDocument } = {}) {
  if (!listEl || !doc) return;
  listEl.textContent = "";

  for (const row of rows) {
    const li = doc.createElement("li");
    li.className = "finish-row";

    const name = doc.createElement("span");
    name.className = row.isGuest ? "finish-name finish-name-guest" : "finish-name";
    name.textContent = row.name;
    li.append(name);

    const detail = doc.createElement("span");
    detail.className = "finish-detail";
    const parts = [`finished ${row.difficulty}`];
    if (row.ppm) parts.push(`${row.ppm} ppm`);
    if (row.points) parts.push(`${row.points} pts`);
    detail.textContent = parts.join(" · ");
    li.append(detail);

    const when = doc.createElement("span");
    when.className = "finish-when";
    when.textContent = row.ago;
    li.append(when);

    listEl.append(li);
  }
}

/**
 * Wire the strip up to the endpoint.
 *
 * Every timer and fetch is injected so this is testable without a browser: the
 * suites here run on `node --test` with no DOM (docs/testing.md).
 *
 * @param {object} opts
 * @param {Element} opts.listEl      <ul> the rows go into.
 * @param {Element} [opts.emptyEl]   Shown instead when there is nothing to list.
 * @param {Element} [opts.sectionEl] Hidden entirely if the endpoint is unreachable.
 * @param {() => Promise<object>} opts.fetchFeed
 * @param {() => boolean} [opts.isActive] False while the lobby is off-screen.
 * @param {() => number} [opts.now]
 * @param {(fn: Function, ms: number) => any} [opts.setTimer]
 * @param {(handle: any) => void} [opts.clearTimer]
 * @param {(rows: object[]) => void} [opts.render]
 */
export function createRecentFinishesFeed({
  listEl,
  emptyEl,
  sectionEl,
  fetchFeed,
  isActive = () => true,
  now = () => Date.now(),
  setTimer = setInterval,
  clearTimer = clearInterval,
  pollIntervalMs = POLL_INTERVAL_MS,
  tickIntervalMs = TICK_INTERVAL_MS,
  render,
} = {}) {
  let payload = null;
  let fetchedAt = 0;
  let inFlight = false;
  let pollHandle = null;
  let tickHandle = null;

  const paint = render ?? ((rows) => {
    renderFeed(listEl, rows);
    const empty = rows.length === 0;
    if (emptyEl) emptyEl.classList.toggle("hidden", !empty);
    if (listEl) listEl.classList.toggle("hidden", empty);
  });

  function draw() {
    if (!payload) return;
    paint(toFeedRows(payload, now() - fetchedAt));
  }

  async function refresh() {
    // One request at a time. A slow response must not let the poll stack up.
    if (inFlight) return;
    inFlight = true;
    try {
      payload = await fetchFeed();
      fetchedAt = now();
      draw();
    } catch (err) {
      // The strip is decoration on a game lobby: a failed poll leaves the last
      // good rows up, and a strip that has never loaded stays out of the way
      // rather than showing an error nobody can act on.
      if (!payload && sectionEl) sectionEl.classList.add("hidden");
      console.warn("[recent-finishes] refresh failed", err);
    } finally {
      inFlight = false;
    }
  }

  function start() {
    if (pollHandle == null) {
      pollHandle = setTimer(() => {
        if (isActive()) refresh();
      }, pollIntervalMs);
    }
    if (tickHandle == null) {
      tickHandle = setTimer(() => {
        if (isActive()) draw();
      }, tickIntervalMs);
    }
  }

  function stop() {
    if (pollHandle != null) { clearTimer(pollHandle); pollHandle = null; }
    if (tickHandle != null) { clearTimer(tickHandle); tickHandle = null; }
  }

  return {
    refresh,
    /** Re-render the relative labels from the payload already in hand. */
    draw,
    start,
    stop,
    /** Fetch once, then keep it fresh. */
    async init() {
      await refresh();
      start();
    },
  };
}

/**
 * Browser wiring: find the elements, fetch from the real endpoint, and treat
 * "lobby visible and tab in the foreground" as the condition for polling.
 */
export function mountRecentFinishes(doc = document) {
  const sectionEl = doc.getElementById("recent-finishes");
  const listEl = doc.getElementById("recent-finishes-list");
  if (!sectionEl || !listEl) return null;
  const emptyEl = doc.getElementById("recent-finishes-empty");
  const lobbyEl = doc.getElementById("lobby");

  const feed = createRecentFinishesFeed({
    listEl,
    emptyEl,
    sectionEl,
    fetchFeed: async () => {
      // Six rows, not the endpoint's default eight: the strip has to stay a
      // strip, and fewer rows is also fewer rows read per poll.
      const res = await fetch("/api/recent-finishes?limit=6");
      if (!res.ok) throw new Error(`recent-finishes ${res.status}`);
      return res.json();
    },
    isActive: () =>
      doc.visibilityState !== "hidden" && !lobbyEl?.classList.contains("hidden"),
  });

  // Coming back to a hidden tab or returning to the lobby should show current
  // rows immediately, not whatever was true when the strip went away.
  doc.addEventListener("visibilitychange", () => {
    if (doc.visibilityState !== "hidden") feed.refresh();
  });
  doc.addEventListener("lobby-shown", () => feed.refresh());

  feed.init();
  return feed;
}
