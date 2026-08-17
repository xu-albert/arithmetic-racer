// Tests for the admin dashboard route. Runs under @cloudflare/vitest-pool-workers.
// Each test file gets its own ephemeral D1; the schema is applied from
// migrations/ by worker/test-setup.js.

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from "vitest";
import { env } from "cloudflare:test";
import { timingSafeEqualStrings, handleAdminIndex, html, raw } from "./admin.js";
import { KINDS } from "../logger.js";

const CONTACT_MESSAGES_DDL =
  "CREATE TABLE IF NOT EXISTS contact_messages (" +
  "id TEXT PRIMARY KEY, " +
  "email TEXT, " +
  "message TEXT NOT NULL, " +
  "kind TEXT NOT NULL DEFAULT 'general' CHECK (kind IN ('general','deletion','bug')), " +
  "user_id TEXT, " +
  "device_id TEXT, " +
  "handled INTEGER NOT NULL DEFAULT 0 CHECK (handled IN (0,1)), " +
  "created_at INTEGER NOT NULL, " +
  "context TEXT" +
  ")";

// The same table as 0006 left it: no `context`, and a `kind` CHECK that
// predates 'bug'. This is the shape a database is in until 0008 is applied.
const CONTACT_MESSAGES_DDL_0006 =
  "CREATE TABLE IF NOT EXISTS contact_messages (" +
  "id TEXT PRIMARY KEY, " +
  "email TEXT, " +
  "message TEXT NOT NULL, " +
  "kind TEXT NOT NULL DEFAULT 'general' CHECK (kind IN ('general','deletion')), " +
  "user_id TEXT, " +
  "device_id TEXT, " +
  "handled INTEGER NOT NULL DEFAULT 0 CHECK (handled IN (0,1)), " +
  "created_at INTEGER NOT NULL" +
  ")";

beforeEach(async () => {
  await env.DB.exec("DELETE FROM race_results");
  await env.DB.exec(`DELETE FROM "user"`);
  await env.DB.exec("DELETE FROM contact_messages");
});

describe("timingSafeEqualStrings", () => {
  it("returns true for identical strings", () => {
    expect(timingSafeEqualStrings("abc123", "abc123")).toBe(true);
  });
  it("returns false for different equal-length strings", () => {
    expect(timingSafeEqualStrings("abc123", "abc124")).toBe(false);
  });
  it("returns false for different-length strings", () => {
    expect(timingSafeEqualStrings("abc", "abc123")).toBe(false);
  });
  it("returns false when either side is empty", () => {
    expect(timingSafeEqualStrings("", "abc")).toBe(false);
    expect(timingSafeEqualStrings("abc", "")).toBe(false);
  });
  it("returns false when both sides are empty (no valid empty token)", () => {
    expect(timingSafeEqualStrings("", "")).toBe(false);
  });
});

describe("GET /admin/ token gate", () => {
  it("returns 404 when no token is provided", async () => {
    const { handleAdminIndex } = await import("./admin.js");
    const req = new Request("http://x/admin/");
    const res = await handleAdminIndex(req, { ...env, ADMIN_TOKEN: "expected-secret" });
    expect(res.status).toBe(404);
  });

  it("returns 404 when token is wrong", async () => {
    const { handleAdminIndex } = await import("./admin.js");
    const req = new Request("http://x/admin/?token=wrong");
    const res = await handleAdminIndex(req, { ...env, ADMIN_TOKEN: "expected-secret" });
    expect(res.status).toBe(404);
  });

  it("returns 404 when ADMIN_TOKEN is unset (no admin URL works)", async () => {
    const { handleAdminIndex } = await import("./admin.js");
    const req = new Request("http://x/admin/?token=anything");
    const res = await handleAdminIndex(req, { ...env, ADMIN_TOKEN: undefined });
    expect(res.status).toBe(404);
  });
});

describe("GET /admin/ happy path", () => {
  it("returns 200 HTML when token matches and DB is empty", async () => {
    const { handleAdminIndex } = await import("./admin.js");
    const req = new Request("http://x/admin/?token=expected-secret");
    const res = await handleAdminIndex(req, { ...env, ADMIN_TOKEN: "expected-secret" });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    const body = await res.text();
    expect(body).toContain("Arithmetic Racer");
    expect(body).toContain("admin");
  });
});

async function insertContact({
  id = crypto.randomUUID(),
  message,
  kind = "general",
  email = null,
  handled = 0,
  context = null,
  created_at = Date.now(),
} = {}) {
  await env.DB.prepare(
    "INSERT INTO contact_messages (id, email, message, kind, user_id, device_id, handled, created_at, context) " +
      "VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, ?)"
  ).bind(id, email, message, kind, handled, created_at, context).run();
}

