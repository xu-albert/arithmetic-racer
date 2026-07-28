# Migrations

Raw SQL migrations, applied in filename order (`0001_`, `0002_`, …).

## Two databases, kept in lockstep

| Env | D1 database | Used by |
| --- | --- | --- |
| production | `arithmetic-racer` | top-level Worker (`wrangler deploy`) |
| preview | `arithmetic-racer-preview` | PR preview builds (`wrangler deploy --env preview`) |

The preview deploy that Cloudflare Workers Builds runs on every PR
(`wrangler deploy --env preview`) targets `arithmetic-racer-preview`. Its schema
**must** match production, or preview builds break or behave differently than prod.

## Adding a migration

1. Add the new numbered file, e.g. `0009_add_thing.sql`.
2. Apply it to **both** databases:

   ```sh
   npm run migrate:prod    -- --file=migrations/0009_add_thing.sql
   npm run migrate:preview -- --file=migrations/0009_add_thing.sql
   ```

Always run both. Skipping the preview one is the schema-drift trap this setup exists to prevent.

> These migrations have no tracking table, so they are **not** idempotent — only
> apply a file that hasn't been applied to that database yet.

A file that rebuilds a table (create new, copy, drop, rename) is not applied as
one transaction, so an apply that dies partway through can leave the old table
dropped and the copy still under its temporary name. Record a restore point
first — `npx wrangler d1 time-travel info arithmetic-racer` (and the same for
`arithmetic-racer-preview`) — and keep the bookmark until the apply has finished.

## Ordering against the Worker deploy

Applying a migration is a manual step; the Worker deploys itself from a
Cloudflare build on every push. The two are not one atomic change, so apply the
file to **both** databases *before* — or at the same time as — merging the code
that depends on it. Land the code first and the new Worker goes live against the
old schema, where every statement naming the new column fails, including ones on
paths the change never touched.

Code that reads a newly added column should survive its absence anyway, rather
than rest on that ordering. `0008_contact_bug_reports.sql` is the worked
example: `worker/routes/contact.js` and `worker/routes/admin.js` fall back to
the pre-`context` shape when SQLite says there is no such column, so a Worker
that arrives first still stores general and deletion messages — the only channel
for a deletion request — and still lists them in the admin dashboard.

## Testing a migration

`migrations.test.js` (run by `npm test`) applies every file in this directory,
in filename order, to an in-memory SQLite database and asserts on the resulting
schema. Add cases there for anything a migration is supposed to guarantee.

It runs under `node --test` with better-sqlite3 rather than under
vitest-pool-workers, because D1's `exec()` runs one statement per line and so
cannot execute a multi-line `CREATE TABLE` — the real `.sql` files have to be
fed to something that parses multi-statement SQL.

This matters most for a change SQLite cannot make in place. Widening a `CHECK`
constraint or dropping a column means rebuilding the table (create new, copy,
drop, rename), and a rebuild silently takes the old table's indexes and foreign
keys with it unless they are recreated — see
`0008_contact_bug_reports.sql` for the pattern and the tests that pin it.

The Worker test suite applies this directory to its ephemeral D1 via
`applyD1Migrations` (see `worker/test-setup.js`), so **filename order is now
executable**, not just documentation. A migration that depends on an earlier one
must sort after it — `0005_quickmatch_room_index.sql` indexes the `room_id`
column that `0003_race_results_room_id.sql` adds.

## Renumbered 2026-07-28

Two files were both numbered `0003`, leaving their relative order defined only by
the alphabetical tiebreak on the rest of the filename. Harmless while the schema
was assembled by hand in tests; ambiguous once the directory drives the test
schema. The sequence is now gapless, and every file after the duplicate shifted
up one:

| Was | Now |
| --- | --- |
| `0003_race_results_played_idx.sql` | `0004_race_results_played_idx.sql` |
| `0004_quickmatch_room_index.sql` | `0005_quickmatch_room_index.sql` |
| `0005_contact_messages.sql` | `0006_contact_messages.sql` |
| `0006_race_results_suspect.sql` | `0007_race_results_suspect.sql` |
| `0007_contact_bug_reports.sql` | `0008_contact_bug_reports.sql` |

**Both databases were already at head when this happened**, so no file needs
re-applying — but note that a number now means a different file than it did in
older session logs and PR descriptions. Since there is no tracking table, the
only record of what has been applied is this note plus the deploy history.
