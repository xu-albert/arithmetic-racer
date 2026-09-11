# Phase 6: Private Rooms — Implementation Plan

**For another agent to implement.** Self-contained.

> **Superseded on identity (2026-08-13).** The whole plan below predates the split of the
> two `playerId` senses: client → server it is the racerId **reconnect secret**, while
> every server → client `playerId`/`player.id`/`youAre` is an ephemeral per-room broadcast
> id. Frame shapes and everything else here still hold, but wherever the plan makes
> `player.id` the client's `localStorage` racerId, or treats "a known `playerId`" as a
> reconnect (the identity/reconnection decision rows, the `Player` shape, Task 9), read
> "a matching racerId" — that proof is what stops a stranger who read an id off the wire
> from claiming the seat. See "Room identity" in `AGENTS.md`.

> **Superseded on room lifetime (2026-08-18).** Every statement below about how a room
> dies — the "Room lifetime" decision row, Task 4's idle-cleanup step, and the manual
> test rows that expect a wiped room — predates the idle winddown. A private room now
> also expires after 30 minutes with no client touching it, and the 5-minute empty-room
> cleanup no longer deletes its storage. See "Room lifecycle" in `AGENTS.md`.

> **Superseded on the race deadline (2026-09-11).** The 5-second finish rule below — the
> "Race finish" decision row, Task 4's `graceDeadline = Date.now() + GRACE_PERIOD_MS` step
> and the verify bullet reading it back — is not what a room runs. `main` shipped with no
> race deadline at all for a while; the one it has now is scaled to the race length rather
> than copied from the solo runner's `GRACE_PERIOD_MS`, and a second bound ends the race
> nobody finishes at all. See "Room lifecycle" in `AGENTS.md`.

---

## Onboarding (read first, in order)