async function dashboard(query = "") {
  return dashboardAt(`/admin/?token=t${query}`);
}

// Load a dashboard URL the page itself rendered, so a test can follow a link
// the operator would click rather than hand-assembling the next request.
async function dashboardAt(href) {
  const res = await handleAdminIndex(
    new Request(`https://x${href}`),
    { ...env, ADMIN_TOKEN: "t" }
  );
  return res.text();
}

async function seedUser(id, username, createdAtMs) {
  await env.DB.prepare(
    `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", username)
     VALUES (?,?,?,?,?,?,?)`
  ).bind(id, username, `${username}@example.com`, 0, new Date(createdAtMs).toISOString(), new Date(createdAtMs).toISOString(), username).run();
}

async function seedRace(overrides = {}) {
  const r = {
    id: crypto.randomUUID(),
    user_id: null,
    device_id: "dev-1",
    difficulty: "medium",
    finished: 1,
    finish_time_ms: 48000,
    problems_total: 20,
    problems_correct: 18,
    problems_attempted: 20,
    avg_time_per_problem_ms: 2400,
    accuracy_pct: 90,
    longest_streak: 7,
    played_at: Date.now(),
    ...overrides,
  };
  await env.DB.prepare(
    `INSERT INTO race_results (id, user_id, device_id, difficulty, finished, finish_time_ms,
       problems_total, problems_correct, problems_attempted, avg_time_per_problem_ms,
       accuracy_pct, longest_streak, played_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`
  )
    .bind(r.id, r.user_id, r.device_id, r.difficulty, r.finished, r.finish_time_ms,
          r.problems_total, r.problems_correct, r.problems_attempted, r.avg_time_per_problem_ms,
          r.accuracy_pct, r.longest_streak, r.played_at)
    .run();
  return r;
}

describe("recent races table", () => {
  it("renders rows newest-first with username when user_id set", async () => {
    const now = Date.now();
    await seedUser("u-alice", "alice", now);
    await seedRace({ user_id: "u-alice", played_at: now - 1000, finish_time_ms: 48200, accuracy_pct: 96 });
    await seedRace({ user_id: null, device_id: "dev-xyz1234567", played_at: now - 2000 });

    const { handleAdminIndex } = await import("./admin.js");
    const req = new Request("http://x/admin/?token=expected-secret");
    const res = await handleAdminIndex(req, { ...env, ADMIN_TOKEN: "expected-secret" });
    const body = await res.text();

    expect(body).toContain("alice");
    expect(body).toContain("dev:dev-xy");
    expect(body.indexOf("alice")).toBeLessThan(body.indexOf("dev-xy"));
  });

  it("marks DNF rows with a 'dnf' class", async () => {
    await seedRace({ finished: 0, finish_time_ms: null });
    const { handleAdminIndex } = await import("./admin.js");
    const res = await handleAdminIndex(
      new Request("http://x/admin/?token=expected-secret"),
      { ...env, ADMIN_TOKEN: "expected-secret" }
    );
    const body = await res.text();
    expect(body).toMatch(/class="[^"]*dnf[^"]*"/);
  });

  it("respects ?before=<played_at> cursor", async () => {
    const now = Date.now();
    await seedRace({ device_id: "dev-newer", played_at: now - 1000 });
    await seedRace({ device_id: "dev-older", played_at: now - 9000 });
    const { handleAdminIndex } = await import("./admin.js");
    const cursor = now - 5000;
    const res = await handleAdminIndex(
      new Request(`http://x/admin/?token=expected-secret&before=${cursor}`),
      { ...env, ADMIN_TOKEN: "expected-secret" }
    );
    const body = await res.text();
    expect(body).toContain("dev-older");
    expect(body).not.toContain("dev-newer");
  });

  it("renders 'Older' link only when result count hits LIMIT", async () => {
    await seedRace();
    const { handleAdminIndex } = await import("./admin.js");
    const res = await handleAdminIndex(
      new Request("http://x/admin/?token=expected-secret"),
      { ...env, ADMIN_TOKEN: "expected-secret" }
    );
    const body = await res.text();
    expect(body).not.toMatch(/Older →/);
  });
});

