# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Room identity: two ids, only one of them public

A room player carries two identifiers, and conflating them is a takeover bug:

- `player.racerId` — the client's `localStorage` racerId, sent only in `hello`. It is
  the **reconnect credential**: presenting it is the sole proof that a socket owns an
  existing seat. Server-side only; `publicPlayer()` strips it, alongside `deviceId`/`userId`.
- `player.id` — an ephemeral `p-<n>` id minted per room (`nextBroadcastId`). This is the
  wire identity: `youAre`, every `playerId` field, `disconnectDeadlines` keys, and the
  client's lane keying all use it. Non-UUID on purpose, so `handleHello`'s UUID gate makes
  a broadcast id unusable as a credential.

A seat also records `player.connId`, the socket that most recently claimed it. The
racerId says *which* seat a socket may act on; `connId` says which socket's close is
that seat's departure. Without it, two sockets holding the same racerId (second tab,
auto-reconnect beating the old close) both resolve, and the stale one's `onClose`
schedules an eviction against a live player. `ownsSeat()` gates only the eviction path
— never seat resolution — and demands a real owner *and* a real `connection.id`, so two
unknowns never match. Any new server-only seat field must be added to `publicPlayer()`'s
destructured strip list; it rides `...rest` onto the wire otherwise.

A broadcast id is only unique within one incarnation of `state`: its counter (`nextPid`)
is reset by `freshState()` on idle cleanup, so `p-1` is handed out again to a later
arrival while a long-lived socket may still hold it. Connection state therefore carries
*both* halves, and `playerFor()` — the chokepoint every handler and `onClose` go through —
requires both to match. Never resolve a socket to a seat by broadcast id alone.

Anything a room broadcasts reaches sockets that have not said `hello` yet (`onConnect`
pushes `publicState`), so every new broadcast must go through `publicPlayer()`.
`server/room-identity.test.js` and the hygiene tests in `server/public-room.test.js` fail
if a secret reaches the wire.

## Room lifecycle: private rooms wind down, public ones do not

Every timer a room owns shares one DO alarm slot, coalesced by
`scheduleNextAlarm()` — add a deadline there or it never fires. In a room that
expires when idle it rewrites the alarm only when the new deadline is earlier,
or later by more than `ALARM_SLOP_MS`; the idle clock moves on every client
frame, and paying a durable `setAlarm` for each one is what that skip avoids.
An alarm firing up to a slop window early costs a wake-up, nothing more —
`onAlarm()` re-derives its deadlines and reschedules. Rooms without an idle
clock (public) keep writing every changed deadline exactly, since they only
move one a few times per match. Three timers now run side by side, and they are
deliberately different mechanisms:

- **Reconnect grace** (30s) and **empty-room cleanup** (5 min) — unchanged, and
  the cleanup still re-mints state, which is what resets `nextPid`.
- **Idle winddown** (30 min, private only) — `PRIVATE_ROOM_IDLE_MS`. Driven by
  `state.lastActivityAt`, which `touchActivity()` bumps on connect, close, and
  any *recognized* client message. Alarm ticks are not activity, so a race
  nobody is answering is idle. It ends in `expireRoom()`: state becomes an
  `EXPIRED_ROOM_STATE` tombstone, the alarm is dropped, and everyone attached
  gets `room-expired` and a closed socket.

Two traps this arrangement sets:

- **The alarm time is durable; the timestamp behind it is not.** Bumping
  `lastActivityAt` without persisting means a DO evicted before its alarm wakes
  with a stale clock and winds a live room down early. `flushActivity()` exists
  for the handlers that reply without persisting; keep new ones behind it.
- **`PublicRaceRoom.expiresWhenIdle()` returns false**, and everything winddown
  reads that hook. Quickmatch rooms are single-shot and unlinkable — expiring
  one would strand a player on a screen whose only exit is a room they cannot
  reach. Gate any new lifecycle behavior on the same hook.

For a private room the 5-minute cleanup no longer deletes DO storage — it
re-mints state and persists it, carrying the idle clock forward — so an expired
private room leaves a small storage row behind for good. Nothing wakes the DO
to collect it; it is cleared lazily, by `claimRoomName()` when the name is drawn
again or by the `EXPIRED_ROOM_TTL_MS` check in `onStart()` if someone connects
after 24h. That unbounded-but-tiny growth was accepted deliberately: it is the
price of the expired screen, and a collector alarm would cost more than the row.

