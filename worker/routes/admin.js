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
    env.DB.prepare(`SELECT COUNT(*) AS n FROM "user" WHERE "createdAt" >= ?1`).bind(since).first("n");

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

export async function handleAdminIndex(request, env) {
  const url = new URL(request.url);
  const gateResponse = checkAdminToken(url, env);
  if (gateResponse) return gateResponse;

  const now = Date.now();
  const summary = await loadSummary(env, now);

  const body = html`
    <!doctype html>
    <html>
      <head>
        <meta charset="utf-8" />
        <title>Arithmetic Racer · admin</title>
        <style>
          body { font: 14px/1.4 system-ui, sans-serif; max-width: 960px; margin: 2rem auto; padding: 0 1rem; color: #222; }
          h1 { font-size: 1.4rem; margin-bottom: 1rem; }
          h2 { font-size: 1.1rem; margin: 1.5rem 0 0.5rem; }
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
      </body>
    </html>
  `;
  return new Response(body, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } });
}