describe("recent races pagination with tied played_at", () => {
  // Regression: the "Older" cursor must not drop rows that share the boundary
  // played_at millisecond. A single multiplayer race writes several
  // race_results rows in the same tick (identical played_at); if such a group
  // straddles the RECENT_LIMIT boundary, a strict `played_at < cursor` query
  // makes the overflow rows unreachable. The cursor must tiebreak on id.
  it("reaches every tied row across the Older link (no rows lost)", async () => {
    const now = Date.now();
    const P = now - 99000; // shared boundary timestamp for the 3 tie rows
    const stmts = [];
    const mk = (id, device_id, played_at) =>
      env.DB.prepare(
        `INSERT INTO race_results (id, user_id, device_id, difficulty, finished, finish_time_ms,
           problems_total, problems_correct, problems_attempted, avg_time_per_problem_ms,
           accuracy_pct, longest_streak, played_at) VALUES (?,null,?,?,1,48000,20,18,20,2400,90,7,?)`
      ).bind(id, device_id, "medium", played_at);
    // 99 rows with distinct, strictly-newer timestamps...
    for (let i = 0; i < 99; i++) stmts.push(mk(`d-${String(i).padStart(2, "0")}`, `dev-${i}`, now - i * 1000));
    // ...then 3 rows all sharing the oldest timestamp P (the tie at the boundary).
    stmts.push(mk("t-1", "tie-1", P));
    stmts.push(mk("t-2", "tie-2", P));
    stmts.push(mk("t-3", "tie-3", P));
    await env.DB.batch(stmts);

    const { handleAdminIndex } = await import("./admin.js");
    const auth = { ...env, ADMIN_TOKEN: "expected-secret" };

    const page1 = await (await handleAdminIndex(
      new Request("http://x/admin/?token=expected-secret"), auth)).text();
    // Page 1 is full (100 rows) so an Older link must be present.
    const older = page1.match(/href="([^"]*&(?:amp;)?before=[^"]+)"/);
    expect(older).not.toBeNull();
    const olderHref = older[1].replace(/&amp;/g, "&");
    const page2 = await (await handleAdminIndex(
      new Request(`http://x${olderHref}`), auth)).text();

    // Every tied row must appear across the two pages — none silently dropped.
    for (const dev of ["tie-1", "tie-2", "tie-3"]) {
      const seen = (page1.includes(`dev:${dev}`) ? 1 : 0) + (page2.includes(`dev:${dev}`) ? 1 : 0);
      expect(seen).toBe(1); // present exactly once: no loss, no duplicate
    }
  });
});

describe("summary tiles", () => {
  it("shows zeros on empty DB", async () => {
    const { handleAdminIndex } = await import("./admin.js");
    const req = new Request("http://x/admin/?token=expected-secret");
    const res = await handleAdminIndex(req, { ...env, ADMIN_TOKEN: "expected-secret" });
    const body = await res.text();
    expect(body).toContain("races finished");
    expect(body).toContain("unique players");
    expect(body).toContain("signups");
  });

  it("counts finished races in today/7d/all-time windows", async () => {
    const now = Date.now();
    const oneHourAgo = now - 60 * 60 * 1000;
    const threeDaysAgo = now - 3 * 24 * 60 * 60 * 1000;
    const twentyDaysAgo = now - 20 * 24 * 60 * 60 * 1000;

    await seedRace({ played_at: oneHourAgo,    finished: 1 });
    await seedRace({ played_at: threeDaysAgo,  finished: 1 });
    await seedRace({ played_at: twentyDaysAgo, finished: 1 });
    await seedRace({ played_at: oneHourAgo,    finished: 0 });

    const { handleAdminIndex } = await import("./admin.js");
    const req = new Request("http://x/admin/?token=expected-secret");
    const res = await handleAdminIndex(req, { ...env, ADMIN_TOKEN: "expected-secret" });
    const body = await res.text();

    expect(body).toMatch(/data-window="today"[^>]*>\s*<[^>]*>1</);
    expect(body).toMatch(/data-window="7d"[^>]*>\s*<[^>]*>2</);
    expect(body).toMatch(/data-window="all"[^>]*>\s*<[^>]*>3</);
  });

  it("counts unique players by user_id or device_id", async () => {
    await seedUser("user-a", "alice", Date.now());
    await seedRace({ user_id: "user-a", device_id: "dev-1" });
    await seedRace({ user_id: "user-a", device_id: "dev-9" });
    await seedRace({ user_id: null,     device_id: "dev-2" });
    await seedRace({ user_id: null,     device_id: "dev-2" });

    const { handleAdminIndex } = await import("./admin.js");
    const req = new Request("http://x/admin/?token=expected-secret");
    const res = await handleAdminIndex(req, { ...env, ADMIN_TOKEN: "expected-secret" });
    const body = await res.text();
    expect(body).toMatch(/unique-players[^>]*data-window="all"[^>]*>\s*<[^>]*>2</);
  });

  it("counts signups in time windows", async () => {
    const now = Date.now();
    await seedUser("u1", "alice", now - 60 * 60 * 1000);
    await seedUser("u2", "bob",   now - 3 * 24 * 60 * 60 * 1000);
    await seedUser("u3", "carol", now - 20 * 24 * 60 * 60 * 1000);

    const { handleAdminIndex } = await import("./admin.js");
    const req = new Request("http://x/admin/?token=expected-secret");
    const res = await handleAdminIndex(req, { ...env, ADMIN_TOKEN: "expected-secret" });
    const body = await res.text();
    expect(body).toMatch(/signups[^>]*data-window="today"[^>]*>\s*<[^>]*>1</);
    expect(body).toMatch(/signups[^>]*data-window="7d"[^>]*>\s*<[^>]*>2</);
    expect(body).toMatch(/signups[^>]*data-window="all"[^>]*>\s*<[^>]*>3</);
  });
});

