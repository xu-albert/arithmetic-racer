# Testing Guide

Manual + automated regression checks for Arithmetic Racer. Use this when verifying that core flows still work after a change.

## Automated

```bash
npm test
```

Runs the pure-logic suites under `node --test` and the Worker / Durable Object / route suites under `vitest` — the `test` script in `package.json` is the authoritative list of what runs.

Worker tests get an ephemeral D1 whose schema is applied from `migrations/` (`worker/test-setup.js`), so a schema change belongs in a migration file, never inline in a test. The migration files themselves are applied to an in-memory SQLite database and asserted on by `migrations/*.test.js` under `node --test` — `migrations.test.js` for the schema they leave behind, `points-backfill.test.js` for the data a backfill rewrites — see [`migrations/README.md`](../migrations/README.md).

The browser flows and WebSocket probes below are not automated; run them by hand.

## Local dev

```bash
npm run dev   # wrangler dev — serves Worker + static assets on :8787
```

For browser tests open `http://localhost:8787` in two different browsers (or one regular window + one incognito) so each has its own `localStorage` and therefore its own `racerId`. Same-browser tabs share storage and look like the same player to the server.

## Quickplay smoke (no server-side state)

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

## Multiplayer two-browser smoke

| # | Step | Expected |
|---|---|---|
| 1 | Browser A clicks **Create Private Room** | URL becomes `/?room=<slug>`; lobby-room screen; invite modal pops automatically. |
| 2 | Copy URL → paste into Browser B | B joins the lobby; A sees B in the player list. |
| 3 | Each row in lobby player list | Shows `<handle>`, `(you)`, `(host)`, `(Guest)` badges as appropriate. |
| 4 | Non-creator (B) clicks their own handle inline | Edits to a new handle; both browsers reflect the new name. |
| 5 | Creator (A) changes difficulty in the lobby | Both browsers' difficulty buttons reflect the new pressed state. |
| 5b | Creator (A) changes difficulty **after a race**, on the post-race lobby-room screen | Controls are enabled (not greyed out); B sees a "Host set the race to …" toast; the next **Race Again** → **Start Race** uses the new difficulty. Regression guard for the frozen-difficulty bug. |
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

## Things to watch for during regression sweeps

- **Animation jank.** Cars should glide; the problem queue should slide. If you see stutter, suspect: a new CSS transition on a layout-triggering property (`left`, `width`, `font-size`), or a new high-frequency state broadcast on the server.
- **Optimistic update divergence.** Local car moves before the server confirms. If your car gets *ahead* of the server's view (e.g. local says 5, server says 3), the server's later state will yank you back. Should not happen in practice — both validate against the same `problemSequence`. If it does, look at any change in `submitAnswer` or `validateAnswer`.
- **(Guest) badge dropping off.** Should appear on: lobby rows (as a badge), race lanes (inline), podium (inline). Quickplay's local player too. Quickplay's local bots have no badge; Quick Match's server-side bots do carry it — the badge only encodes "no account", and bots have none. Bot backfill is disclosed in the Quick Match copy, so it is not a leak.
- **Solo Quickplay regression.** `?room=` routing in `main.js` is gated; the no-param path should still hit the bot race exactly as before.

## Deploy

```bash
# from this worktree, production (live URL — affects users)
npx wrangler deploy --env=""
```

This deploys to the `arithmetic-racer` Worker, live at `https://arithmetic-racer.albertwxu.workers.dev`. A separate preview Worker and D1 database (`arithmetic-racer-preview`) is configured under `env.preview` in `wrangler.jsonc`; its schema has to stay in lockstep with production — see [`migrations/README.md`](../migrations/README.md).

### Why `.nvmrc` pins Node 22

Workers Builds runs `npm clean-install` before the deploy command, and on 2026-07-30 Cloudflare moved its default Node from 22 to 24.18.0. What rejects an incomplete lockfile is the npm major version, not Node itself: npm 10.9.2 tolerates optional-dependency edges that have no lock entry, while npm 11 treats them as out of sync and refuses with `Missing: … from lock file`. Node 22 bundles npm 10.9.2 and Node 24 bundles npm 11, which is the only reason the Node version looked like the trigger.

`package-lock.json` used to carry only the `darwin-arm64` optional binaries, leaving every other platform's edge dangling. It no longer does — the lock now records the optional platform packages for every platform (`@esbuild/*`, `lightningcss-*`, `@rolldown/binding-*`, `@img/sharp-*`, `@cloudflare/workerd-*`, `fsevents`), 82 such entries, and all 93 optional-dependency edges in the file resolve. Completing it needed no dependency upgrade, only `npm install --package-lock-only` under npm 11 or newer: `wrangler` stayed at 4.88.0 and no entry's `version`, `resolved` or `integrity` changed. A *full* re-resolve is the thing to avoid, since that is what pulls `wrangler` past 4.88 into an `ERESOLVE` peer conflict between its `@cloudflare/workers-types@^5` requirement and our `^4`. See the "Dependencies and the lockfile" notes in `AGENTS.md` for how to refresh it.

`.nvmrc` pins `22.23.2`, which the build image preinstalls. It is no longer what stands between the repo and the `npm ci` failure — the lock itself is correct now, and `npm ci` passes under both npm majors. The pin stays as reproducibility insurance: pinning Node pins the npm that ships with it, so the build environment cannot drift under us again.

## WebSocket protocol probes (server-side regression)

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

## Room races → race_results persistence

These verify that each room race writes one row per player to `race_results`. Run against `npx wrangler dev`. Inspect with:

```bash
npx wrangler d1 execute arithmetic-racer --local --command="SELECT id, user_id, device_id, finished, finish_time_ms, points, room_id, played_at FROM race_results ORDER BY played_at DESC LIMIT 10"
```

| # | Scenario | Expected |
|---|---|---|
| R1 | Two anon browsers, both finish a 10-problem race | Two rows; both `user_id NULL`, `room_id = <slug>`, `finished = 1`, distinct `device_id`s |
| R2 | Two logged-in browsers (different accounts), both finish | Two rows; both `user_id` set to the respective account ids, `room_id = <slug>` |
| R3a | Two players racing; one clicks **Quit race** mid-race | Two rows; quitter has `finished = 0`, `finish_time_ms = NULL` |
| R3b | Two players racing; one closes their tab and waits past the 30s reconnect grace | Two rows; the disconnected player has `finished = 0`, `finish_time_ms = NULL` (covers the `removePlayer` path, distinct from R3a's `handleQuit` path) |
| R4 | One logged-in + one anon, both finish | Two rows; logged-in player's row has `user_id` set, anon has `user_id NULL` |
| R5 | After R2, the logged-in player visits Profile | Their Recent Races list includes the just-finished room race |
| R6 | Solo Quickplay race (regression check) | One row written via the route; `room_id = NULL`; existing solo stats behavior unchanged |
| R7 | Any finished race (solo or room) | Row has non-NULL `points`; a quit race has `points NULL` |
| R8 | After R7, the logged-in player visits Profile | Headline shows a PPM figure for that difficulty only — the other two tiers are unchanged — and the race's row shows its own PPM and Points |

## Lobby "who's racing" strip

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