The tombstone answers for the room name for `EXPIRED_ROOM_TTL_MS`, because room
ids are three words from a ~13k-combination list and a new room really can draw
an expired one's name. `POST /api/rooms` clears it via the `claimRoomName()` RPC
— which runs *before* `onStart()`, so it reads storage itself rather than
trusting `this.state`. Coverage: `server/room-winddown.test.js` (server) and
`public/src/room-expiry.test.js` (the client contract in `room-expiry.js`).

## Dependencies and the lockfile

The Cloudflare Workers build runs `npm ci`, which hard-fails unless `package-lock.json`
records the optional platform packages for *every* platform (`@esbuild/*`,
`lightningcss-*`, `@rolldown/binding-*`, `@img/sharp-*`, `@cloudflare/workerd-*`,
`fsevents`) — not just the `darwin-arm64` ones a Mac install needs. npm 10.x tolerates a
lockfile missing them; npm 11.x rejects it. `.nvmrc` pins the build's Node (and therefore
its bundled npm), so treat that pin as build configuration, not a local preference.

When changing dependencies:

- Refresh the lockfile with **npm 11 or newer** — run `npx npm@11 install --package-lock-only`,
  which works without leaving `.nvmrc`'s Node 22 (it bundles npm 10, and npm 10 will not add
  the foreign-platform entries back, nor will CI on Node 22 notice they are gone).
- **Never** delete `package-lock.json` to regenerate it from scratch. A clean resolve
  ignores the currently pinned versions and dies on an `ERESOLVE` conflict, because
  `wrangler`'s newest release peer-requires `@cloudflare/workers-types@^5` while
  `package.json` asks for `^4`.
- Sanity check before committing: the lockfile should contain ~82 of those platform
  entries, and `npm ci` should pass on the newest Node you have, not only on `.nvmrc`'s.

## Tests run under two runners

`npm test` runs `node --test` (pure logic in `public/src/`, plus the migration
tests) and then `vitest run` (Worker routes and Durable Objects, against real
bindings via `@cloudflare/vitest-pool-workers`). A test file's directory decides
which runner claims it — see `vitest.config.js` `include`/`exclude` and
`docs/testing.md`; pure-helper files under `server/` (`room-stats.test.js`,
`captcha.test.js`) are claimed by `node --test` via the explicit list in
`package.json` and must stay in vitest's `exclude`. Each Worker test file gets
its own ephemeral D1, built from `migrations/` — see below.

The client race runners are tested under `node:test`'s `mock.timers`
(`public/src/runner.test.js`, `remote-runner.test.js`). One trap: `tick(ms)`
fires only the timers already due when it is called, not a timer a callback
chains after itself, so a countdown or bot schedule has to be walked one tick
at a time. `requestAnimationFrame` does not exist under Node; the remote-runner
test installs a queue-and-flush shim on `globalThis` for the bot ticker.

`getConnections()` is an **iterator**, not an array — partyserver walks the
hibernating sockets lazily — so array methods on it throw at runtime. Room test
stubs must return one (`connectionIterator()` in `server/room-captcha.test.js`);
a stub that hands back the array itself makes `.find`/`.filter` look fine in CI
and break in production.

Room tests answer with zero typing delay, which finishes races in single-digit
milliseconds — under the captcha trigger (below) whenever the race is the
standard ten problems. Suites that assert on persisted rows from a ten-problem
race backdate `state.raceStartedAt` after the countdown to a human pace
(`server/room-captcha.test.js` shows the pattern).

## Active verification: the superhuman-pace captcha

The captain's chosen anti-cheat direction is active verification, not tighter
passive bounds: the flat 200 ms floor stays, and a server-timed finish faster
than `CAPTCHA_TRIGGER_MS_PER_PROBLEM` (500 ms/problem; evidence in the constant's
comment in `worker/plausibility.js`) makes the room hold that racer's row and
offer 3 fresh arithmetic problems via a targeted `captcha` message, with
`CAPTCHA_PROBLEM_COUNT × CAPTCHA_MS_PER_PROBLEM` (12 s) to answer all three.
Only the standard ten-problem race is ever challenged — `needsCaptchaTrigger`
gates on `CANONICAL_RACE_LENGTH`, because that rate is what the evidence covers
and what a leaderboard ranks; a five-problem private room is fast for honest
reasons and has no board to reach. Pass → the row inserts normally; wrong answer
or deadline → `insertRaceResult` is called with a plausibility override storing
`suspect=1`/`captcha_*`, which excludes the row from leaderboards and
recent-finishes through the existing `suspect = 0` predicates. Never a ban.

