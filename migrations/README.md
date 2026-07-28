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

1. Add the new numbered file, e.g. `0008_add_thing.sql`.
2. Apply it to **both** databases:

   ```sh
   npm run migrate:prod    -- --file=migrations/0008_add_thing.sql
   npm run migrate:preview -- --file=migrations/0008_add_thing.sql
   ```

3. Confirm both databases match this directory:

   ```sh
   npm run check:schema
   ```

Always run both applies. Skipping the preview one is the schema-drift trap this
setup exists to prevent — and on 2026-07-28 it turned out **neither** database
had received three of them. `npm run check:schema` replays `migrations/` into a
scratch SQLite database and diffs the result against live prod and preview, so a
migration that was written but never applied fails loudly instead of waiting to
be discovered by a broken INSERT.

> These migrations have no tracking table, so they are **not** idempotent — only
> apply a file that hasn't been applied to that database yet.

The Worker test suite applies this directory to its ephemeral D1 via
`applyD1Migrations` (see `worker/test-setup.js`), so **filename order is now
executable**, not just documentation. A migration that depends on an earlier one
must sort after it — `0005_quickmatch_room_index.sql` indexes the `room_id`
column that `0003_race_results_room_id.sql` adds.

## Renumbered 2026-07-28

Two files were both numbered `0003`, leaving their relative order defined only by
the alphabetical tiebreak on the rest of the filename. Harmless while the schema
was assembled by hand in tests; ambiguous once the directory drives the test
schema. The sequence is now gapless, and the trailing four files shifted up one:

| Was | Now |
| --- | --- |
| `0003_race_results_played_idx.sql` | `0004_race_results_played_idx.sql` |
| `0004_quickmatch_room_index.sql` | `0005_quickmatch_room_index.sql` |
| `0005_contact_messages.sql` | `0006_contact_messages.sql` |
| `0006_race_results_suspect.sql` | `0007_race_results_suspect.sql` |

**Both databases were already at head when this happened**, so no file needs
re-applying — but note that a number now means a different file than it did in
older session logs and PR descriptions. Since there is no tracking table, the
only record of what has been applied is this note plus the deploy history.
