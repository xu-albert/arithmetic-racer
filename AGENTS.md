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
`docs/testing.md`. Worker tests recreate the schema they need inline, because
each file gets its own ephemeral D1.

## `public/` has no build step

Static assets are served byte-for-byte by wrangler's ASSETS binding, so there is
nowhere to substitute a build-time constant into client code. The Worker *is*
bundled by esbuild, so build-time values are read there and sent to the client
(or stamped server-side) rather than injected into the page — `worker/version.js`
is the worked example.

## Migrations

`migrations/README.md` is authoritative: no tracking table (so nothing is
idempotent), and every file must be applied to **both** the production and
preview D1 databases or preview drifts. Changing a `CHECK` constraint or
dropping a column requires a full table rebuild in SQLite, which silently
discards the table's indexes and foreign keys unless they are recreated;
`migrations/migrations.test.js` exists to catch exactly that.

## The admin dashboard is the real delivery path for contact messages

`/admin/?token=…` is where contact messages and bug reports are actually read.
The notification email in `worker/routes/contact.js` has never fired in
production — neither `LOOPS_TEMPLATE_CONTACT` nor `CONTACT_EMAIL` is configured
on the Worker — so treat that path as decoration and the D1 row plus the
dashboard as the delivery guarantee.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