**A challenge belongs to the racer who earned it, not to the race.** That is the
whole shape of the lifecycle, and every part of it follows:

- It is issued in `handleAnswer` the moment that racer's `finishMs` is stamped,
  so the budget runs from *their* finish. Issuing at race end would aim the
  clock at whoever waited longest for the stragglers — which is always the fast
  racer the feature exists to check.
- Only their own answers or their own deadline settle it. `handleRematch`,
  `removePlayer` and a room reset all leave it alone; `resetForRace` explicitly
  does not clear `captchaChallenges`. A host must not be able to fail a guest's
  verification by clicking Race Again.
- It is self-contained: the challenge carries the `difficulty` it was drawn at,
  the `raceStartedAt` of the race it holds a row for, and the row payload
  itself, so nothing the room does later can change what it grades or stores.
  `persistRaceResults` skips a player only when the pending challenge's
  `raceStartedAt` matches the race being persisted — a leftover challenge holds
  an earlier row and must not suppress a newer one.
- Client-side it is a room-lifetime overlay (`captcha-ui.js` over
  `captcha-session.js`), attached in `enterRoom` and mounted on `document.body`,
  never inside the race screen. `handleHello` re-offers a pending challenge on
  every reconnect, and that is only useful if the listener survives a full page
  reload onto the room lobby.

Other invariants that are easy to break:

- Answers never leave the DO: the challenge stores a seed; problems regenerate
  from it for grading (`server/captcha.js`). The `captcha` wire message carries
  `problem` strings only — unlike `race-start`, which ships the full sequence.
- `state.captchaChallenges` is server-only: `publicState()` strips it like the
  player fields.
- A challenge is keyed to its seat (resolved through `playerFor`) and
  single-use (`resolveCaptchaChallenge` deletes it).
- Bots never verify: `issueCaptchaChallenge` skips them, which matters because
  quickmatch bot timelines can sit inside the trigger zone.
- The `captcha` message carries `remainingMs`, not the absolute deadline: the
  client's clock is not the DO's, and a re-offer has to show what is left of the
  original budget rather than restarting it.
- The plausibility override is a named third argument to `insertRaceResult`, not
  a payload field. `payload` is built from a request body on the solo path, so
  an override read off it would be one `{...body}` away from letting a client
  clear its own suspect flag.

## `public/` has no build step

Static assets are served byte-for-byte by wrangler's ASSETS binding, so there is
nowhere to substitute a build-time constant into client code. The Worker *is*
bundled by esbuild, so build-time values are read there and sent to the client
(or stamped server-side) rather than injected into the page — `worker/version.js`
is the worked example. Deploy identity comes from the `version_metadata` binding
rather than `package.json`, whose version is hand-bumped and stale.

## `wrangler.jsonc` bindings never reach `env.preview`

Wrangler splits config into keys a named env inherits from the top level
(`compatibility_date`, `compatibility_flags`, `main` — which is why they are
declared once) and keys it does not. Every binding is in the second group:
`d1_databases`, `kv_namespaces`, `durable_objects`, `ratelimits`,
`version_metadata`, `vars` and friends must be repeated inside `env.preview` or
preview silently deploys without them. Adding a binding is therefore always a
two-place edit.

## Database schema

Two D1 databases must stay in lockstep: `arithmetic-racer` (prod) and
`arithmetic-racer-preview` (every PR preview build). Read `migrations/README.md`
before touching anything schema-shaped — it has the apply procedure and the
renumbering history.

Two sharp edges it documents, worth knowing before you read it:

- **Never run `wrangler d1 migrations apply`.** Migrations go on with
  `npm run migrate:prod` / `migrate:preview` (`wrangler d1 execute --file`).
  The `d1_migrations` ledger in prod is a fossil listing only `0001`/`0002`;
  preview's is empty. `apply` would replay non-idempotent DDL over
  databases already at head.
- **`npm run check:schema` is the authority on what is applied**, not the
  ledger. It replays `migrations/` into scratch SQLite and diffs against both
  live databases. Run it after any migration.

Changing a `CHECK` constraint or dropping a column requires a full table rebuild
in SQLite, which silently discards the table's indexes and foreign keys unless
they are recreated; `migrations/migrations.test.js` exists to catch exactly that.
A migration that *rewrites data* carries the other kind of risk, and gets its own
test file — `migrations/points-backfill.test.js` is the pattern. A wrong one-shot
backfill can only be undone by another migration.

