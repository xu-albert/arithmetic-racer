// Admin dashboard route. Token-gated `/admin/` and `/admin/users/:id`.
// One file by design — split when v2 (live rooms) lands.

/**
 * Constant-time string equality. Returns false on empty or length mismatch.
 * Uses TextEncoder + a manual XOR-reduce so we don't depend on
 * crypto.subtle.timingSafeEqual (which has different availability across
 * workerd versions).
 */
export function timingSafeEqualStrings(a, b) {
  if (!a || !b) return false;
  if (a.length !== b.length) return false;
  const enc = new TextEncoder();
  const av = enc.encode(a);
  const bv = enc.encode(b);
  if (av.length !== bv.length) return false;
  let diff = 0;
  for (let i = 0; i < av.length; i++) diff |= av[i] ^ bv[i];
  return diff === 0;
}

function checkAdminToken(url, env) {
  const got = url.searchParams.get("token") ?? "";
  const want = env.ADMIN_TOKEN ?? "";
  if (!timingSafeEqualStrings(got, want)) {
    return new Response("Not found", { status: 404 });
  }
  return null;
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function html(strings, ...values) {
  let out = "";
  for (let i = 0; i < strings.length; i++) {
    out += strings[i];
    if (i < values.length) {
      const v = values[i];
      if (Array.isArray(v)) out += v.join("");
      // Tested on the property, not its truthiness: raw("") is a legitimate
      // "render nothing", and an emptiness check here would send the wrapper
      // object down the escaping path and print [object Object].
      else if (v && typeof v === "object" && typeof v.__html === "string") out += v.__html;
      else out += escapeHtml(v ?? "");
    }
  }
  return out;
}

function raw(s) {
  return { __html: s };
}

function utcMidnightMs(now) {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

async function loadSummary(env, now) {
  const today = utcMidnightMs(now);
  const sevenDays = now - 7 * 24 * 60 * 60 * 1000;

  const cFinished = (since) =>
    env.DB.prepare(`SELECT COUNT(*) AS n FROM race_results WHERE played_at >= ?1 AND finished = 1`).bind(since).first("n");
  const cUnique = (since) =>
    env.DB.prepare(`SELECT COUNT(DISTINCT COALESCE(user_id, device_id)) AS n FROM race_results WHERE played_at >= ?1`).bind(since).first("n");
  const cSignups = (since) =>
    env.DB.prepare(`SELECT COUNT(*) AS n FROM "user" WHERE "createdAt" >= ?1`).bind(new Date(since).toISOString()).first("n");

  const [
    finishedToday, finished7d, finishedAll,
    uniqueToday, unique7d, uniqueAll,
    signupsToday, signups7d, signupsAll,
    avgRows,
  ] = await Promise.all([
    cFinished(today), cFinished(sevenDays), cFinished(0),
    cUnique(today), cUnique(sevenDays), cUnique(0),
    cSignups(today), cSignups(sevenDays), cSignups(0),
    env.DB.prepare(`SELECT difficulty, AVG(finish_time_ms) AS avg_ms FROM race_results WHERE finished = 1 GROUP BY difficulty`).all(),
  ]);

  const avgs = { easy: null, medium: null, hard: null };
  for (const row of avgRows.results ?? []) avgs[row.difficulty] = row.avg_ms;

  return {
    finished: { today: finishedToday ?? 0, "7d": finished7d ?? 0, all: finishedAll ?? 0 },
    unique:   { today: uniqueToday ?? 0,   "7d": unique7d ?? 0,   all: uniqueAll ?? 0 },
    signups:  { today: signupsToday ?? 0,  "7d": signups7d ?? 0,  all: signupsAll ?? 0 },
    avgs,
  };
}

function renderTilesRow(label, klass, values) {
  return raw(`
    <tr>
      <th>${escapeHtml(label)}</th>
      <td class="${klass}" data-window="today"><span class="n">${values.today}</span></td>
      <td class="${klass}" data-window="7d"><span class="n">${values["7d"]}</span></td>
      <td class="${klass}" data-window="all"><span class="n">${values.all}</span></td>
    </tr>
  `);
}

function formatSec(ms) {
  if (ms == null) return "—";
  return `${(ms / 1000).toFixed(1)}s`;
}

const BASE_CSS = `
  body { font: 14px/1.4 system-ui, sans-serif; max-width: 960px; margin: 2rem auto; padding: 0 1rem; color: #222; }
  h1 { font-size: 1.4rem; margin-bottom: 1rem; }
  h2 { font-size: 1.1rem; margin: 1.5rem 0 0.5rem; }
  table.races { border-collapse: collapse; width: 100%; margin-top: 0.5rem; }
  table.races th, table.races td { text-align: left; padding: 0.35rem 0.5rem; border-bottom: 1px solid #eee; }
  table.races th { color: #888; font-weight: 500; }
  table.races .dnf td { color: #b00; text-decoration: line-through; }
  .pagination { margin-top: 0.5rem; }
  .empty { color: #888; font-style: italic; }
`;

const RECENT_LIMIT = 100;

async function loadRecentRaces(env, { before = Date.now(), beforeId = null, userId = null } = {}) {
  // Compound (played_at, id) cursor. Several race_results rows can share a
  // played_at millisecond (e.g. one multiplayer race persists every player in
  // the same tick); a strict `played_at < cursor` would drop the rows that
  // share the boundary timestamp. The id DESC tiebreak keeps them reachable.
  const where = [];
  const binds = [];
  if (beforeId == null) {
    where.push("rr.played_at < ?");
    binds.push(before);
  } else {
    where.push("(rr.played_at < ? OR (rr.played_at = ? AND rr.id < ?))");
    binds.push(before, before, beforeId);
  }
  if (userId != null) {
    where.push("rr.user_id = ?");
    binds.push(userId);
  }
  const sql = `SELECT rr.id, rr.user_id, rr.device_id, rr.difficulty, rr.finished,
              rr.finish_time_ms, rr.accuracy_pct, rr.played_at, u.username AS username, u.name AS name
       FROM race_results rr LEFT JOIN "user" u ON u.id = rr.user_id
       WHERE ${where.join(" AND ")}
       ORDER BY rr.played_at DESC, rr.id DESC LIMIT ${RECENT_LIMIT}`;
  const { results } = await env.DB.prepare(sql).bind(...binds).all();
  return results ?? [];
}

function relativeTime(now, then) {
  const diff = Math.max(0, now - then);
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}

function whoCell(row, token) {
  if (row.user_id) {
    const handle = row.username ?? row.name ?? row.user_id;
    const href = `/admin/users/${encodeURIComponent(row.user_id)}?token=${encodeURIComponent(token)}`;
    return raw(`<a href="${escapeHtml(href)}">${escapeHtml(handle)}</a>`);
  }
  return raw(escapeHtml(`(dev:${(row.device_id ?? "").slice(0, 9)}…)`));
}

function renderRacesTable(rows, now, token, cursorBase) {
  if (rows.length === 0) {
    return raw(`<p class="empty">No races yet.</p>`);
  }
  const body = rows.map((r) => {
    const cls = r.finished ? "race-row" : "race-row dnf";
    const whenIso = new Date(r.played_at).toISOString();
    return `<tr class="${cls}">
      <td><span title="${escapeHtml(whenIso)}">${escapeHtml(relativeTime(now, r.played_at))}</span></td>
      <td>${whoCell(r, token).__html}</td>
      <td>${escapeHtml(r.difficulty)}</td>
      <td>${r.finished ? escapeHtml(formatSec(r.finish_time_ms)) : "—"}</td>
      <td>${r.finished ? escapeHtml(Math.round(r.accuracy_pct) + "%") : "—"}</td>
    </tr>`;
  }).join("");

  const last = rows[rows.length - 1];
  const olderLink = rows.length === RECENT_LIMIT
    ? `<a href="${escapeHtml(cursorBase + "&before=" + last.played_at + "&beforeId=" + encodeURIComponent(last.id))}">Older →</a>`
    : "";

  return raw(`
    <table class="races">
      <thead>
        <tr><th>when</th><th>who</th><th>diff</th><th>time</th><th>acc</th></tr>
      </thead>
      <tbody>${body}</tbody>
    </table>
    <p class="pagination">${olderLink}</p>
  `);
}

async function load30DayBuckets(env, now) {
  const since = now - 30 * 24 * 60 * 60 * 1000;
  const { results } = await env.DB
    .prepare(`SELECT (played_at / 86400000) AS day_bucket, COUNT(*) AS n
              FROM race_results WHERE played_at >= ?1
              GROUP BY day_bucket ORDER BY day_bucket`)
    .bind(since).all();
  const seen = new Map();
  for (const r of results ?? []) seen.set(Number(r.day_bucket), Number(r.n));

  const todayBucket = Math.floor(now / 86400000);
  const buckets = [];
  for (let i = 29; i >= 0; i--) {
    const b = todayBucket - i;
    buckets.push(seen.get(b) ?? 0);
  }
  return buckets;
}

function renderSparkline(buckets) {
  const W = 200, H = 40;
  const max = Math.max(1, ...buckets);
  const step = W / (buckets.length - 1 || 1);
  const points = buckets
    .map((n, i) => `${(i * step).toFixed(1)},${(H - (n / max) * H).toFixed(1)}`)
    .join(" ");
  return raw(`<svg class="sparkline" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"
    aria-label="races per day, last 30 days">
      <polyline fill="none" stroke="#444" stroke-width="1.5" points="${points}" />
    </svg>`);
}

export async function handleAdminUser(request, env) {
  const url = new URL(request.url);
  const gateResponse = checkAdminToken(url, env);
  if (gateResponse) return gateResponse;

  const segments = url.pathname.split("/").filter(Boolean);
  const userId = segments[2];
  if (!userId) return new Response("Not found", { status: 404 });

  const user = await env.DB
    .prepare(`SELECT id, name, email, username, "createdAt" AS createdAt FROM "user" WHERE id = ?1`)
    .bind(userId).first();
  if (!user) return new Response("Not found", { status: 404 });

  const now = Date.now();
  const before = Number(url.searchParams.get("before")) || now;
  const beforeId = url.searchParams.get("beforeId");
  const token = url.searchParams.get("token") ?? "";
  const cursorBase = `/admin/users/${encodeURIComponent(userId)}?token=${encodeURIComponent(token)}`;
  const rows = await loadRecentRaces(env, { before, beforeId, userId });

  const handle = user.username ?? user.name ?? user.id;
  const signupIso = user.createdAt ? new Date(user.createdAt).toISOString() : "—";

  const body = html`
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <title>${handle} · Arithmetic Racer admin</title>
        <style>
          ${raw(BASE_CSS)}
          .user-card { background: #f5f5f7; padding: 0.75rem 1rem; border-radius: 6px; margin-bottom: 1rem; }
          .user-card p { margin: 0.2rem 0; }
          .back { color: #666; font-size: 0.9rem; }
        </style>
      </head>
      <body>
        <p class="back"><a href="/admin/?token=${encodeURIComponent(token)}">← back to admin</a></p>
        <h1>${handle}</h1>
        <div class="user-card">
          <p><strong>email</strong> ${user.email ?? "—"}</p>
          <p><strong>signed up</strong> <span title="${signupIso}">${signupIso}</span></p>
          <p><strong>id</strong> <code>${user.id}</code></p>
        </div>
        <h2>Recent races</h2>
        ${renderRacesTable(rows, now, token, cursorBase)}
      </body>
    </html>
  `;
  return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}

// Kinds the contact table can be filtered to, and their dashboard labels.
// Matches the CHECK constraint in migrations/0007_contact_bug_reports.sql; an
// unknown ?kind= falls back to showing everything rather than an empty table.
const CONTACT_KINDS = [
  ["bug", "Bug reports"],
  ["general", "General"],
  ["deletion", "Deletion"],
];

/**
 * Newest contact submissions. Capped rather than paginated — if the backlog
 * ever exceeds this, the answer is to deal with it, not to scroll.
 *
 * @param {string|null} kind Restrict to one kind, or null for all.
 */
async function loadContactMessages(env, kind = null, limit = 50) {
  const where = kind ? "WHERE kind = ?" : "";
  const binds = kind ? [kind, limit] : [limit];
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, email, message, kind, user_id, handled, created_at, context
         FROM contact_messages
         ${where}
        ORDER BY created_at DESC, id DESC
        LIMIT ?`
    ).bind(...binds).all();
    return results ?? [];
  } catch {
    // The table arrives in migration 0005 and gains `context` in 0007. An
    // un-migrated database should degrade to an empty section rather than take
    // down the whole dashboard.
    return [];
  }
}

// Order the captured fields are shown in — most identifying of the bug first,
// rather than the arbitrary order JSON.stringify happened to produce.
const CONTEXT_FIELD_ORDER = [
  ["browser", "browser"],
  ["os", "OS"],
  // Derived from the referrer, so it is the page they navigated to the form
  // from — not necessarily where the bug happened. The form asks that
  // separately and it is composed into the message.
  ["page", "came from"],
  ["app_version", "version"],
  ["signed_in", "signed in"],
  ["viewport", "viewport"],
  ["screen", "screen"],
  ["dpr", "pixel ratio"],
  ["ua", "user agent"],
];

/**
 * Render a bug report's captured context, collapsed. It is reference material
 * for a report already being read, so it should not push the message text of
 * every other row off the screen.
 */
function renderContext(contextJson) {
  if (!contextJson) return "";

  let context;
  try {
    context = JSON.parse(contextJson);
  } catch {
    // Stored by an older or broken writer. Showing the raw text beats hiding
    // that something is there.
    return `<details class="ctx"><summary>context (unparseable)</summary><pre>${escapeHtml(contextJson)}</pre></details>`;
  }
  if (!context || typeof context !== "object") return "";

  const known = new Set(CONTEXT_FIELD_ORDER.map(([key]) => key));
  const entries = [
    ...CONTEXT_FIELD_ORDER.filter(([key]) => context[key] !== undefined && context[key] !== null),
    // Anything a newer writer added that this dashboard doesn't know a label
    // for still gets shown, under its raw key.
    ...Object.keys(context).filter((key) => !known.has(key)).map((key) => [key, key]),
  ];
  if (!entries.length) return "";

  const rows = entries
    .map(([key, label]) => {
      const value = typeof context[key] === "boolean" ? (context[key] ? "yes" : "no") : context[key];
      return `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`;
    })
    .join("");
  return `<details class="ctx"><summary>context</summary><dl>${rows}</dl></details>`;
}

function contactHref(token, kind) {
  return `/admin/?token=${encodeURIComponent(token)}${kind ? `&kind=${kind}` : ""}`;
}

function renderContactFilters(activeKind, token, counts) {
  const link = (kind, label) => {
    const total = counts[kind ?? "all"]?.total ?? 0;
    const text = `${label}${total ? ` (${total})` : ""}`;
    return kind === activeKind
      ? `<strong>${escapeHtml(text)}</strong>`
      : `<a href="${escapeHtml(contactHref(token, kind))}">${escapeHtml(text)}</a>`;
  };
  const links = [link(null, "All"), ...CONTACT_KINDS.map(([kind, label]) => link(kind, label))];
  return raw(`<p class="contact-filters">${links.join(" · ")}</p>`);
}

function renderContactTable(messages, now) {
  if (!messages.length) return raw(`<p class="empty">No contact messages.</p>`);
  const body = messages
    .map((m) => {
      const whenIso = new Date(m.created_at).toISOString();
      // escapeHtml on the message body is load-bearing, not cosmetic: this is
      // arbitrary text a stranger typed into a public form, rendered into the
      // operator's own authenticated page. The same goes for every context
      // value below — those are attacker-controlled too.
      return `<tr class="${m.handled ? "contact-row handled" : "contact-row"}">
      <td><span title="${escapeHtml(whenIso)}">${escapeHtml(relativeTime(now, m.created_at))}</span></td>
      <td class="kind kind-${escapeHtml(m.kind)}">${escapeHtml(m.kind)}</td>
      <td>${escapeHtml(m.email ?? "—")}</td>
      <td>${m.user_id ? "signed in" : "anonymous"}</td>
      <td class="msg">${escapeHtml(m.message)}${renderContext(m.context)}</td>
      <td>${m.handled ? "handled" : "open"}</td>
    </tr>`;
    })
    .join("");
  return raw(`<table class="contact">
    <thead>
      <tr><th>When</th><th>Kind</th><th>Email</th><th>Who</th><th>Message</th><th>Status</th></tr>
    </thead>
    <tbody>${body}</tbody>
  </table>`);
}

/**
 * Per-kind totals for the filter links, so a filter shows what it will find.
 *
 * @returns {Record<string, {total: number}>} Keyed by kind, plus an `all`
 *   bucket. Kinds with no rows are simply absent.
 */
async function loadContactCounts(env) {
  const counts = { all: { total: 0 } };
  try {
    const { results } = await env.DB
      .prepare(`SELECT kind, COUNT(*) AS total FROM contact_messages GROUP BY kind`)
      .all();
    for (const row of results ?? []) {
      counts[row.kind] = { total: Number(row.total) };
      counts.all.total += Number(row.total);
    }
  } catch {
    // Same degradation as loadContactMessages: no table, no counts, no crash.
  }
  return counts;
}

export async function handleAdminIndex(request, env) {
  const url = new URL(request.url);
  const gateResponse = checkAdminToken(url, env);
  if (gateResponse) return gateResponse;

  const now = Date.now();
  const summary = await loadSummary(env, now);
  const buckets = await load30DayBuckets(env, now);
  const before = Number(url.searchParams.get("before")) || Date.now();
  const beforeId = url.searchParams.get("beforeId");
  const token = url.searchParams.get("token") ?? "";
  const cursorBase = `/admin/?token=${encodeURIComponent(token)}`;
  const rows = await loadRecentRaces(env, { before, beforeId });

  const requestedKind = url.searchParams.get("kind");
  const contactKind = CONTACT_KINDS.some(([k]) => k === requestedKind) ? requestedKind : null;
  const [messages, contactCounts] = await Promise.all([
    loadContactMessages(env, contactKind),
    loadContactCounts(env),
  ]);

  const body = html`
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <title>Arithmetic Racer · admin</title>
        <style>
          ${raw(BASE_CSS)}
          table.tiles { border-collapse: collapse; margin-bottom: 1rem; }
          table.tiles th { text-align: left; padding: 0.4rem 1rem 0.4rem 0; font-weight: 500; color: #666; }
          table.tiles td { padding: 0.4rem 1rem; background: #f5f5f7; border-radius: 6px; min-width: 4rem; text-align: right; }
          table.tiles .n { font-variant-numeric: tabular-nums; font-weight: 600; }
          table.tiles thead th { color: #888; font-weight: 500; }
          .avgs { color: #555; }
          table.contact { border-collapse: collapse; width: 100%; }
          table.contact th, table.contact td { text-align: left; padding: 0.4rem 0.6rem; border-bottom: 1px solid #eee; vertical-align: top; }
          table.contact .msg { white-space: pre-wrap; word-break: break-word; max-width: 32rem; }
          table.contact tr.handled { color: #999; }
          table.contact .kind-bug { font-weight: 600; color: #a3231a; }
          .contact-filters { margin: 0.5rem 0; color: #888; }
          .contact-filters a { color: #444; }
          details.ctx { margin-top: 0.5rem; font-size: 0.9em; }
          details.ctx summary { cursor: pointer; color: #888; }
          details.ctx dl { display: grid; grid-template-columns: max-content minmax(0, 1fr); gap: 0.1rem 0.6rem; margin: 0.4rem 0 0; }
          details.ctx dt { color: #888; }
          details.ctx dd { margin: 0; word-break: break-word; }
        </style>
      </head>
      <body>
        <h1>Arithmetic Racer · admin</h1>
        <table class="tiles">
          <thead>
            <tr><th></th><th>Today</th><th>7 days</th><th>All-time</th></tr>
          </thead>
          <tbody>
            ${renderTilesRow("races finished", "races-finished", summary.finished)}
            ${renderTilesRow("unique players", "unique-players", summary.unique)}
            ${renderTilesRow("signups",        "signups",        summary.signups)}
          </tbody>
        </table>
        <p class="avgs">
          Avg finish (all-time):
          easy ${formatSec(summary.avgs.easy)} ·
          med ${formatSec(summary.avgs.medium)} ·
          hard ${formatSec(summary.avgs.hard)}
        </p>
        <p>Races per day (last 30) ${renderSparkline(buckets)}</p>
        <h2>Recent races</h2>
        ${renderRacesTable(rows, now, token, cursorBase)}
        <h2>Contact messages${messages.length ? ` (${messages.filter((m) => !m.handled).length} unhandled)` : ""}</h2>
        ${renderContactFilters(contactKind, token, contactCounts)}
        ${renderContactTable(messages, now)}
      </body>
    </html>
  `;
  return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}