describe("30-day sparkline", () => {
  it("renders a polyline element even with empty data", async () => {
    const { handleAdminIndex } = await import("./admin.js");
    const res = await handleAdminIndex(
      new Request("http://x/admin/?token=expected-secret"),
      { ...env, ADMIN_TOKEN: "expected-secret" }
    );
    const body = await res.text();
    expect(body).toMatch(/<svg[^>]*class="sparkline"/);
    expect(body).toMatch(/<polyline/);
  });

  it("includes a non-zero point when a recent race exists", async () => {
    await seedRace({ played_at: Date.now() - 60 * 1000 });
    const { handleAdminIndex } = await import("./admin.js");
    const res = await handleAdminIndex(
      new Request("http://x/admin/?token=expected-secret"),
      { ...env, ADMIN_TOKEN: "expected-secret" }
    );
    const body = await res.text();
    const match = body.match(/<polyline[^>]*points="([^"]+)"/);
    expect(match).not.toBeNull();
    const points = match[1].split(/\s+/).filter(Boolean);
    expect(points.length).toBe(30);
  });
});

describe("per-user drill-down", () => {
  it("404s with no token", async () => {
    const { handleAdminUser } = await import("./admin.js");
    const res = await handleAdminUser(
      new Request("http://x/admin/users/u-alice"),
      { ...env, ADMIN_TOKEN: "expected-secret" }
    );
    expect(res.status).toBe(404);
  });

  it("404s when user does not exist (token valid)", async () => {
    const { handleAdminUser } = await import("./admin.js");
    const res = await handleAdminUser(
      new Request("http://x/admin/users/missing?token=expected-secret"),
      { ...env, ADMIN_TOKEN: "expected-secret" }
    );
    expect(res.status).toBe(404);
  });

  it("returns user header + only that user's races", async () => {
    const now = Date.now();
    await seedUser("u-alice", "alice", now - 86400000);
    await seedUser("u-bob",   "bob",   now);
    await seedRace({ user_id: "u-alice", played_at: now - 500 });
    await seedRace({ user_id: "u-bob",   played_at: now - 100 });

    const { handleAdminUser } = await import("./admin.js");
    const res = await handleAdminUser(
      new Request("http://x/admin/users/u-alice?token=expected-secret"),
      { ...env, ADMIN_TOKEN: "expected-secret" }
    );
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("alice");
    expect(body).not.toContain("bob");
  });
});