Worker tests build their D1 from `migrations/` via `applyD1Migrations`
(`worker/test-setup.js`, wired in `vitest.config.js`), so filename order is
executable — a migration must sort after whatever it depends on. Do not
reintroduce hand-written DDL in test files; that drift is what this replaced.
The one legitimate exception is a deliberately *older* shape: `admin.test.js`
and `contact.test.js` rebuild `contact_messages` as `0006` left it, to exercise
the missing-column fallback a migration-lagging deploy hits.

## The admin dashboard is the real delivery path for contact messages

`/admin/?token=…` is where contact messages and bug reports are actually read.
The notification email in `worker/routes/contact.js` has never fired in
production — neither `LOOPS_TEMPLATE_CONTACT` nor `CONTACT_EMAIL` is configured
on the Worker — so treat that path as decoration and the D1 row plus the
dashboard as the delivery guarantee.

## Scoring is siloed per difficulty

`race_results.points` and the PPM derived from it are per-difficulty pools that are never
weighted, summed, or ranked against each other — easy/medium/hard are three separate
games. Anything aggregating them must `GROUP BY difficulty`. Rationale and formula:
`worker/race-score.js` and `migrations/0009_race_results_points.sql`.

## Public views of `race_results` share two rules

`race_results` holds two populations that look identical in the table and are not
interchangeable. A row with `room_id IS NOT NULL` was *counted by the server*: the Durable
Object validated each answer against its own problem sequence and stamped `finishMs` from
its own clock. A row with `room_id IS NULL` is *self-reported* — `POST /api/race-result`
stores what the browser sent, bounded only by `worker/plausibility.js`.

So any endpoint that shows race results to somebody other than their owner — a feed, a
board, anything new of that shape — has to settle both of these, and the answers are
already written down:

- **Eligibility.** `room_id IS NOT NULL AND suspect = 0 AND finished = 1 AND
  finish_time_ms > 0`. Only server-counted rows belong in a public claim. Anything
  *comparative* (the leaderboards; anything ranking racers against each other later) must
  additionally join `"user".username` rather than listing anonymous rows — `device_id` is a
  private identifier that never goes on the wire. Private, self-directed views (the profile
  screen, admin) deliberately do not filter at all: your own history should include your own
  solo races. The reasoning in full, including where an *activity* feed legitimately diverges
  from a *ranking* (anonymous racers), is the header comment of
  `worker/routes/recent-finishes.js`; `worker/routes/leaderboard.js` carries the ranking side
  of the argument, and `public/src/leaderboard-period.js` owns the UTC calendar windows every
  board uses — it sits under `public/` because the lobby needs it too and only that import
  direction resolves (see its header).
- **Reading `points` can 500 the page.** The column arrives in migration 0009, migrations
  are applied by hand while the Worker deploys from a push, so a live build can be one
  migration ahead of the database. Wrap the read and fall back to selecting `NULL` via
  `isMissingColumnError` (`worker/db.js`); PPM is derivable from older columns, so only
  points need the fallback. `worker/routes/recent-finishes.js` is the worked example, and
  its test drops the column to prove the fallback.

Provenance is not the only axis. A rate is only comparable against races of the
same length, and length is caller-chosen: Quick Match is fixed at ten problems but
a private-room host may set anything in [5, 50] (`server/room.js`), which
`room-stats.js` writes to `problems_total`. Five problems in 2.5s is 120 PPM
without anyone going faster, so a public ranking must also filter
`problems_total = 10` — the standard race, which is `freshState().raceLength` in
`server/room.js`. That is the constant to keep in step: it is what every
board-eligible row's `problems_total` is copied from, and a leaderboard test
asserts the two are equal so a drift empties every board loudly rather than
silently. (`RACE_LENGTH` in `public/src/runner.js` is the *solo* race — same
number, but those rows never reach a board.) Same reasoning as the difficulty
silo, different column.

Both of those columns — and the `finished` flag under them — are stamped by
`buildRaceResultPayload` from `state.lastRace`, the snapshot `finishRace()` pins
of the race that just ran, never from live `difficulty`/`raceLength`. `finished`
is a configurable state and a D1 insert is a subrequest rather than a storage
operation, so the input gate stays open across the per-player insert loop and a
host's `set-config` or `rematch` lands in the middle of it. Every payload is
therefore built before the first insert. Anything new that writes a race row
belongs on the same side of that line; `server/room-config.test.js` drives both
interleavings.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
