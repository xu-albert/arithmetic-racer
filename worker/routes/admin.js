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
      else if (v && typeof v === "object" && v.__html) out += v.__html;
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
      </body>
    </html>
  `;
  return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}
