# Test Plan

Comprehensive test plan for Arithmetic Racer: strategy, automated coverage, a regression
catalog built from git history, manual/exploratory scenarios, and the release checklist.
This extends the previous version of this file, which covered only the manual smoke and
regression sections (5, 6, and part of 10 below); everything else — strategy/pyramid (1),
unit conventions (2), integration/contract (3), the regression catalog (4), perf/load (7),
security/privacy (8), accessibility (9), the CI-vs-manual release checklist (10), and the
gaps backlog (11) — is new here. Section 12 consolidates every run command in one place.

All of the original manual scenarios (Quickplay smoke, two-browser multiplayer matrix, WS
protocol probes, D1 persistence checks, recent-finishes and leaderboard scenarios) are kept
verbatim under section 6.

---

## 1. Test strategy and the test pyramid

Two runners, deliberately split by what they need to be true, per `AGENTS.md`'s "Tests run
under two runners":

- **`node --test`** — pure logic with no Worker runtime: `public/src/*.test.js` (client-side
  modules with no DOM dependency beyond what jsdom-free unit tests need),
  `server/room-stats.test.js` (pure helper math, explicitly excluded from vitest in
  `vitest.config.js`), `migrations/*.test.js` (schema/backfill replay against in-memory
  SQLite), and `scripts/*.test.mjs` (the schema-drift checker's own logic).
- **`vitest run`** — everything that needs a real Worker/Durable Object/D1 binding, via
  `@cloudflare/vitest-pool-workers`: `worker/**/*.test.js` (routes) and `server/**/*.test.js`
  (room logic, minus `room-stats.test.js`). Each test file gets its own ephemeral D1 built
  from `migrations/` (`worker/test-setup.js`) — see `vitest.config.js` `include`/`exclude`.

There is no browser-driven or full end-to-end layer today (see §5). The pyramid is therefore
two-tiered in practice:

```
        manual/exploratory (§6)        ← browser flows, multiplayer, WS probes
      ────────────────────────────
   vitest: Worker routes + DO logic     ← real D1, real Durable Object, no mocks (§3)
  ──────────────────────────────────
 node --test: pure client + server logic + migrations   ← 265 tests, no I/O
```

768 tests pass today (265 under `node --test`, 503 under `vitest`) — see §12 for the exact
commands. Both counts move independently; treat a widening gap between "features shipped"
and "tests added" as the signal to revisit §11.

## 2. Unit tests

**Convention:** every test file is colocated with the module it tests, named
`<module>.test.js` (or `.test.mjs` for the two `scripts/` files, matching their source
extension). There is no separate `tests/` tree — this is enforced structurally, not by
lint: a stray test file in the wrong directory silently joins the wrong runner (see
`vitest.config.js`'s `include` globs).

| Directory | Runner | What's covered |
| --- | --- | --- |
| `public/src/*.test.js` | `node --test` | Client logic: `runner.js`/`remote-runner.js` (race loop), `game.js` (problem generation, difficulty), `bot.js`/`bot-timeline.js`, `handles.js`, `header.js`, `profile.js`, `room-config-rules.js`, `room-expiry.js`, `seeded-rng.js`, `username-validator-client.js`, `recent-finishes.js`, `leaderboard.js`, `leaderboard-period.js`, `bug-report-context.js`, `auto-start.js` |
| `server/*.test.js` (vitest) | `vitest` | Room DO behavior: `room-identity.test.js`, `public-room.test.js`, `room-config.test.js`, `room-handles.test.js`, `room-winddown.test.js`, `lobby-router.test.js`, `socket-limit.test.js` |
| `server/room-stats.test.js` | `node --test` | Pure PPM/points math, no DO — explicitly carved out of vitest |
| `worker/*.test.js` | `vitest` | Worker-level helpers with D1/binding dependencies: `email.test.js`, `log-throttle.test.js`, `logger.test.js`, `plausibility.test.js`, `race-result-store.test.js`, `race-score.test.js`, `rate-limit.test.js`, `user-agent.test.js`, `username-validator.test.js`, `version.test.js` |
| `worker/routes/*.test.js` | `vitest` | Route handlers: `admin.test.js`, `contact.test.js`, `leaderboard.test.js`, `matchmake.test.js` + `matchmake-e2e.test.js`, `me.test.js`, `race-result.test.js`, `recent-finishes.test.js` |
| `migrations/*.test.js` | `node --test` | `migrations.test.js` (schema left behind by replaying all files into in-memory SQLite), `points-backfill.test.js` (data-rewrite migration) |
| `scripts/*.test.mjs` | `node --test` | `check-schema-drift.test.mjs`, `sql-constraints.test.mjs` — the drift checker's own logic |

**How to run:**
- Everything: `npm test` (see §12).
- Just the `node --test` layer: `node --test public/src/*.test.js server/room-stats.test.js migrations/*.test.js scripts/*.test.mjs`
- Just `vitest`: `npx vitest run`
- A single file: append its path to either command, e.g. `node --test server/room-stats.test.js` or `npx vitest run server/room-identity.test.js`.

**What's missing:** no dedicated unit tests for `public/src/main.js` (routing between
Quickplay/lobby-room/room-expired screens) or `server/room.js`'s WebSocket message dispatch
itself (`handleHello`, `submitAnswer`, `validateAnswer`) beyond what `room-identity.test.js`
and `room-config.test.js` exercise incidentally. See §11 for prioritization.

## 3. Integration and contract tests

There is no mocking layer for the database or the Durable Object — vitest tests run against
real bindings:

- **D1**: `@cloudflare/vitest-pool-workers` gives each `worker/**/*.test.js` and
  `server/**/*.test.js` file its own ephemeral D1 instance, schema applied fresh from
  `migrations/` via `readD1Migrations` (`vitest.config.js`) and `worker/test-setup.js`. A
  schema change belongs in a migration file, never inline in a test — `migrations.test.js`
  is what would catch drift between the two.
- **Durable Objects**: `runInDurableObject` (from `cloudflare:test`) drives the real
  `RaceRoom`/`PublicRaceRoom` classes — see `server/room-winddown.test.js` and
  `server/room-identity.test.js` for the pattern (real alarms, real `state.storage`).
- **Worker routes**: `worker/routes/*.test.js` hit route handlers with real D1 reads/writes,
  asserting on response shape and on what actually landed in `race_results` / `user` /
  `contact_bug_reports`.
- **Third-party services**: none are exercised in tests, because none are meaningfully
  integrated in production either. `worker/email.js` (Loops) is unit-tested against its own
  payload-building logic (`worker/email.test.js`), not a live Loops call. The contact-message
  notification email path documented as dead in `AGENTS.md` ("The admin dashboard is the real
  delivery path") has never fired in production, so there is nothing live to contract-test
  against — the D1 row plus `worker/routes/admin.test.js` is the real integration surface.
  better-auth (Google OAuth) has no integration test; §11 lists it as a gap.
- **What's mocked:** nothing that reaches a real backend. `vi.useFakeTimers()` /
  `vi.advanceTimersByTime()` stand in for wall-clock time in `room-winddown.test.js` and
  similar alarm-driven tests — that's a clock mock, not a service mock.

**What's missing:** no contract test asserts the WebSocket message *shapes* (`hello`,
`youAre`, `publicState`, `state`) against a schema — today that contract is implicit in
`server/room.js` and whatever each test happens to assert on. See §11.

## 4. Regression catalog

Built from every `fix:`/`fix(...)`/hotfix-shaped commit and `no-mistakes(review)` fix commit
in `git log`. Squashed/rebased duplicates of the same fix (multiple SHAs for one PR) are
collapsed to one row.

**Rule for every future fix:** a fix commit must add or extend a test that would have failed
before the fix, and this table must gain a row (or update an existing UNGUARDED row to
GUARDED) in the same PR. A fix with no test is `UNGUARDED` until one exists — leaving it
that way past the PR that introduced the fix is the thing this rule exists to prevent.

| # | Regression | Commit(s) | Guarding test | Status |
| --- | --- | --- | --- | --- |
| 1 | **Room-identity secrecy**: `racerId` (reconnect credential) must never reach the wire; broadcast `player.id` must never work as a reconnect credential; `ownsSeat()` must require both a real racerId match and a real `connection.id` so two unknowns never collide. Full invariant writeup: `AGENTS.md` "Room identity: two ids, only one of them public". | 4cabaea / 0848fda / 368eaef (`fix(room): stop broadcasting the racerId and require it to reclaim a seat`, #23); 8f0db99 / fe10291 (`fix: strip deviceId/userId from the Quick Match finish broadcast`, #20) | `server/room-identity.test.js`, `server/public-room.test.js` | GUARDED |
| 2 | **Idle winddown / alarm coalescing**: a private room's alarm must track `lastActivityAt`, not fire early or leave a live room stranded; public (Quick Match) rooms must never show the expired screen (`expiresWhenIdle() === false`). Full invariant writeup: `AGENTS.md` "Room lifecycle: private rooms wind down, public ones do not". | 49a14e1 (#27, feature introducing the mechanism, not a fix commit, but the trap it guards against — the `lastActivityAt`/persistence gap — is exactly what the test file's own header documents) | `server/room-winddown.test.js` | GUARDED |
| 3 | **D1 schema drift**: migrations applied by hand to prod/preview can silently diverge from `migrations/` (2026-07-28 incident: 3 migrations missing from both databases). | 68557fc (chore, renumbering after the incident) | `scripts/check-schema-drift.test.mjs`, `migrations/migrations.test.js` — but the *live-database* check (`npm run check:schema`) itself is not automated in CI (see §10) | PARTIALLY GUARDED — logic tested, live check is manual/dispatch-only |
| 4 | Quick Match bot backfill not disclosed to the player. | f0dd57e (#22) | No dedicated automated test found for the disclosure copy itself (a DOM/copy assertion); covered only by manual §6 Quick Match section | UNGUARDED |
| 5 | Preview env D1 binding pointed at the wrong database. | f7bfaaf / a5a5e8c (#7) | No test — this is a `wrangler.jsonc` config fact, not code; guarded operationally by `AGENTS.md`'s "two-place edit" rule and `migrations/README.md`'s lockstep requirement | UNGUARDED (by design — not a code-testable regression) |
| 6 | Host could not change race config (difficulty/length) between races in a private room ("frozen difficulty" bug). | 1e7e830 (#16) | `server/room-config.test.js` | GUARDED |
| 7 | Rate limiting silently broken (fail-open without warning); bot detection too loose. | f6afd99; later refined by 0d11b80/58781b6 (`latch fail-open rate-limit warns, fix cache claims`) | `worker/rate-limit.test.js` | GUARDED |
| 8 | Leaderboard: race length not pinned to the canonical value at race time, letting a later config change relabel a finished race; stale board copy. | 94c89ec/915b1a0 (`pin canonical race length to room state, fix board copy`) | `server/room-stats.test.js`, `worker/routes/leaderboard.test.js` (both assert on `problems_total`/`raceLength` pinning) | GUARDED |
| 9 | Leaderboard: reading the `points` column before its migration lands can 500 the page; stale board left mounted after a repaint. | 8f525f7/d0d5e60 (`guard leaderboard points column, fix stale board repaint`) | `worker/routes/leaderboard.test.js` (drops the column, asserts fallback — per `AGENTS.md`'s "Reading points can 500 the page") | GUARDED |
| 10 | Recent-finishes strip: not recoverable after a failed fetch; live-region announced on every poll tick instead of on change; a tie-break test that passed vacuously. | 572459a (`fix recent-finishes strip recovery, live-region churn, and vacuous tie test`) | `public/src/recent-finishes.test.js`, `worker/routes/recent-finishes.test.js` | GUARDED |
| 11 | Disconnect-timeout path did not write a DNF (`finished=0`) row distinct from an explicit quit. | 2448b8c (`disconnect-timeout writes DNF row; split manual matrix R3`) | No `node --test`/`vitest` file found asserting the disconnect-timeout → DNF write path specifically (the DO's `removePlayer` path); covered manually as R3b in §6 | UNGUARDED |
| 12 | Race-end logic ended the race before the slower player finished; animation stutter; missing `(Guest)` badge. | 7694dca | `public/src/recent-finishes.test.js` covers the Guest-badge convention broadly; no test isolates the race-end-waits-for-slowest-player invariant | PARTIALLY GUARDED |
| 13 | `isCreator` badge leaking into the public Quick Match lobby (host-only UI showing for non-hosts). | caa5808 | `server/public-room.test.js` asserts on `publicPlayer()`'s strip list generally; no assertion found isolating the `isCreator` badge specifically | UNGUARDED |
| 14 | Lockfile missing optional platform packages for non-macOS platforms, breaking `npm ci` under npm 11. | 4c3ac03 (`fix(ci): record every platform's optional deps in the lockfile`) | No automated test (this is a `package-lock.json` content fact); guarded by the sanity-check procedure in `AGENTS.md`'s "Dependencies and the lockfile" | UNGUARDED (procedural guard only) |
| 15 | Post-Quickmatch UI regressions: lobby layout, stale banner, bot names visible when they shouldn't be. | d6e23d0 (#9) | No dedicated test found; likely folded into later `public/src/*.test.js` coverage of the same screens, not isolated by name | UNGUARDED |
| 16 | Admin dashboard: `createdAt` type mismatch breaking drill-down and the signups window. | 2167f26 | `worker/routes/admin.test.js` | GUARDED |

## 5. End-to-end and UI tests

There is no automated browser/E2E layer in this project today — no Playwright, no
Puppeteer, no headless-Chrome suite. `worker/routes/matchmake-e2e.test.js` is the closest
thing to an "e2e" test by name, but it is a vitest test exercising the matchmaking route
end-to-end at the HTTP/DO level, not a browser test.

All UI/browser coverage is manual (§6), run against:
- **Browsers**: any two modern Chromium/Firefox/Safari windows, or one regular + one
  incognito window of the same browser (distinct `localStorage` is what matters — see §6's
  note on `racerId` isolation).
- **Devices**: no device lab; `AGENTS.md`/`docs/testing.md` history references "iOS Safari
  label" fixes (b460915, 255d720) as evidence real-device testing has happened ad hoc, not
  as a standing matrix.
- **Simulators**: none used or required — this is a web app with no native shell.

Adding a real browser-driven E2E suite (Playwright against `wrangler dev`) is the single
highest-leverage gap this plan identifies; see §11 item P1.

## 6. Manual and exploratory test plan

The full manual test matrix below is unchanged from the prior version of this document,
with one addition: a new **Quick Match** section.

### Local dev

```bash
npm run dev   # wrangler dev — serves Worker + static assets on :8787
```

For browser tests open `http://localhost:8787` in two different browsers (or one regular
window + one incognito) so each has its own `localStorage` and therefore its own `racerId`.
Same-browser tabs share storage and look like the same player to the server.

### Quickplay smoke (no server-side state)

1. Open `http://localhost:8787/`.
2. Pick a difficulty.
3. Click **Quickplay**.
4. Expect:
   - Race screen with **5 lanes** (you + 4 bots).
   - Your handle reads `<Name> (Guest)` on lane 1; bots have no `(Guest)` suffix.
   - Countdown 3 → 2 → 1 → GO.
   - 10 problems in the queue; score chip starts `0 / 10`.
5. Type answers correctly. Verify:
   - Your car moves on Enter (no perceptible delay).
   - Bot cars advance over time on their own.
   - Wrong answer shakes the input (red flash, no score change).

### Quick Match (public room) manual section

Covers the queued item: the **Find a Match** entry point, the auto-start deadline, bot
backfill of empty lanes, the "Searching…" pill, and the bot-disclosure hint — plus a
two-browser probe for humans landing in the same match. Automated coverage that exists
today: `server/public-room.test.js` (secrecy — see regression #1/#13 in §4),
`public/src/auto-start.test.js` (the deadline math in isolation), `server/lobby-router.test.js`
(routing into a public room), `worker/routes/matchmake.test.js` + `matchmake-e2e.test.js`
(matchmaking). What's left to check by hand:

| # | Step | Expected |
|---|---|---|
| Q1 | On `/`, under **Find a Match**, pick a difficulty radio and click **Find Match** (`#btn-find-match`, distinct from **Quickplay** and **Create Private Room**) | Button disables and `#match-status` reads `Searching…` while the request is in flight; on success the tab navigates to `/?room=<slug>&mode=public&difficulty=<diff>` — the slug is in the URL but never shown in the UI (per c0f9a4c, "hide room slug") |
| Q2 | Land in the Quick Match lobby (`isPublic` mode) | Header reads **Quick Match**, not the room slug; there is no **Start Race** or **Invite** button — races auto-start, there is nothing to invite a link into |
| Q3 | Watch the lobby with only you present | A **Searching… 1 / 6 humans** pill sits where the start button would be in a private room (`lobby.js`'s `searchingPill`, counts only `!p.isBot` players) |
| Q4 | You are the first human in an otherwise-empty room | Auto-start deadline is set 5s out (`LONE_TIMEOUT_MS`); if nobody else joins, the race auto-starts alone (backfilled to 6 with bots) roughly 5s after you land in the lobby |
| Q5 | A second human joins before that 5s elapses | The deadline resets to 5s from the *second* join (`GATHER_WINDOW_MS`) — confirm the race does not fire at the original ~5s mark, giving the pair a fresh gather window |
| Q6 | 3rd/4th/5th humans join during the gather window | Deadline is unchanged by each of these joins — only the 1st and 2nd joins move it (`computeAutoStartDeadline` in `public/src/auto-start.js`) |
| Q7 | A 6th human joins (`MAX_PLAYERS`) | Race starts immediately, no waiting out the remaining gather window |
| Q8 | Room has fewer than 6 human players when the auto-start deadline fires | Bots backfill every remaining lane (`runAutoStart` in `server/public-room.js`) so the race is always full |
| Q9 | Bot-backfilled lanes, once the race starts | Carry the `(Guest)` badge, same as a human guest — the badge encodes "no account," not "human," so this is not a privacy leak (see `AGENTS.md`/§8) |
| Q10 | Read the lobby hint text while in the `lobby` state (public mode) | Reads exactly `Any lane no human takes gets a practice bot.` — the bot-disclosure hint (regression #4, f0dd57e); confirm it's legible body copy, not hidden in a tooltip |
| Q11 | Two browsers (or one regular + one incognito) both click **Find Match** with the same difficulty within a few seconds of each other | Both land in the *same* room (`?room=` matches in both tabs' URLs); each sees the other in the player list, both counted in the `Searching… 2 / 6 humans` pill, and the shared auto-start deadline follows Q4/Q5 above |
| Q12 | Race finishes in a Quick Match room | Row(s) written to `race_results` with `room_id` set (see §6 D1 checks below); eligible for recent-finishes/leaderboards per `AGENTS.md`'s eligibility rules |
| Q13 | Leave a Quick Match room idle for the same window that expires a private room | **No** room-expired screen — public rooms never wind down (`AGENTS.md` "Room lifecycle"; regression #2). Confirm by leaving the tab open past `PRIVATE_ROOM_IDLE_MS` (or a temporarily-lowered value under `wrangler dev`) |
| Q14 | Two separate Quick Match attempts from two browsers, far enough apart (or at different difficulties) that they land in different rooms | Neither can see or guess the other's private-room-style invite link — there isn't one; matchmaking is server-driven |

### Multiplayer two-browser smoke

| # | Step | Expected |
|---|---|---|
| 1 | Browser A clicks **Create Private Room** | URL becomes `/?room=<slug>`; lobby-room screen; invite modal pops automatically. |
| 2 | Copy URL → paste into Browser B | B joins the lobby; A sees B in the player list. |
| 3 | Each row in lobby player list | Shows `<handle>`, `(you)`, `(host)`, `(Guest)` badges as appropriate. |
| 4 | Non-creator (B) clicks their own handle inline | Edits to a new handle; both browsers reflect the new name. |
| 5 | Creator (A) changes difficulty in the lobby | Both browsers' difficulty buttons reflect the new pressed state. |
| 5b | Creator (A) changes difficulty **after a race**, on the post-race lobby-room screen | Controls are enabled (not greyed out); B sees a "Host set the race to …" toast; the next **Race Again** → **Start Race** uses the new difficulty. Regression guard for the frozen-difficulty bug (§4 #6). |
| 6 | Creator clicks **Start Race** with only themselves in the room | Button is disabled; server rejects with `NEED_MORE_PLAYERS` if forced via DevTools. |
| 7 | Creator clicks **Start Race** with B present | Both see countdown 3 → 2 → 1 → GO, then the race screen. |
| 8 | Both type correct answers | Each car advances on both browsers (own car moves on Enter; opponent moves on next server tick). |
| 9 | Type a wrong answer | Only the typing browser's input shakes; other browser unaffected. |
| 10 | Click **Quit race** mid-race | Quitter is sent back to lobby-room; lane shows dropped (desaturated); race continues for the other player. |
| 11 | First player crosses the finish line | Finish banner shows; race **does not** end until the slower player also finishes. |
| 12 | Slower player completes their last problem | Both see the results screen with rankings sorted by `finishMs`. |
| 13 | Creator clicks **Race Again** (results / lobby-room) | Both return to lobby in state `lobby`; new problem sequence generated on next Start. |
| 14 | Hard-refresh one tab mid-race | Player rejoins automatically with the same `playerId`; score, finishMs, dropped state all preserved. |
| 15 | Close last tab, wait 5 minutes, revisit the URL | Treated as a brand-new empty room (state was reset by the idle-cleanup alarm). The 30-minute idle clock keeps running underneath — the reset does not restart it. |
| 15b | Leave a private room untouched past its idle window, then look at the open tab | Both tabs land on the **Room expired** screen. Fastest way to see it without waiting 30 minutes: drop `PRIVATE_ROOM_IDLE_MS` in `server/room.js` to ~30s against `wrangler dev`. |
| 15c | From that screen, click **Back to Home** / **Create a New Room** | Home clears `?room=` from the URL; Create navigates to a fresh `?room=<slug>` that opens as a working lobby (not "expired" again). |
| 15d | Revisit the expired room's URL in a new tab | Straight to **Room expired** — no lobby, no spinner, and the socket does not sit there reconnecting. |
| 15e | Quick Match a room, then leave it idle for the same window | Unaffected: public rooms never show the expired screen. |
| 16 | Visit `/` with no `?room=` param | Quickplay lobby appears — no regression from multiplayer changes. |

### Things to watch for during regression sweeps

- **Animation jank.** Cars should glide; the problem queue should slide. If you see stutter, suspect: a new CSS transition on a layout-triggering property (`left`, `width`, `font-size`), or a new high-frequency state broadcast on the server.
- **Optimistic update divergence.** Local car moves before the server confirms. If your car gets *ahead* of the server's view (e.g. local says 5, server says 3), the server's later state will yank you back. Should not happen in practice — both validate against the same `problemSequence`. If it does, look at any change in `submitAnswer` or `validateAnswer`.
- **(Guest) badge dropping off.** Should appear on: lobby rows (as a badge), race lanes (inline), podium (inline). Quickplay's local player too. Quickplay's local bots have no badge; Quick Match's server-side bots do carry it — the badge only encodes "no account", and bots have none. Bot backfill is disclosed in the Quick Match copy, so it is not a leak.
- **Solo Quickplay regression.** `?room=` routing in `main.js` is gated; the no-param path should still hit the bot race exactly as before.

### WebSocket protocol probes (server-side regression)

Quick Node-based probes useful when changing `server/room.js`. Examples are in `/tmp/ws-*.mjs` from the Phase 6 build; the pattern is:

```js
import { WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';

const ws = new WebSocket('ws://localhost:8787/parties/race-room/<room-slug>');
ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', playerId: randomUUID(), handle: null })));
ws.on('message', (d) => console.log(JSON.parse(d.toString())));
```

Useful scenarios to probe:
- Solo `start-race` → expect `error: NEED_MORE_PLAYERS`.
- Two players, one finishes fast, other takes 10+ seconds → both should finish with `finishMs`, no DNF.
- Disconnect mid-race, reconnect within 30 seconds → score preserved.
- Disconnect, wait 35 seconds → treated as a brand-new player on next hello.
- During racing, count `type: 'state'` messages received — should stay low (~1–2 per race, only on state transitions).

### Room races → race_results persistence

These verify that each room race writes one row per player to `race_results`. Run against `npx wrangler dev`. Inspect with:

```bash
npx wrangler d1 execute arithmetic-racer --local --command="SELECT id, user_id, device_id, finished, finish_time_ms, points, room_id, played_at FROM race_results ORDER BY played_at DESC LIMIT 10"
```

| # | Scenario | Expected |
|---|---|---|
| R1 | Two anon browsers, both finish a 10-problem race | Two rows; both `user_id NULL`, `room_id = <slug>`, `finished = 1`, distinct `device_id`s |
| R2 | Two logged-in browsers (different accounts), both finish | Two rows; both `user_id` set to the respective account ids, `room_id = <slug>` |
| R3a | Two players racing; one clicks **Quit race** mid-race | Two rows; quitter has `finished = 0`, `finish_time_ms = NULL` |
| R3b | Two players racing; one closes their tab and waits past the 30s reconnect grace | Two rows; the disconnected player has `finished = 0`, `finish_time_ms = NULL` (covers the `removePlayer` path, distinct from R3a's `handleQuit` path — this is regression #11 in §4, currently UNGUARDED by an automated test) |
| R4 | One logged-in + one anon, both finish | Two rows; logged-in player's row has `user_id` set, anon has `user_id NULL` |
| R5 | After R2, the logged-in player visits Profile | Their **Race History** table includes the just-finished room race |
| R6 | Solo Quickplay race (regression check) | One row written via the route; `room_id = NULL`; existing solo stats behavior unchanged |
| R7 | Any finished race (solo or room) | Row has non-NULL `points`; a quit race has `points NULL` |
| R8 | After R7, the logged-in player visits Profile | Headline shows a PPM figure for that difficulty only — the other two tiers are unchanged — and the race's row shows its own PPM and Points |

### Superhuman-pace verification (captcha)

A standard ten-problem room race finished faster than `CAPTCHA_TRIGGER_MS_PER_PROBLEM` (500 ms/problem — see `worker/plausibility.js` for the evidence; other race lengths are never challenged) is held: the server sends that one client a `captcha` message with 3 fresh problems (no answers on the wire) and 12s to answer all three. Pass → the row records normally; wrong answer or the deadline → the row records with `suspect = 1` / `captcha_failed` | `captcha_timeout` and is excluded from leaderboards and the lobby strip. Never a ban.

The challenge belongs to the racer, not the race: it opens the moment *that* racer finishes (so the clock does not start while they wait on a straggler), only their own answers or their own deadline settle it, and the banner is a room-lifetime overlay that survives the results screen and a page reload. Automated coverage: `server/captcha.test.js`, `server/room-captcha.test.js`, `public/src/captcha-session.test.js`, `worker/routes/captcha-exclusion.test.js`.

Triggering one by hand is easiest with the WS probe above, answering all 10 problems within a couple of seconds of `race-start` (paste the answers from the `race-start` sequence — you are simulating a bot, after all):

- Two probe clients in a fresh room, both `hello`, host `start-race` → at `race-start`, immediately send all 10 correct answers for one client, and none for the other → expect a targeted `captcha` message on that socket only, while the room is still `racing`, `problems` entries carrying `problem` and no `answer`.
- Answer the 3 problems correctly (`captcha-answer`) → `captcha-result {verified: true}`; D1 row for that device has `suspect = 0` and appears in `/api/leaderboard` (for a canonical 10-problem race) and `/api/recent-finishes`.
- Repeat, but answer one captcha problem wrong → `captcha-result {verified: false, reason: "captcha_failed"}`; D1 row has `suspect = 1`, `suspect_reason = "captcha_failed"`, and the row is absent from both surfaces.
- Repeat, but send nothing after the `captcha` message → after ~12s expect `captcha-result {verified: false, reason: "captcha_timeout"}` and the `captcha_timeout` row.
- While a challenge is pending, send `captcha-answer` from the *other* client → nothing happens (no result message, the challenge is unaffected).

| # | Scenario | Expected |
|---|---|---|
| C1 | A human-paced race (≥5s for 10 problems) | No `captcha` message; rows write immediately as before |
| C1b | A private room set to 5 problems, finished as fast as you can | No `captcha` message — the trigger is scoped to the standard 10-problem race |
| C2 | The captcha banner is showing and the tab disconnects, then reconnects | The banner re-offers the remaining problems on the new socket, counting down what is left of the original 12s |
| C2b | The captcha banner is showing and the tab is fully reloaded (F5) | The banner comes back over the room lobby with the remaining problems; answering there still verifies the race |
| C3 | Host hits Play Again then Race Again while another player's challenge is pending | The challenged player keeps their banner and their remaining time; answering correctly still records a clean row |
| C4 | DevTools → Network, during the banner | No broadcast `state` message contains `captchaChallenges` or any captcha answer |
| C5 | A fast racer finishes while a slow one is still going | The banner appears immediately, over the race screen, and its countdown does not restart when the race ends |
| C6 | The challenged player answers all three, then the socket drops before the verdict | The banner clears itself a couple of seconds after the deadline saying verification could not be confirmed — never "failed" |
| C7 | Verify (or ignore) the captcha while the other racer is still going, then let them finish | Exactly one `race_results` row for the challenged device, carrying the verdict — a second, clean row would be an unverified finish on the board |

### Lobby "who's racing" strip

Automated coverage: `worker/routes/recent-finishes.test.js` (eligibility, suspect exclusion, ordering, limit, the missing-`points` fallback, and that the route is actually mounted) and `public/src/recent-finishes.test.js` (relative-time labels, Guest labelling, poll gating). What is left to check by hand is the browser behavior.

| # | Scenario | Expected |
|---|---|---|
| F1 | Load `/` after finishing a room race | The strip lists that finish: name (or `Guest`), `finished <difficulty>`, PPM, points, `just now` |
| F2 | Leave the tab open | The relative label ticks up on its own (`just now` → `12s ago` → `1m ago`) with no page reload; DevTools Network shows one `/api/recent-finishes` request roughly every 20s, not one every tick |
| F3 | Switch to another browser tab, wait a minute, come back | No requests while hidden; one immediately on return |
| F4 | Enter a room or start a race | Polling stops while the lobby is off-screen and resumes on returning to it |
| F5 | Finish a **Solo vs Bots** race | It does **not** appear — only room races are eligible (`worker/routes/recent-finishes.js`) |
| F6 | Empty database | The strip shows "No finishes yet…" rather than an empty card list |
| F7 | Block `/api/recent-finishes` in DevTools, reload | The whole section is hidden; the lobby is otherwise unaffected and nothing throws |
| F8 | After F7, unblock the request and wait for the next poll (~20s) | The section comes back with rows — a strip hidden by a failed load is recoverable, not gone for the page session |
| F9 | Sit on the lobby with a screen reader running | The strip is announced when a finish appears or a label ticks over, not on every 5s redraw |

### Lobby leaderboards

Automated coverage: `worker/routes/leaderboard.test.js` (eligibility, silo, ranking, period
boundaries), `public/src/leaderboard-period.test.js` (UTC windows), and
`public/src/leaderboard.test.js` (row rendering and escaping, plus the mount-order rules — clearing
the table before a cache-miss fetch, the live-region summary, and dropping a cached board whose UTC
window has rolled). What follows is the part the automated suite cannot see: that the boards reach
the lobby correctly.

Seed local D1 first (the endpoint reads only what `migrations/` defines, so apply them to the
local database before `npx wrangler dev` — the same `wrangler d1 execute … --local` invocation as
the query above, with `--file=migrations/<file>.sql` in place of `--command`).

```bash
curl -s "http://localhost:8787/api/leaderboard?difficulty=medium&period=day"
```

| # | Scenario | Expected |
|---|---|---|
| L1 | Load `/` with no `?room=` | Leaderboards card appears under **Solo vs Bots**; **Medium** and **All-time** tabs are selected |
| L2 | Click each difficulty tab | Board reloads for that tier alone; a racer fast on Easy never shows on the Hard board |
| L3 | Click each period tab | Caption under the tabs reads `Since <date> UTC.` for the four bounded windows, and `Every race, since the beginning.` for All-time |
| L4 | Finish a **standard 10-problem** room race while signed in, then navigate to `/` with **no** `?room=` | Your username appears on the matching difficulty's board (may need a period tab that covers now). Allow up to the `s-maxage` window (30s) — under `wrangler dev` the Miniflare Cache API *is* functional, so the board you get may predate your race |
| L5 | Finish a **Solo vs Bots** race while signed in | Nothing changes on any board — solo results are never eligible |
| L6 | Finish a **standard 10-problem** room race while signed out, then navigate to `/` with **no** `?room=` | Nothing changes — anonymous races are never listed. (The length matters: at any other length the row is ineligible anyway, so the row would pass without testing the anonymous rule) |
| L7 | Load `/?room=<slug>` directly | No leaderboard request is issued (Network tab); the card is not mounted on the room route |
| L8 | Board with no qualifying races | Empty-state line explains how to qualify; no empty table shell or spinner left behind |
| L9 | Create a private room, set the race length to something other than 10 (5 is the minimum), finish it while signed in, then navigate to `/` | Nothing appears on any board. PPM is not comparable across race lengths, so only the standard 10-problem race is ranked — the blurb on the card says so |

L4 and L6 say *navigate to `/`* rather than "click Play again" on purpose. Entering a room
sets `?room=` (`enterRoom` does a `replaceState`), and the leaderboard is deliberately not
mounted on that route — so after a **private** room race Play again returns to `lobby-room`,
where there is no board to look at. (After a Quick Match it does reach `/`, because that
room is one-shot; the instruction is written to be right for both.)

### Profile race history

Automated coverage: `worker/routes/me.test.js` ("GET /api/me/races": empty, exactly one page,
a short last page, the `before` cursor and its rejections, the difficulty filter with and without
matches, and that `/api/me`'s `recent` is still the first ten-row page) and
`public/src/profile.test.js` (row rendering and escaping, the per-filter empty line, and the
client-side cursor derived from `recent`). What follows is the part the suite cannot see: that
the table on the profile pages and filters.

Sign in and finish more than ten races first, across at least two difficulties. Any mode
counts — the history is the racer's own log, so solo races are listed, unlike the leaderboards.

| # | Scenario | Expected |
|---|---|---|
| H1 | Open **Profile** from the header dropdown | **Race History** lists the newest ten races, newest first, with **All** pressed; a **Load older races** button sits under the table when you have more than ten (Network tab: one `/api/me` request, no `/api/me/races`) |
| H2 | Click **Load older races** | Up to 20 older races append below the existing rows with no duplicate or skipped `Race #`; the button disappears once `#1` is on screen |
| H3 | Click a difficulty filter | Table shows that tier only, newest first; the `Race #` column keeps each race's original number, so gaps are expected |
| H4 | Filter to a difficulty you have never raced | Table empties and the line reads `No <difficulty> races yet.`; no **Load older races** button |
| H5 | Click **All** | The full history comes back, newest first |
| H6 | Finish a race, then reopen the profile | The new race is `#N+1` at the top; every older number is unchanged |
| H7 | Sign out while the profile is open | Table clears to the empty line; **Load older races** is hidden |

## 7. Performance and load

No formal performance budgets or automated load tests exist today. What's actually measured:

- **WS message frequency** (§6's WebSocket probes section): manually counted, expected "low
  (~1–2 per race, only on state transitions)" — this is the closest thing to a performance
  assertion in the project, and it is manual.
- **Leaderboard cache**: `s-maxage` (30s) via the Miniflare/Cloudflare Cache API, exercised
  manually in §6 L4 but not asserted as a timing budget by any test.
- **Animation jank**: called out as a manual regression-sweep item (§6), with no frame-timing
  assertion.

No load test exists for concurrent rooms, concurrent WebSocket connections per room
(`server/socket-limit.test.js` tests the *limit logic*, not load — it asserts the cap is
enforced, not how the system behaves near it), or D1 query latency under load. This is a gap
(§11).

## 8. Security and privacy checks

- **Room-identity secrecy** (§4 #1): `racerId`, `deviceId`, `userId` must never reach the
  wire; `publicPlayer()` is the single strip point (`AGENTS.md`). Guarded by
  `server/room-identity.test.js` and `server/public-room.test.js`.
- **Public `race_results` eligibility**: a row is only shown to someone other than its owner
  when `room_id IS NOT NULL AND suspect = 0 AND finished = 1 AND finish_time_ms > 0`;
  anything *comparative* additionally joins `"user".username` rather than exposing
  `device_id` (`AGENTS.md` "Public views of race_results share two rules"). Guarded by
  `worker/routes/leaderboard.test.js` and `worker/routes/recent-finishes.test.js`.
- **Abuse/plausibility limits**: `worker/plausibility.js` bounds self-reported solo race
  results; `worker/rate-limit.js` throttles request volume — both have dedicated test files
  (`worker/plausibility.test.js`, `worker/rate-limit.test.js`), including the fail-open
  regression (§4 #7).
- **Auth**: better-auth handles email/password and Google OAuth (`worker/auth.js`,
  `worker/session.js`). No dedicated auth-flow test file was found beyond what routes
  incidentally exercise via `worker/routes/me.test.js` — flagged as a gap (§11).
- **Secrets**: no secrets are committed; `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` live
  in GitHub Actions repo secrets and are required (not optional) by `schema-drift.yml`'s
  "Require Cloudflare credentials" step — a missing secret fails loud rather than
  soft-passing.
- **Data at rest**: D1 stores `race_results`, `user`, `contact_bug_reports`. No
  field-level encryption; the privacy posture is *what gets collected*, not encryption —
  see `AGENTS.md`'s note that the bug-report form was deliberately built "privacy-first, no
  account_id disclosure" (per project memory).

## 9. Accessibility

Coverage exists for two specific widgets, not the app broadly:

- **Recent-finishes strip**: F9 in §6 — the live region announces on finish/label-change,
  not on every 5s redraw. Automated: `public/src/recent-finishes.test.js` covers poll
  gating; the live-region *announcement* behavior itself is exercised by
  `public/src/leaderboard.test.js`'s equivalent pattern (see next bullet) more than by the
  recent-finishes test file directly.
- **Leaderboards**: `public/src/leaderboard.test.js` explicitly covers the live-region
  summary and row-rendering/escaping.
- **`aria-pressed`/`aria-live` fixes**: referenced in project history (captain memory: "aria-
  pressed/live" fixed for difficulty/period tab state and dynamic content regions) but no
  standing automated a11y audit (no axe-core, no Lighthouse CI) exists.

No Dynamic Type equivalent applies (this is a web app, not iOS), but responsive text sizing,
contrast, and keyboard-only navigation of the lobby/room screens have no automated coverage
and no standing manual checklist — gap (§11).

## 10. Release checklist

| Item | Automated or manual | Command / steps |
| --- | --- | --- |
| Full test suite | **Automated, but not run in CI** — no workflow runs `npm test` today; the only workflow (`schema-drift.yml`) checks migrations, not tests, and even that is `workflow_dispatch`-only pending Cloudflare secrets | `npm test` locally before pushing (§12) |
| Schema drift vs live databases | **Manual/dispatch-only** — `check-schema-drift.mjs` is real automation, but nothing triggers it automatically today | `npm run check:schema` (needs `sqlite3` on PATH and a wrangler login), or trigger `schema-drift.yml` via `workflow_dispatch` once the repo secrets exist |
| New migration applied to both databases | Manual, procedural | `npm run migrate:prod -- --file=…` and `npm run migrate:preview -- --file=…`, then `npm run check:schema` — see `migrations/README.md` |
| Lockfile has all platform entries (~82) | Manual sanity check | `npm ci` on the newest Node available, not only `.nvmrc`'s — see `AGENTS.md` "Dependencies and the lockfile" |
| Quickplay smoke | Manual | §6 Quickplay smoke |
| Quick Match manual flow | Manual | §6 Quick Match section |
| Multiplayer two-browser matrix | Manual | §6 Multiplayer two-browser smoke |
| Room-identity secrecy spot-check | Automated (part of `npm test`) | Covered by `server/room-identity.test.js` / `server/public-room.test.js` — no separate manual step needed once `npm test` is green |
| Idle winddown / room-expired screen | Automated + manual | `server/room-winddown.test.js` automated; §6 15b–15e for the visible behavior |
| D1 persistence spot-check | Manual | §6 "Room races → race_results persistence" |
| Recent-finishes / leaderboard browser checks | Manual (logic is automated) | §6 F1–F9, L1–L9 |
| Deploy | Manual command, no gate before it today | `npx wrangler deploy --env=""` (production) — see the deploy section below |

**What CI actually runs today, in full:** `schema-drift.yml`, `workflow_dispatch`-only,
requires `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` secrets that (per the workflow's own
comments) do not yet exist in this repo, so the workflow currently fails by design if
triggered. **`npm test` is not wired into any workflow** — the entire automated suite (768
tests) is a local, pre-push discipline, not a merge gate. This is the largest release-process
gap this plan surfaces (§11 P0).

### Deploy

```bash
# from this worktree, production (live URL — affects users)
npx wrangler deploy --env=""
```

This deploys to the `arithmetic-racer` Worker, live at `https://arithmetic-racer.albertwxu.workers.dev`. The `arithmetic-racer-preview` Worker is connected in Cloudflare Workers Builds and deploys every branch (`wrangler deploy --env preview`); its dedicated D1 database and the rest of `env.preview` are configured in `wrangler.jsonc`. Its schema must stay in lockstep with production — see [`migrations/README.md`](../migrations/README.md).

#### Why `.nvmrc` pins Node 22

Workers Builds runs `npm clean-install` before the deploy command, and on 2026-07-30 Cloudflare moved its default Node from 22 to 24.18.0. What rejects an incomplete lockfile is the npm major version, not Node itself: npm 10.9.2 tolerates optional-dependency edges that have no lock entry, while npm 11 treats them as out of sync and refuses with `Missing: … from lock file`. Node 22 bundles npm 10.9.2 and Node 24 bundles npm 11, which is the only reason the Node version looked like the trigger.

`package-lock.json` used to carry only the `darwin-arm64` optional binaries, leaving every other platform's edge dangling. It no longer does — the lock now records the optional platform packages for every platform (`@esbuild/*`, `lightningcss-*`, `@rolldown/binding-*`, `@img/sharp-*`, `@cloudflare/workerd-*`, `fsevents`), 82 such entries, and all 93 optional-dependency edges in the file resolve. Completing it needed no dependency upgrade, only `npm install --package-lock-only` under npm 11 or newer: `wrangler` stayed at 4.88.0 and no entry's `version`, `resolved` or `integrity` changed. A *full* re-resolve is the thing to avoid, since that is what pulls `wrangler` past 4.88 into an `ERESOLVE` peer conflict between its `@cloudflare/workers-types@^5` requirement and our `^4`. See the "Dependencies and the lockfile" notes in `AGENTS.md` for how to refresh it.

`.nvmrc` pins `22.23.2`, which the build image preinstalls. It is no longer what stands between the repo and the `npm ci` failure — the lock itself is correct now, and `npm ci` passes under both npm majors. The pin stays as reproducibility insurance: pinning Node pins the npm that ships with it, so the build environment cannot drift under us again.

## 11. Gaps and prioritized backlog

Risk-ordered; effort is rough (S = under an hour, M = a session, L = multi-session).

| Priority | Gap | Risk if unaddressed | Effort |
| --- | --- | --- | --- |
| P0 | `npm test` is not wired into any CI workflow — a red suite can merge to `main` silently. | Any regression (including the 16 cataloged in §4) can ship unnoticed; this is the single biggest gap in the whole plan. | S — add a GitHub Actions workflow running `npm test` on `pull_request` and `push: main`, mirroring `schema-drift.yml`'s Node setup. |
| P1 | No browser-driven E2E suite (Playwright or similar) against `wrangler dev`. | Every UI regression (§4 #4, #12, #13, #15) depends entirely on a human running §6 by hand before release; easy to skip under time pressure. | L — stand up Playwright against `npm run dev`, start with the Quickplay smoke (§6) as the first scripted flow. |
| P1 | Disconnect-timeout → DNF write path (§4 #11, R3b) has no automated test. | A future refactor of `removePlayer`/reconnect-grace logic could silently stop writing DNF rows and nothing would fail. | M — a `vitest` test in `server/` driving `runInDurableObject` past the 30s reconnect grace, asserting the written row. |
| P1 | Quick Match bot-backfill disclosure copy (§4 #4) has no automated assertion. | The copy could regress to "undisclosed" again with no test catching it. | S — a `public/src/*.test.js` assertion on the disclosure string being present in the relevant template/module. |
| P2 | `isCreator` badge leak into public lobby (§4 #13) has no isolated regression test. | A future `publicPlayer()`/lobby-render change could reintroduce host-only UI in a public room. | S — extend `server/public-room.test.js` with an explicit assertion that `isCreator` (or equivalent) never appears in a public room's broadcast payload. |
| P2 | No WebSocket message-shape contract test. | A field rename/removal in `hello`/`youAre`/`state` breaks the client with no test signal until manual §6 catches it. | M — a small schema/shape assertion layered onto existing `server/*.test.js` DO tests. |
| P2 | No load/concurrency test for rooms or WS connections beyond `socket-limit.test.js`'s cap-enforcement check. | Unknown behavior under realistic concurrent-room load; the cap being enforced doesn't say what happens near it. | M — synthetic multi-room, multi-socket vitest scenario, or a scripted load probe against `wrangler dev`. |
| P2 | No auth-flow test (better-auth email/password or Google OAuth) beyond incidental route coverage. | An auth regression could ship without any test failing. | M — dedicated `worker/auth.test.js` covering session issuance/expiry paths. |
| P3 | No standing accessibility audit (axe-core/Lighthouse CI) beyond the two widgets called out in §9. | Contrast/keyboard-nav/ARIA regressions elsewhere in the app (lobby, race screen, results) go uncaught. | M — add axe-core as a dev dependency and a scripted check against key screens, gated manual for now via §6-style checklist as an interim step. |
| P3 | No performance budget or automated timing assertion (§7). | Animation jank or WS chattiness regressions are caught only if a human happens to notice during a manual sweep. | M — start with a WS-message-count assertion in a `server/*.test.js` DO test (the number is already known and stated in §6). |

## 12. Running everything headlessly

Single command for the full suite:

```bash
npm test
```

This runs `node --test public/src/*.test.js server/room-stats.test.js migrations/*.test.js scripts/*.test.mjs && vitest run --passWithNoTests` — the exact command is the authoritative `test` script in `package.json`. Currently: 265 tests under `node --test`, 503 under `vitest`, 768 total, all passing.

Individual pieces:

```bash
# node --test layer only
node --test public/src/*.test.js server/room-stats.test.js migrations/*.test.js scripts/*.test.mjs

# vitest layer only (Worker routes + Durable Object logic, real D1 bindings)
npx vitest run

# a single test file, either runner
node --test server/room-stats.test.js
npx vitest run server/room-identity.test.js

# schema-drift check against live prod/preview D1 (needs sqlite3 + wrangler login)
npm run check:schema
npm run check:schema -- --db prod
npm run check:schema -- --db preview
```

Nothing above requires a browser, simulator, or GUI — every command runs in a plain
terminal. The only things this plan documents that are *not* headless are the manual
scenarios in §6 (they need a real browser) and `npx wrangler deploy` (a live-traffic-
affecting action, never run as part of routine test verification).
