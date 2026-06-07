# Testing Guide

Manual + automated regression checks for Arithmetic Racer. Use this when verifying that core flows still work after a change.

## Automated

```bash
npm test
```

Runs `node --test public/src/*.test.js` — covers `game.js` (problem generation, validation), `bot.js` (tier delays), `handles.js` (handle generator). All 26 should pass. Server logic is covered by manual probes (below), not unit tests.

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
| 5 | Creator (A) changes difficulty | Both browsers' difficulty buttons reflect the new pressed state. |
| 6 | Creator clicks **Start Race** with only themselves in the room | Button is disabled; server rejects with `NEED_MORE_PLAYERS` if forced via DevTools. |
| 7 | Creator clicks **Start Race** with B present | Both see countdown 3 → 2 → 1 → GO, then the race screen. |
| 8 | Both type correct answers | Each car advances on both browsers (own car moves on Enter; opponent moves on next server tick). |
| 9 | Type a wrong answer | Only the typing browser's input shakes; other browser unaffected. |
| 10 | Click **Quit race** mid-race | Quitter is sent back to lobby-room; lane shows dropped (desaturated); race continues for the other player. |
| 11 | First player crosses the finish line | Finish banner shows; race **does not** end until the slower player also finishes. |
| 12 | Slower player completes their last problem | Both see the results screen with rankings sorted by `finishMs`. |
| 13 | Creator clicks **Race Again** (results / lobby-room) | Both return to lobby in state `lobby`; new problem sequence generated on next Start. |
| 14 | Hard-refresh one tab mid-race | Player rejoins automatically with the same `playerId`; score, finishMs, dropped state all preserved. |
| 15 | Close last tab, wait 5 minutes, revisit the URL | Treated as a brand-new empty room (state was wiped by the idle-cleanup alarm). |
| 16 | Visit `/` with no `?room=` param | Quickplay lobby appears — no regression from multiplayer changes. |

## Things to watch for during regression sweeps

- **Animation jank.** Cars should glide; the problem queue should slide. If you see stutter, suspect: a new CSS transition on a layout-triggering property (`left`, `width`, `font-size`), or a new high-frequency state broadcast on the server.
- **Optimistic update divergence.** Local car moves before the server confirms. If your car gets *ahead* of the server's view (e.g. local says 5, server says 3), the server's later state will yank you back. Should not happen in practice — both validate against the same `problemSequence`. If it does, look at any change in `submitAnswer` or `validateAnswer`.
- **(Guest) badge dropping off.** Should appear on: lobby rows (as a badge), race lanes (inline), podium (inline). Quickplay's local player too. Bots no.
- **Solo Quickplay regression.** `?room=` routing in `main.js` is gated; the no-param path should still hit the bot race exactly as before.

## Deploy

```bash
# from this worktree, production (live URL — affects users)
npx wrangler deploy --env=""
```

This deploys to the `arithmetic-racer` Worker, live at `https://arithmetic-racer.albertwxu.workers.dev`. There is currently no isolated preview environment (Cloudflare's Workers Builds CI overrides the `--env preview` name). If branch-isolated previews are needed, set up a second Workers Build connected to the same repo, scoped to a separate Worker (e.g. `arithmetic-racer-preview`) — see notes in `wrangler.jsonc`.

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
npx wrangler d1 execute arithmetic-racer --local --command="SELECT id, user_id, device_id, finished, finish_time_ms, room_id, played_at FROM race_results ORDER BY played_at DESC LIMIT 10"
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