1. **Architecture decision:** [docs/hosting-comparison.md](./hosting-comparison.md). Cloudflare Durable Objects via PartyServer is settled — do not relitigate.
2. **Existing solo runner (this is what you're mirroring on the server):** `public/src/runner.js`. Read it end to end. The event names, the racer shape, the grace-period logic — these are the contract.
3. **Existing pure modules (server can reuse these as-is):**
   - `public/src/game.js` — exports `generateSequence(difficulty, length, seed)`, `validateAnswer(problem, raw)`, `makeRng(seed)`, `DIFFICULTIES`. Pure ES module, no DOM, no globals beyond `Math.random` fallback. Already designed to "port straight to the server."
   - `public/src/handles.js` — exports `generateHandle(rng, taken)` returning strings like `BraveOtter`. Pure ES module.
4. **Existing UI binding:** `public/src/ui.js`. The function `attachRaceUI({ runner, raceLength, screens })` consumes a runner via `runner.on(handler)` and listens for events `countdown`, `start`, `advance`, `wrong`, `drop`, `finish`. The `RemoteRunner` you build must emit the same event names with the same payload shapes.
5. **Existing entry point:** `public/main.js` (note: at `public/main.js`, NOT `public/src/main.js`). It currently wires Quickplay only.
6. **Layout:** `public/index.html`. The "Create Private Room" button (`#create-room-btn`) already exists in the markup but is currently unwired.
7. **Test command:** `npm test` (runs `node --test public/src/*.test.js`). After every task, this must still pass. Add tests if you change pure modules.
8. **Local dev:** `npm run dev` currently runs `npx serve public -l 3000` (static only). After Task 2, this changes to `wrangler dev` which serves both static assets and the Worker on the same port.

**Tooling already installed:** none for the server. You'll add `partyserver` and `partysocket` in Task 2.

**Constants to reuse, not redefine:** `RACE_LENGTH`, `COUNTDOWN_SECONDS`, `GRACE_PERIOD_MS` from `runner.js` lines 16–21. Lift these into a small `public/src/constants.js` if both client and server need them, otherwise duplicate the value with a comment pointing back.

---

## Goal

Add private multiplayer rooms. A player creates a room, gets a shareable URL, friends join via that URL, the creator configures race parameters and starts the race once 2+ players are present. The race runs on the server, broadcasting events to all connected clients.

**Out of scope for this phase** (parking lot at the end): auth, persistent leaderboard, lobby chat, audio, mobile responsive, public/matchmade multiplayer.

---

## Design decisions (baked in)

These were debated; do NOT relitigate. Code against these.

| Decision | Choice | Rationale |
|---|---|---|
| Identity model | Random handle (`BraveOtter` style, from existing `handles.js`) assigned server-side on first connect; editable inline in lobby; persistent via `localStorage.racerId` (UUID v4) so reloads keep the same identity | Zero-friction join, optional personalization, reuse existing module |
| Room ID format | Three-word slug, kebab-case, drawn from existing `handles.js` wordlists, e.g. `brave-otter-eel` | URL-friendly, memorable, no new wordlist to maintain |
| Race parameters | Creator sets difficulty + length between races — in `lobby` and in `finished`; defaults `medium` / 10 | Per requirement. **Amended post-launch:** this row originally said "in lobby before Start", and both the DO and the lobby UI implemented exactly that. A room therefore froze its difficulty after its first race, since `finished` is where the host sits until they press Race Again — the host's only escape was to abandon the room. The allowed phases now live in `public/src/room-config-rules.js`, imported by both halves so they cannot drift again. |
| Minimum players to start | 2. Server rejects `start-race` if `players.length < 2` | Per requirement |
| Bot fallback | None in private rooms. Bots stay in Quickplay only. If creator clicks Start with only themselves, the server rejects. (Solo flow remains Quickplay.) | Private rooms are humans-only |
| Reconnection | If a WebSocket connects with a `playerId` already in the room, replace the prior connection (refresh allowed). After 30s without reconnection, the player is removed | Graceful refresh handling |
| Rematch | After results, creator sees "Race Again" → resets per-race fields, regenerates `problemSequence`, state goes back to `lobby` | Common pattern |
| Room lifetime | Room dies when last player disconnects + 5 min idle (alarm-driven cleanup). Hard ceiling: 24h since creation | Free up DO resources |
| Race finish | Mirror existing 5s grace logic from `runner.js`, enforced server-side via DO alarm. After first player finishes, server schedules alarm at `Date.now() + GRACE_PERIOD_MS`. On alarm, mark unfinished non-dropped players as `dnf`, set state `finished`, broadcast `finish` with rankings | Consistency with solo |

---

## Architecture overview

```
                           ┌─────────────────────────────────────┐
                           │   Cloudflare Worker (one)            │
                           │                                       │
   Browser ── HTTPS ───────┤  GET /*               ────► assets   │
                           │                                       │
                           │  POST /api/rooms      ────► generates │
                           │                            roomId,    │
                           │                            instantiates│
                           │                            DO         │
                           │                                       │
                           │  /parties/race-room/:id              │
                           │     ◄──── WebSocket ────►   RaceRoom  │
                           │                              (DO,     │
                           │                              one per  │
                           │                              room)    │
                           └─────────────────────────────────────┘
```

**One Worker entry point** that:
1. Handles `POST /api/rooms` → generates a unique slug, instantiates the DO with that name, returns `{ roomId }`
2. Routes `/parties/race-room/:id` to the matching DO via `routePartykitRequest` from `partyserver`
3. Falls through everything else to the `ASSETS` binding (static frontend served from `public/`)

**One Durable Object class** (`RaceRoom`) per room. Holds room state in memory + persisted via `ctx.storage`. Uses WebSocket Hibernation so idle rooms don't burn compute. Uses DO `alarm()` for grace period and idle-cleanup timers (these survive hibernation; `setTimeout` does not).

---

## Data model

### Room state (held inside the DO)

```ts
type Player = {
  id: string;              // UUID v4 from client localStorage; stable across reloads
  handle: string;          // display name
  isCreator: boolean;
  joinedAt: number;        // ms epoch
  // resets each race:
  score: number;
  finishMs: number | null; // ms since raceStartedAt
  dropped: boolean;
  dnf: boolean;
};

type RoomState = {
  id: string;              // slug like "brave-otter-eel"
  createdAt: number;
  difficulty: 'easy' | 'medium' | 'hard';
  raceLength: number;      // default 10
  lastRace: { difficulty, raceLength } | null; // what the race that just finished
                                 // actually was, pinned in finishRace. The results
                                 // scoreboard reads its denominator from here, and so
                                 // does every persisted race_results row, because the
                                 // host may change both while those results are still
                                 // on screen and still being written.
  state: 'lobby' | 'countdown' | 'racing' | 'finished';
  players: Player[];
  problemSequence: { problem: string; answer: number }[]; // populated on race start
  raceStartedAt: number | null;  // ms epoch when 'GO' fires
  graceDeadline: number | null;  // ms epoch when grace alarm fires
};
```

Persist `RoomState` via `ctx.storage.put('state', state)` after every mutation. On `onStart`, restore from storage.

### Client identity (browser)

`localStorage`:
- `racerId`: UUID v4, generated once on first visit, never changes.
- `handle`: optional. If absent, server assigns one on first `hello` and we cache the assigned value here.

---

## WebSocket protocol

JSON messages, one event per frame. The two `playerId` senses have since been split —
see the superseded-on-identity note at the top of this file.

### Client → Server

```ts
{ type: 'hello', playerId: string, handle: string | null }   // sent immediately on open
{ type: 'set-handle', handle: string }
{ type: 'set-config', difficulty: 'easy'|'medium'|'hard', raceLength: number }   // creator only
{ type: 'start-race' }   // creator only; server validates >= 2 players
{ type: 'answer', value: string }
{ type: 'quit' }
{ type: 'rematch' }   // creator only; only valid in 'finished' state
```

### Server → Client

```ts
// Snapshot — sent on connect AND after every state-mutating handler returns
{ type: 'state', state: RoomState, youAre: string /* playerId */ }

// Handshake confirmation
{ type: 'hello-ack', playerId: string, handle: string }

// Granular events (optimization; clients can ignore in favor of next 'state')
{ type: 'player-joined', player: Player }
{ type: 'player-left', playerId: string }
{ type: 'config-changed', difficulty, raceLength }
{ type: 'handle-changed', playerId, handle }

// Race lifecycle (these mirror runner.js event names)
{ type: 'countdown', n: number }                                   // n = 3, 2, 1, 0=GO
{ type: 'race-start', sequence: Problem[], raceStartedAt: number } // mapped to ui.js 'start'
{ type: 'advance', playerId: string, score: number, finishMs: number | null }
{ type: 'wrong', playerId: string }
{ type: 'drop', playerId: string }
{ type: 'finish', rankings: Player[] }

// Errors
{ type: 'error', code: 'NOT_CREATOR'|'NEED_MORE_PLAYERS'|'BAD_STATE'|'INVALID_INPUT'|'RATE_LIMIT', message: string }
```

**Broadcasting rule:** Every state-mutating handler must (a) emit the granular event for fast client reaction, then (b) emit a fresh `state` snapshot. Clients that miss a granular event recover from the next snapshot.

**Note on event-name mapping:** the server emits `race-start`. The client `RemoteRunner` translates that to the `start` event the existing `ui.js` listens for. Don't change `ui.js`'s expected event names.

---

## File layout

```
arithmetic-racer/
├── public/                          (frontend)
│   ├── index.html                   MODIFY: add #lobby-room section + invite modal markup
│   ├── style-a.css                  MODIFY: add lobby-room + modal styles
│   ├── main.js                      MODIFY: route on ?room=<id>; wire #create-room-btn
│   └── src/
│       ├── ui.js                    NO CHANGE (verify event names line up)
│       ├── runner.js                NO CHANGE (kept for Quickplay)
│       ├── game.js                  NO CHANGE (server imports it directly)
│       ├── handles.js               NO CHANGE (server imports it directly)
│       ├── bot.js                   NO CHANGE (Quickplay-only)
│       ├── remote-runner.js         NEW: WebSocket-driven runner with same interface as runner.js
│       ├── lobby.js                 NEW: pre-race lobby UI (player list, config, start, invite modal)
│       ├── identity.js              NEW: localStorage UUID + cached-handle helpers
│       └── room-client.js           NEW: thin partysocket wrapper; handshake + reconnect
├── server/                          (NEW, backend)
│   ├── server.js                    NEW: Worker entry; HTTP routing + DO export
│   ├── room.js                      NEW: RaceRoom Durable Object class
│   └── room-id.js                   NEW: room slug generator (3 words from handles.js wordlists)
├── wrangler.jsonc                   MODIFY: add main, durable_objects binding, migrations
├── package.json                     MODIFY: add deps; update dev script to `wrangler dev`
└── docs/
    ├── hosting-comparison.md
    └── phase-6-private-rooms-plan.md  (this doc)
```

**Important reuse paths:** the server imports `../public/src/game.js` and `../public/src/handles.js` directly. Both are already pure ES modules with no browser dependencies. Cloudflare Workers can import plain `.js` ES modules; no build step required for these.

---

## Implementation tasks (in order)

Each task is independently verifiable. Do them in sequence; do not skip ahead. Run `npm test` after each task.

### Task 1: Verify pure modules, prepare shared constants

**Files:** `public/src/game.js`, `public/src/handles.js`, `public/src/runner.js` (read only); maybe `public/src/constants.js` (new)

`game.js` and `handles.js` are already pure ES modules. Verify they have no implicit browser dependencies:
- Open each file. Confirm no `window`, `document`, or `localStorage` references.
- Confirm `npm test` still passes — these modules already have test coverage.

If you want both client and server to share `RACE_LENGTH`, `COUNTDOWN_SECONDS`, `GRACE_PERIOD_MS`, lift them into `public/src/constants.js` and re-export from `runner.js`. Otherwise duplicate with a comment pointing back. Either is fine.

**Verify:** `npm test` passes. No code changes required if you skip the constants extraction.

### Task 2: Server scaffolding

**Files:** `server/server.js` (new), `server/room.js` (new), `server/room-id.js` (new), `wrangler.jsonc` (modify), `package.json` (modify)

Install deps:
```
npm install partyserver partysocket
```

Update `package.json` scripts:
```jsonc
"scripts": {
  "dev": "wrangler dev",
  "deploy": "wrangler deploy",
  "test": "node --test public/src/*.test.js"
}
```

Update `wrangler.jsonc`:
```jsonc
{
  "name": "arithmetic-racer",
  "compatibility_date": "2026-05-06",
  "main": "server/server.js",
  "assets": { "directory": "./public", "binding": "ASSETS" },
  "durable_objects": {
    "bindings": [{ "name": "RaceRoom", "class_name": "RaceRoom" }]
  },
  "migrations": [
    { "tag": "v1", "new_sqlite_classes": ["RaceRoom"] }
  ]
}
```

Create `server/room-id.js`:
```js
import { ADJECTIVES, ANIMALS } from '../public/src/handles.js';
// If handles.js doesn't export these wordlists, add named exports for them as part of this task.

export function generateRoomId(rng = Math.random) {
  const adj = ADJECTIVES[Math.floor(rng() * ADJECTIVES.length)].toLowerCase();
  const a1  = ANIMALS[Math.floor(rng() * ANIMALS.length)].toLowerCase();
  const a2  = ANIMALS[Math.floor(rng() * ANIMALS.length)].toLowerCase();
  return `${adj}-${a1}-${a2}`;
}
```
> If `ADJECTIVES`/`ANIMALS` are currently module-private in `handles.js`, expose them as named exports — that change is part of this task.

Create `server/server.js`:
```js
import { routePartykitRequest } from 'partyserver';
import { generateRoomId } from './room-id.js';
export { RaceRoom } from './room.js';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/api/rooms') {
      const roomId = generateRoomId();
      // The DO is materialized lazily on first WebSocket connect; we just return the slug.
      return Response.json({ roomId });
    }

    const partyResponse = await routePartykitRequest(request, env);
    if (partyResponse) return partyResponse;

    return env.ASSETS.fetch(request);
  },
};
```

Create `server/room.js` with a stub:
```js
import { Server } from 'partyserver';

export class RaceRoom extends Server {
  static options = { hibernate: true };

  async onStart() { /* TODO Task 3 */ }
  async onConnect(connection, ctx) { /* TODO Task 3 */ }
  async onMessage(connection, raw) { /* TODO Task 3 */ }
  async onClose(connection) { /* TODO Task 3 */ }
  async alarm() { /* TODO Task 4 */ }
}
```

**Verify:**
- `npx wrangler dev` starts cleanly.
- `curl -X POST http://localhost:8787/api/rooms` returns `{ "roomId": "<slug>" }`.
- Visiting `http://localhost:8787/` still serves the existing static frontend.

### Task 3: Room state, identity, and lobby protocol

**File:** `server/room.js`

Implement enough of the protocol that two browsers (with the lobby UI from Task 5) can join, edit handles, edit config, and trigger errors.

Required handlers and behaviors:

- `onStart()`: load `RoomState` from `ctx.storage.get('state')`. If absent, init with `id` from `this.name` (the DO's instance name = room slug), `state = 'lobby'`, `difficulty = 'medium'`, `raceLength = 10`, empty `players`, etc.
- `onConnect(connection)`: do not add player yet; client must send `hello` first. Track an in-memory `Map<connectionId, playerId>` so you can look up players from connections.
- `onMessage(connection, raw)`: parse JSON; ignore non-objects; dispatch on `type`:
  - `hello`: validate `playerId` matches UUID v4 regex. If a player with this `id` already exists, treat as reconnect: update the connection mapping, do NOT touch their score/finishMs. Otherwise add a new `Player` to `players[]`. If `players.length === 1` after add, set `isCreator = true`. If client sent `handle === null`, generate one with `generateHandle(Math.random, new Set(players.map(p=>p.handle)))`. Send `hello-ack` to this connection. Broadcast `player-joined` + `state`.
  - `set-handle`: validate non-empty after trim, length ≤ 24, no control chars. If valid, update player handle. Broadcast `handle-changed` + `state`. On invalid: send `error` only to this connection.
  - `set-config`: require `isCreator` AND a configurable phase — `lobby` or `finished`, per `isConfigurableState` in `public/src/room-config-rules.js`. (`countdown` and `racing` are rejected: the problem sequence is already generated by then.) Validate difficulty ∈ DIFFICULTIES, raceLength ∈ [5, 50] integer. Update. Broadcast `config-changed` + `state`. On unauthorized: send `error` (`NOT_CREATOR` or `BAD_STATE`).
  - `start-race`: require `isCreator` AND `state === 'lobby'` AND `players.length >= 2`. On fail, send `error` (`NEED_MORE_PLAYERS` or `NOT_CREATOR`). On success: generate `problemSequence` via `generateSequence(difficulty, raceLength, Date.now() & 0xffffffff)`. Set `state = 'countdown'`. Broadcast `state`. Then run countdown (Task 4).
  - `answer`: only during `racing`. Look up player by connection. If `player.score >= raceLength` or `player.dropped`, ignore. Compare to `problemSequence[player.score]` via `validateAnswer`. If correct: increment score, set `finishMs` if score reached length, broadcast `advance`, schedule grace alarm if this is the first finisher (see Task 4). If wrong: broadcast `wrong` (everyone sees it).
  - `quit`: mark player as `dropped = true`. Broadcast `drop` + `state`. If `racing`, check if all remaining players are done/dropped — if so, finish race immediately (skip grace).
  - `rematch`: require `isCreator` AND `state === 'finished'`. Reset every player's `score`, `finishMs`, `dropped`, `dnf`. Clear `problemSequence`. Set `state = 'lobby'`. Broadcast `state`.
- `onClose(connection)`: look up player by connection. Remove from `players[]`. If the player was creator and others remain, promote the next-joined player to creator (`isCreator = true`). Broadcast `player-left` + `state`. If `players.length === 0`, schedule cleanup alarm at `Date.now() + 5*60*1000`. (Implementation note: Task 4 introduces alarms; for now, just mark the deadline in state and add a TODO.)

After every state-mutating handler, persist with `await this.ctx.storage.put('state', this.state)` and broadcast a fresh `state` event to all connections.

Use `this.broadcast(JSON.stringify(msg))` and `connection.send(JSON.stringify(msg))`. PartyServer's `Server` base class provides both.

**Verify:**
- `wrangler dev` running.
- Use `wscat` or browser DevTools to open two WebSockets to `ws://localhost:8787/parties/race-room/test-room-1`.
- Each sends `{"type":"hello","playerId":"<uuid>","handle":null}`; both receive `hello-ack` with assigned handles, plus a `state` snapshot.
- Solo creator sends `start-race` → expect `error` with `NEED_MORE_PLAYERS`.
- Two players → creator sends `start-race` → state transitions to `countdown` (countdown broadcast wiring lands in Task 4).

### Task 4: Countdown + grace timer + race lifecycle

**File:** `server/room.js`

Implement the race lifecycle on top of Task 3's state machine.

- After `start-race` succeeds and state becomes `countdown`, run a 3-second countdown via DO alarms (alarms survive hibernation; `setTimeout` does not):
  - Store `countdownN` in state (initially 3).
  - Set alarm at `Date.now() + 1000`.
  - In `alarm()`, if there's a pending countdown: broadcast `{ type: 'countdown', n: countdownN }`, decrement, schedule next alarm. When `n` would go below 0, broadcast `{ type: 'countdown', n: 0 }` (the "GO"), then set state to `racing`, set `raceStartedAt = Date.now()`, broadcast `race-start` with the sequence.
- During `racing`, the `answer` handler in Task 3 already handles per-answer logic. When the first player's score reaches `raceLength`:
  - Set their `finishMs = Date.now() - raceStartedAt`.
  - Set `graceDeadline = Date.now() + GRACE_PERIOD_MS` (5000).
  - Schedule alarm at `graceDeadline`.
- In `alarm()`, if `graceDeadline` is set and `Date.now() >= graceDeadline`, OR all non-dropped players have finished:
  - Mark all players where `!dropped && finishMs == null` as `dnf = true`.
  - Set state to `finished`.
  - Compute rankings (see below).
  - Broadcast `finish` + `state`.
- Rankings sort (port from `runner.js` lines 129–141):
  - Tier 1: finished (sort by `finishMs` ascending)
  - Tier 2: still-racing (sort by `score` descending) — should be empty after grace
  - Tier 3: dropped or dnf
- Idle cleanup alarm: if `players.length === 0`, schedule alarm at `Date.now() + 5*60*1000`. If on alarm fire `players.length` is still 0, delete state from storage and don't reschedule.

**Coordinating multiple alarm types:** there's only one alarm slot per DO. Track upcoming deadlines in state (`countdownAt`, `graceDeadline`, `idleCleanupAt`) and on every alarm fire, check whichever applies given current state. After processing, set the next alarm to the earliest still-pending deadline.

**Verify:**
- Two browsers (using lobby UI from Task 5) reach `start-race`. Both see countdown 3 → 2 → 1 → 0/GO. Then `race-start` arrives with the sequence.
- Players answer; advance events broadcast correctly.
- First player to reach `raceLength` triggers a 5s window; if the second finishes within it, both rank by `finishMs`. If not, second is `dnf`.
- After both finish, leave the page, wait 5 minutes, reload — the room is gone (visiting old URL via direct WebSocket connect will create a fresh empty state).

### Task 5: Frontend lobby UI + room client + identity

**Files:** `public/index.html`, `public/style-a.css`, `public/src/lobby.js` (new), `public/src/identity.js` (new), `public/src/room-client.js` (new)

`public/index.html`: add a new section after the existing `#lobby` section:
```html
<section id="lobby-room" class="screen hidden">
  <h2 id="room-title"></h2>
  <button id="invite-btn" class="link-button">Invite people</button>

  <div class="room-config">
    <div class="difficulty-picker">
      <button class="diff-btn" data-difficulty="easy">Easy</button>
      <button class="diff-btn" data-difficulty="medium">Medium</button>
      <button class="diff-btn" data-difficulty="hard">Hard</button>
    </div>
    <label>Race length
      <input id="race-length-input" type="number" min="5" max="50" value="10" />
    </label>
  </div>

  <h3>Who's here</h3>
  <ul id="room-players"></ul>

  <div class="room-actions">
    <button id="start-race-btn" disabled>Start Race</button>
    <button id="rematch-btn" class="hidden">Race Again</button>
    <button id="leave-room-btn" class="link-button">Leave</button>
  </div>

  <p id="lobby-hint" class="lobby-hint"></p>
</section>

<div id="invite-modal" class="modal hidden" role="dialog" aria-modal="true">
  <div class="modal-card">
    <h3>Invite people to this race</h3>
    <p>Share this URL:</p>
    <input id="invite-url" type="text" readonly />
    <div class="modal-actions">
      <button id="invite-copy-btn">Copy</button>
      <button id="invite-close-btn">Done</button>
    </div>
  </div>
</div>
```

`public/style-a.css`: add styles for `#lobby-room`, `#room-players`, `.modal`, `.modal-card`, `.lobby-hint`. Match existing card-and-shadow aesthetic. Disabled buttons use the same gray as existing disabled state.

`public/src/identity.js`:
```js
const KEY_ID = 'racerId';
const KEY_HANDLE = 'racerHandle';

export function getOrCreateRacerId() {
  let id = localStorage.getItem(KEY_ID);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(KEY_ID, id);
  }
  return id;
}
export function getStoredHandle() { return localStorage.getItem(KEY_HANDLE); }
export function setStoredHandle(h) { localStorage.setItem(KEY_HANDLE, h); }
```

`public/src/room-client.js`: thin wrapper around `partysocket`:
```js
import PartySocket from 'partysocket';
import { getOrCreateRacerId, getStoredHandle, setStoredHandle } from './identity.js';

export function createRoomClient(roomId) {
  const ws = new PartySocket({
    host: location.host,
    party: 'race-room',
    room: roomId,
  });
  const listeners = new Set();

  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({
      type: 'hello',
      playerId: getOrCreateRacerId(),
      handle: getStoredHandle(),
    }));
  });
  ws.addEventListener('message', (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.type === 'hello-ack') setStoredHandle(msg.handle);
    for (const l of listeners) l(msg);
  });

  return {
    on(handler) { listeners.add(handler); return () => listeners.delete(handler); },
    send(msg) { ws.send(JSON.stringify(msg)); },
    close() { ws.close(); },
  };
}
```

`public/src/lobby.js`:
- Export `attachLobby({ roomId, screens, onRaceStart })`.
- Open a `room-client`. Render `#lobby-room` from `state` events: room title (uses roomId for now), player list with handles + (you) + (host) markers, config inputs (disabled if not creator), Start button (disabled unless creator AND ≥2 players AND state is `lobby`), Rematch button (visible only in `finished`).
- Wire button handlers: difficulty buttons → `set-config`, race-length input change → `set-config`, Start → `start-race`, Rematch → `rematch`, Leave → `quit` then navigate to `/`.
- Wire handle editing: clicking the current player's handle row turns it into an input; on blur or Enter, send `set-handle`.
- On `race-start` event: call `onRaceStart(initialRunnerData)` so `main.js` can switch to the race screen.
- Auto-open invite modal on first lobby render if `youAre === creator.id` AND no race has happened yet (use a one-shot flag).

**Verify:**
- Open `http://localhost:8787/?room=any-slug` in two browsers.
- Both see the lobby UI with each other in the player list.
- Creator can change difficulty / length; other player's UI reflects changes.
- Non-creator's config controls are disabled.
- Start is enabled only for creator with ≥ 2 players.
- Click Start → countdown shows in browser console (next task wires the visual handoff).

### Task 6: RemoteRunner

**File:** `public/src/remote-runner.js`

Mirror the interface of `runner.js` exactly so `attachRaceUI` works without changes. Reference signatures:

```js
export function createRemoteRunner({ roomClient, initialState, raceLength, youAre }) {
  // racers: array shaped like runner.js (id, handle, score, finishMs, dropped, dnf)
  //   - 'you' is the player whose id === youAre; ui.js looks up by id === 'player'.
  //     SIMPLEST APPROACH: alias the local player's id to 'player' and keep others by their UUID.
  //     OR: lift the 'player' id assumption out of ui.js into a constructor option. Pick whichever
  //     ports cleaner. The local-player-id-mapping in ui.js is the only constraint to respect.
  // sequence: initialState.problemSequence
  // raceLength: passed through

  // Returns object with the runner.js shape:
  //   racers, sequence, raceLength, getRankings, on(handler), start(), submitAnswer(input),
  //   currentProblemFor(racerId), getState(), quit(), stop()
}
```

Behavior:
- Subscribe to `roomClient` messages on construction. Translate server events to UI events:
  - `state`: refresh internal `racers` array from `state.players`.
  - `countdown` → emit `('countdown', { n })`.
  - `race-start` → emit `('start', { problem: sequence[0] })` to match runner.js shape.
  - `advance` → update racer state, emit `('advance', { racerId, score, finishMs })`. If the racer is the local player, also emit `('problem', { problem: nextProblem })` to match runner.js's per-answer signal.
  - `wrong` → emit `('wrong', { racerId })`.
  - `drop` → emit `('drop', { racerId })`.
  - `finish` → update racer state, emit `('finish', { rankings })`.
- `start()`: NO-OP. The server drives countdown.
- `submitAnswer(raw)`: send `{ type: 'answer', value: raw }`. Do not optimistically validate locally — wait for server `advance` or `wrong`. Return `{ correct: true }` always (UI doesn't need the return value; it reacts to events).
- `quit()`: send `{ type: 'quit' }`.
- `stop()`: unsubscribe from roomClient. Do NOT close the socket — the lobby may still need it for rematch.
- `getRankings()`: same sort logic as runner.js (port lines 129–141).

**Verify:**
- Two browsers. Click Start. Both see countdown → race begins.
- Each typing correct answers makes both browsers' cars advance for that player.
- Wrong answer shakes only the typing player's input (server sends `wrong` to all but ui.js scopes the shake to the local input).
- First player finishes; finish banner shows; 5s later the results screen appears with correct rankings.

### Task 7: Wire create-room button + URL routing

**File:** `public/main.js`

At the top of `main.js`, before any DOM wiring:

```js
const params = new URLSearchParams(location.search);
const roomId = params.get('room');

if (roomId) {
  // Hide the Quickplay lobby; attach the private-room lobby instead.
  // Import lobby.js dynamically or statically — your call.
  attachLobby({ roomId, screens, onRaceStart: handleRaceStart });
  showScreen('lobby-room');
} else {
  // Existing Quickplay wiring stays as-is.
}
```

Wire the "Create Private Room" button:
```js
const createRoomBtn = document.getElementById('create-room-btn');
createRoomBtn.addEventListener('click', async () => {
  createRoomBtn.disabled = true;
  try {
    const res = await fetch('/api/rooms', { method: 'POST' });
    const { roomId } = await res.json();
    history.replaceState(null, '', `/?room=${roomId}`);
    attachLobby({ roomId, screens, onRaceStart: handleRaceStart });
    showScreen('lobby-room');
  } finally {
    createRoomBtn.disabled = false;
  }
});
```

`handleRaceStart(initialState)`:
- Create a `RemoteRunner` from the current `roomClient` and `initialState`.
- Call `attachRaceUI({ runner, raceLength, screens })`.
- Show the `race` screen.

**Verify:**
- Fresh browser on `/`: click "Create Private Room" → URL becomes `/?room=<slug>` → lobby-room screen visible → invite modal pops up automatically.
- Paste URL in second browser: lobby-room screen visible; both players in list.

### Task 8: Invite modal polish

**Files:** `public/src/lobby.js`, `public/style-a.css`

- Modal opens automatically once on creator's first arrival (gate with a one-shot flag in lobby.js, not localStorage — fresh sessions in the same room should re-open it).
- Manual reopen via `#invite-btn`.
- Modal contents: read-only input pre-filled with `${location.origin}/?room=${roomId}`. Copy button uses `navigator.clipboard.writeText`. Show "Copied!" affordance for 1.5s. Close on Done, on background click, on Escape key.

**Verify:**
- Creator lands → modal opens → click Copy → "Copied!" briefly → click Done → modal closes.
- Click "Invite people" link → modal reopens.
- Press Escape → modal closes.
- Pasted URL in second browser joins the room.

### Task 9: Reconnection handling

**Files:** `public/src/room-client.js`, `server/room.js`

`partysocket` reconnects on transient disconnects. Confirm:
- On reconnect, the client re-sends `hello` with the same `playerId`.
- Server's `hello` handler treats a known `playerId` as a reconnect — replaces the connection mapping without resetting `score`/`finishMs`/`dropped`.
- On clean `onClose`, give a 30s grace before removing the player. Implementation: when `onClose` fires, schedule the removal via state-tracked deadline + alarm. If a `hello` from the same `playerId` arrives before the deadline, cancel the removal.

**Verify:**
- During a race, hard-refresh one tab. After reconnect, the player's score, handle, and (if applicable) finish state are preserved. Server does not have a duplicate entry in `players[]`.
- Close one tab, wait 35 seconds, reopen URL. Treated as a new player.

### Task 10: Edge cases + polish

- "Waiting for at least 2 players to start..." hint when only 1 player.
- "(host)" badge next to creator handle. Different style for "(you)".
- Creator leaves mid-lobby → next-joined player gets `isCreator = true`; UI updates.
- Validate handle on both client and server (length, no control chars, trim).
- Show inline error toast for any `error` event from server.
- Race screen `quit` button: in private rooms, sends `quit` over socket, navigates back to `/?room=<id>` lobby.
- Don't break the solo Quickplay flow — verify the homepage with no `?room` param still works.
- Don't actively break mobile (no fixed widths added that overflow at 375px); responsive pass is a separate phase.

**Verify (manual playtest):**
- Solo creator tries to Start → button disabled, server rejects if forced → no crash.
- Creator-leaves-mid-lobby → host transfers to player 2.
- Refresh-mid-race → rejoins with state intact.
- Race-with-3-players → all three see each other's progress.
- Rematch → state resets → fresh sequence on next Start.
- Solo Quickplay homepage still works exactly as before.

---

## Test plan

### Automated

- `npm test` (existing tests for `game.js`, `bot.js`, `handles.js`) must pass after every task.
- If you add a `constants.js` extraction in Task 1, write a tiny test asserting the values match the documented defaults.
- Server-side unit tests are not required for this phase; the protocol is best validated via end-to-end manual tests below.

### Manual end-to-end matrix

Run all of these against `npm run dev` (which after Task 2 runs `wrangler dev`).

| # | Scenario | Expected |
|---|---|---|
| 1 | Click "Create Private Room" | URL gains `?room=<slug>`; lobby-room screen visible; invite modal pops automatically |
| 2 | Copy URL into second browser | Second player joins the lobby; first browser sees them |
| 3 | Second player edits their handle inline | Both browsers show the new name |
| 4 | Creator changes difficulty in lobby | Both browsers reflect it |
| 4b | Creator changes difficulty **after** a race, before Race Again | Controls are live on the post-race screen; both browsers reflect it, non-host sees a toast; the next race uses the new setting |
| 5 | Creator clicks Start with self only | Button disabled; even if forced via DevTools, server replies `NEED_MORE_PLAYERS` error |
| 6 | Creator clicks Start with 2 players | Both see countdown 3-2-1-GO, then race screen |
| 7 | Both type correct answers | Each car advances on the other browser as the answering player progresses |
| 8 | One wrong answer | Only that browser's input shakes |
| 9 | One player quits mid-race | Their lane shows the dropped style; other player's race continues |
| 10 | First player finishes | Finish banner shows; 5s later results screen appears with correct rankings |
| 11 | Race ends, creator clicks "Race Again" | Lobby returns; same players; new sequence on next Start |
| 12 | Hard-refresh one browser mid-race | Player rejoins with score intact, race continues |
| 13 | Solo Quickplay from homepage (no `?room`) | Identical to before — no regression |
| 14 | Last player leaves, wait 5 min, revisit URL | Treated as a brand-new empty room |

---

## Acceptance criteria

- All 14 manual scenarios pass.
- `npm test` passes.
- Solo Quickplay flow is unaffected.
- No console errors in either browser during a happy-path race.
- The site remains deployable to Cloudflare via `npm run deploy` (smoke-deploy to a preview subdomain to confirm).

---

## Out of scope (parking lot)

NOT part of Phase 6:

- Auth / accounts. Players are anonymous.
- Persistent leaderboard (Phase 8 — D1 schema lands then).
- Lobby chat.
- Audio / sound effects.
- Mobile-first responsive pass.
- Spectator mode (joining mid-race as observer).
- Custom problem categories or operations.
- Lobby player-list animations.
- Public matchmaking / Quickplay-over-network. Quickplay stays solo-vs-bots.
- Elo / ranking system.

---

## References

- [Hosting comparison](./hosting-comparison.md) — why Cloudflare DO + PartyServer
- [PartyServer README](https://github.com/cloudflare/partykit/blob/main/packages/partyserver/README.md)
- [Cloudflare Durable Objects WebSocket Hibernation](https://developers.cloudflare.com/durable-objects/best-practices/websockets/)
- [Cloudflare Durable Objects alarms](https://developers.cloudflare.com/durable-objects/api/alarms/)
- Existing project state: `public/src/runner.js` (mirror its interface), `public/src/ui.js` (do not change event names), `public/src/game.js` and `public/src/handles.js` (server imports these directly), `public/main.js` (entry point — add room routing), `public/index.html` (add lobby-room markup)