describe("admin dashboard — contact messages", () => {
  const insert = insertContact;

  it("lists a submitted message", async () => {
    await insert({ message: "my printer is on fire", email: "a@b.com" });
    const body = await dashboard();
    expect(body).toContain("my printer is on fire");
    expect(body).toContain("a@b.com");
  });

  it("shows how many are unhandled", async () => {
    await insert({ message: "one" });
    await insert({ message: "two" });
    await insert({ message: "three", handled: 1 });
    expect(await dashboard()).toContain("2 unhandled");
  });

  it("escapes HTML in a submitted message", async () => {
    // Arbitrary text a stranger typed into a public form, rendered into the
    // operator's authenticated page. Unescaped, this is stored XSS.
    await insert({ message: "<img src=x onerror=alert(1)>" });
    const body = await dashboard();
    expect(body).not.toContain("<img src=x onerror=alert(1)>");
    expect(body).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("renders an empty state rather than failing", async () => {
    expect(await dashboard()).toContain("No contact messages");
  });
});

describe("html() template tag", () => {
  it("renders an empty raw value as nothing", () => {
    // raw("") is a legitimate "render nothing". Gating the raw branch on the
    // truthiness of __html instead of its type sends the wrapper object down
    // the escaping path, which stringifies it into the page as
    // "[object Object]" — and zero-of-something is the ordinary case, so that
    // lands on a normal load rather than an exotic one.
    expect(html`<h1>x</h1>${raw("")}<table>`).toBe("<h1>x</h1><table>");
  });

  it("emits a non-empty raw value unescaped", () => {
    expect(html`<p>${raw("<b>hi</b>")}</p>`).toBe("<p><b>hi</b></p>");
  });

  it("escapes an ordinary interpolated value", () => {
    expect(html`${"<img src=x onerror=alert(1)>"}`).toBe(
      "&lt;img src=x onerror=alert(1)&gt;"
    );
  });

  it("renders null and undefined as nothing", () => {
    expect(html`a${null}b${undefined}c`).toBe("abc");
  });

  it("joins an interpolated array without separators", () => {
    expect(html`<ul>${["<li>a</li>", "<li>b</li>"]}</ul>`).toBe("<ul><li>a</li><li>b</li></ul>");
  });
});

describe("admin dashboard — finding bug reports", () => {
  // The contact notification email has never been configured in production,
  // so this dashboard is the only place a bug report is ever read. "Findable
  // here" is the delivery guarantee, not a convenience.
  const insert = insertContact;

  it("filters the table to bug reports with ?kind=bug", async () => {
    await insert({ message: "a general question", kind: "general" });
    await insert({ message: "the race froze", kind: "bug" });
    await insert({ message: "delete me please", kind: "deletion" });

    const body = await dashboard("&kind=bug");
    expect(body).toContain("the race froze");
    expect(body).not.toContain("a general question");
    expect(body).not.toContain("delete me please");
  });

  it("filters to the other kinds too", async () => {
    await insert({ message: "a general question", kind: "general" });
    await insert({ message: "the race froze", kind: "bug" });

    const body = await dashboard("&kind=general");
    expect(body).toContain("a general question");
    expect(body).not.toContain("the race froze");
  });

  it("shows everything when unfiltered", async () => {
    await insert({ message: "a general question", kind: "general" });
    await insert({ message: "the race froze", kind: "bug" });
    const body = await dashboard();
    expect(body).toContain("a general question");
    expect(body).toContain("the race froze");
  });

  it("ignores an unknown kind rather than showing an empty table", async () => {
    await insert({ message: "the race froze", kind: "bug" });
    const body = await dashboard("&kind=nonsense");
    expect(body).toContain("the race froze");
  });

  it("offers filter links that carry the admin token", async () => {
    await insert({ message: "the race froze", kind: "bug" });
    const body = await dashboard();
    expect(body).toContain("Bug reports");
    expect(body).toMatch(/href="\/admin\/\?token=t(&amp;|&)kind=bug"/);
  });

  it("counts each kind on its filter link", async () => {
    await insert({ message: "one", kind: "bug" });
    await insert({ message: "two", kind: "bug" });
    await insert({ message: "three", kind: "general" });
    const body = await dashboard();
    expect(body).toContain("Bug reports (2)");
    expect(body).toContain("General (1)");
  });

  it("still counts unhandled messages in the contact heading", async () => {
    // The count stays; the top-of-page banner it used to also drive is gone,
    // because nothing in this dashboard can mark a report handled and a signal
    // that can never be cleared stops being read.
    await insert({ message: "the race froze", kind: "bug" });
    await insert({ message: "fixed already", kind: "bug", handled: 1 });
    expect(await dashboard()).toContain("1 unhandled");
  });
});

describe("admin dashboard — contact filter and race paging on one page", () => {
  // Both lists live on the same page and keep their state in the same query
  // string, so a link belonging to one of them must not reset the other.
  const insert = insertContact;

  const mkRace = (id, deviceId, playedAt) =>
    env.DB.prepare(
      `INSERT INTO race_results (id, user_id, device_id, difficulty, finished, finish_time_ms,
         problems_total, problems_correct, problems_attempted, avg_time_per_problem_ms,
         accuracy_pct, longest_streak, played_at) VALUES (?,null,?,'medium',1,48000,20,18,20,2400,90,7,?)`
    ).bind(id, deviceId, playedAt);

  // A full first page (RECENT_LIMIT rows) plus one straggler, which is what
  // makes the "Older →" link appear and gives page 2 something to show.
  async function seedTwoRacePages(now) {
    const stmts = [];
    for (let i = 0; i < 100; i++) {
      stmts.push(mkRace(`p-${String(i).padStart(3, "0")}`, `r${String(i).padStart(3, "0")}`, now - i * 1000));
    }
    stmts.push(mkRace("p-oldest", "rzzz", now - 500000));
    await env.DB.batch(stmts);
  }

  function hrefFor(body, label) {
    const match = body.match(new RegExp(`<a href="([^"]+)">${label}`));
    expect(match).not.toBeNull();
    return match[1].replace(/&amp;/g, "&");
  }

  it("keeps the contact filter when advancing to the next page of races", async () => {
    const now = Date.now();
    await seedTwoRacePages(now);
    await insert({ message: "the race froze", kind: "bug" });
    await insert({ message: "a general question", kind: "general" });

    const page1 = await dashboard("&kind=bug");
    expect(page1).toContain("the race froze");
    expect(page1).not.toContain("a general question");

    const page2 = await dashboardAt(hrefFor(page1, "Older"));
    // Paging really advanced...
    expect(page2).toContain("dev:rzzz");
    expect(page2).not.toContain("dev:r000");
    // ...and the contact table is still filtered to bug reports.
    expect(page2).toContain("the race froze");
    expect(page2).not.toContain("a general question");
  });

  it("keeps the race cursor when a contact filter is clicked", async () => {
    const now = Date.now();
    await seedTwoRacePages(now);
    await insert({ message: "the race froze", kind: "bug" });
    await insert({ message: "a general question", kind: "general" });

    const paged = await dashboardAt(hrefFor(await dashboard(), "Older"));
    expect(paged).toContain("dev:rzzz");
    expect(paged).not.toContain("dev:r000");

    const filtered = await dashboardAt(hrefFor(paged, "Bug reports"));
    // The filter applied...
    expect(filtered).toContain("the race froze");
    expect(filtered).not.toContain("a general question");
    // ...without throwing away the page of races we were reading.
    expect(filtered).toContain("dev:rzzz");
    expect(filtered).not.toContain("dev:r000");
  });

  it("leaves no empty kind parameter on the 'All' link", async () => {
    await insert({ message: "the race froze", kind: "bug" });
    const all = hrefFor(await dashboard("&kind=bug"), "All");
    expect(all).not.toMatch(/kind=/);
    expect(await dashboardAt(all)).toContain("the race froze");
  });

  it("offers a way back to the first page once a cursor is present", async () => {
    // Every other link on a paged view preserves the cursor, so without this
    // one, paging forward is a trip the operator cannot walk back.
    const now = Date.now();
    await seedTwoRacePages(now);
    await insert({ message: "the race froze", kind: "bug" });

    const firstPage = await dashboard("&kind=bug");
    expect(firstPage).not.toContain("← Newest");

    const paged = await dashboardAt(hrefFor(firstPage, "Older"));
    expect(paged).toContain("dev:rzzz");

    const newest = hrefFor(paged, "← Newest");
    expect(newest).not.toMatch(/before/);
    expect(newest).toContain("kind=bug");

    const back = await dashboardAt(newest);
    expect(back).toContain("dev:r000");
    expect(back).not.toContain("dev:rzzz");
    // The kind filter came back with us rather than being reset on the way.
    expect(back).toContain("the race froze");
  });

  it("still offers the way back when the cursor lands past the oldest race", async () => {
    const now = Date.now();
    await seedTwoRacePages(now);

    const pastTheEnd = await dashboardAt(`/admin/?token=t&before=${now - 9999999}`);
    expect(pastTheEnd).toContain("No races yet");

    expect(await dashboardAt(hrefFor(pastTheEnd, "← Newest"))).toContain("dev:r000");
  });
});

describe("admin dashboard — a failed contact read is not a silent empty inbox", () => {
  // This dashboard is the only place a contact message is ever read, so a list
  // that came back empty because the query failed must not render identically
  // to a genuinely empty inbox with nothing recorded anywhere.
  it("logs the degradation and still serves the rest of the page", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await env.DB.exec("DROP TABLE contact_messages");
      const body = await dashboard();

      expect(body).toContain("No contact messages");
      expect(body).toContain("Recent races");

      const logged = warn.mock.calls
        .map(([line]) => {
          try {
            return JSON.parse(line);
          } catch {
            return null;
          }
        })
        .filter((entry) => entry?.kind === KINDS.CONTACT_DB);
      expect(logged.map((entry) => entry.context.phase).sort()).toEqual(["counts", "list"]);
      expect(logged.every((entry) => entry.err?.message)).toBe(true);
    } finally {
      warn.mockRestore();
      await env.DB.exec(CONTACT_MESSAGES_DDL);
    }
  });

  it("stays quiet on the ordinary empty inbox", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(await dashboard()).toContain("No contact messages");
      expect(warn.mock.calls.filter(([line]) => String(line).includes(KINDS.CONTACT_DB))).toEqual([]);
    } finally {
      warn.mockRestore();
    }
  });
});

describe("admin dashboard — captured context", () => {
  const CONTEXT = JSON.stringify({
    browser: "Chrome 141",
    os: "macOS",
    page: "/some/route",
    app_version: "0.1.0",
    deploy_id: "66a6cecb-309c-4637-8a93-748840df0cee",
    signed_in: false,
    viewport: "1512x845",
    screen: "3024x1964",
    dpr: 2,
    ua: "Mozilla/5.0 (Macintosh) Chrome/141.0.0.0",
  });

  const insertWithContext = (context, message = "the race froze") =>
    insertContact({ message, kind: "bug", context });

  it("surfaces every captured field when reading a report", async () => {
    await insertWithContext(CONTEXT);
    const body = await dashboard();
    for (const value of ["Chrome 141", "macOS", "/some/route", "0.1.0", "1512x845", "3024x1964"]) {
      expect(body).toContain(value);
    }
  });

  it("shows the deploy id under its own label, not as a raw key", async () => {
    // The one field that distinguishes builds, so it must be readable at a
    // glance rather than falling through to the unknown-key passthrough.
    await insertWithContext(CONTEXT);
    expect(await dashboard()).toMatch(
      /deploy<\/dt><dd>66a6cecb-309c-4637-8a93-748840df0cee<\/dd>/
    );
  });

  it("still renders a report from a build with no deploy id", async () => {
    // Reports filed before the version_metadata binding existed have no
    // deploy_id at all; the row must render rather than showing an empty field.
    await insertWithContext(JSON.stringify({ app_version: "0.1.0", browser: "Chrome 141" }));
    const body = await dashboard();
    expect(body).toContain("Chrome 141");
    expect(body).not.toContain("deploy</dt>");
  });

  it("labels the fields rather than dumping raw JSON keys", async () => {
    await insertWithContext(CONTEXT);
    const body = await dashboard();
    expect(body).toContain("user agent");
    expect(body).toContain("pixel ratio");
  });

  it("labels the captured path as where they came from, not where the bug was", async () => {
    // It is referrer-derived, so it is the page they reached the form from.
    // Where the bug happened is a question the form asks outright.
    await insertWithContext(CONTEXT);
    expect(await dashboard()).toMatch(/came from<\/dt><dd>\/some\/route<\/dd>/);
  });

  it("renders booleans readably", async () => {
    await insertWithContext(JSON.stringify({ signed_in: true }));
    const body = await dashboard();
    expect(body).toMatch(/signed in<\/dt><dd>yes<\/dd>/);
  });

  it("shows unknown keys from a newer writer rather than hiding them", async () => {
    await insertWithContext(JSON.stringify({ browser: "Chrome 141", future_field: "kept" }));
    expect(await dashboard()).toContain("future_field");
  });

  it("escapes HTML in context values", async () => {
    // Client-controlled, exactly like the message body — the allowlist bounds
    // which keys are stored, not what a stranger can put inside one.
    await insertWithContext(JSON.stringify({ viewport: "<img src=x onerror=alert(1)>" }));
    const body = await dashboard();
    expect(body).not.toContain("<img src=x onerror=alert(1)>");
    expect(body).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("shows unparseable context rather than silently swallowing it", async () => {
    await insertWithContext("{not json");
    const body = await dashboard();
    expect(body).toContain("unparseable");
    expect(body).toContain("{not json");
  });

  it("surfaces the device id so looking up that browser's races needs no D1 query", async () => {
    await env.DB.prepare(
      "INSERT INTO contact_messages (id, email, message, kind, user_id, device_id, handled, created_at, context) " +
        "VALUES (?, NULL, 'the race froze', 'bug', NULL, ?, 0, ?, ?)"
    ).bind(crypto.randomUUID(), "dev-abc123", Date.now(), CONTEXT).run();
    expect(await dashboard()).toMatch(/device<\/dt><dd>dev-abc123<\/dd>/);
  });

  it("shows the device id even when a submission captured no context", async () => {
    await env.DB.prepare(
      "INSERT INTO contact_messages (id, message, kind, device_id, handled, created_at) " +
        "VALUES (?, 'plain question', 'general', ?, 0, ?)"
    ).bind(crypto.randomUUID(), "dev-xyz789", Date.now()).run();
    expect(await dashboard()).toMatch(/device<\/dt><dd>dev-xyz789<\/dd>/);
  });

  it("escapes HTML in the device id", async () => {
    await env.DB.prepare(
      "INSERT INTO contact_messages (id, message, kind, device_id, handled, created_at) " +
        "VALUES (?, 'plain question', 'general', ?, 0, ?)"
    ).bind(crypto.randomUUID(), "<img src=x onerror=alert(1)>", Date.now()).run();
    const body = await dashboard();
    expect(body).not.toContain("<img src=x onerror=alert(1)>");
    expect(body).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("renders no context block for a message that has none", async () => {
    await env.DB.prepare(
      "INSERT INTO contact_messages (id, message, kind, handled, created_at) VALUES (?, 'plain question', 'general', 0, ?)"
    ).bind(crypto.randomUUID(), Date.now()).run();
    const body = await dashboard();
    expect(body).toContain("plain question");
    expect(body).not.toContain("<details class=\"ctx\"");
  });
});

describe("admin dashboard — database still on the pre-0008 schema", () => {
  // Migrations are applied by hand while the Worker deploys from a push, so
  // this dashboard can run against a database that has no `context` column. It
  // is the only place contact messages are ever read, so it has to keep listing
  // them through that window — with no context to show, not with no messages.
  const rebuild = async (ddl) => {
    await env.DB.exec("DROP TABLE IF EXISTS contact_messages");
    await env.DB.exec(ddl);
  };

  beforeAll(() => rebuild(CONTACT_MESSAGES_DDL_0006));
  afterAll(() => rebuild(CONTACT_MESSAGES_DDL));

  async function insertLegacy({
    id = crypto.randomUUID(),
    message,
    kind = "general",
    email = null,
    device_id = null,
    handled = 0,
    created_at = Date.now(),
  } = {}) {
    await env.DB.prepare(
      "INSERT INTO contact_messages (id, email, message, kind, user_id, device_id, handled, created_at) " +
        "VALUES (?, ?, ?, ?, NULL, ?, ?, ?)"
    ).bind(id, email, message, kind, device_id, handled, created_at).run();
  }

  it("lists existing messages instead of the empty state", async () => {
    await insertLegacy({ message: "my printer is on fire", email: "a@b.com" });
    await insertLegacy({ message: "please delete my data", kind: "deletion" });
    const body = await dashboard();
    expect(body).not.toContain("No contact messages");
    expect(body).toContain("my printer is on fire");
    expect(body).toContain("a@b.com");
    expect(body).toContain("please delete my data");
  });

  it("still counts the unhandled ones and still filters by kind", async () => {
    await insertLegacy({ message: "a general question", kind: "general" });
    await insertLegacy({ message: "delete me please", kind: "deletion" });
    await insertLegacy({ message: "already dealt with", kind: "general", handled: 1 });

    const all = await dashboard();
    expect(all).toContain("2 unhandled");
    expect(all).toContain("General (2)");

    const filtered = await dashboard("&kind=deletion");
    expect(filtered).toContain("delete me please");
    expect(filtered).not.toContain("a general question");
  });

  it("shows the device id, which lives outside the missing column", async () => {
    await insertLegacy({ message: "the race froze", device_id: "dev-abc123" });
    expect(await dashboard()).toMatch(/device<\/dt><dd>dev-abc123<\/dd>/);
  });

  it("still escapes a submitted message", async () => {
    await insertLegacy({ message: "<img src=x onerror=alert(1)>" });
    const body = await dashboard();
    expect(body).not.toContain("<img src=x onerror=alert(1)>");
    expect(body).toContain("&lt;img src=x onerror=alert(1)&gt;");
  });

  it("still renders the empty state when there genuinely are no messages", async () => {
    expect(await dashboard()).toContain("No contact messages");
  });

  it("degrades to the empty state when the table is missing altogether", async () => {
    await env.DB.exec("DROP TABLE contact_messages");
    try {
      const body = await dashboard();
      expect(body).toContain("No contact messages");
      expect(body).toContain("Recent races");
    } finally {
      await env.DB.exec(CONTACT_MESSAGES_DDL_0006);
    }
  });
});
