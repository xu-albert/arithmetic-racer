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

1. Add the new numbered file, e.g. `0003_add_thing.sql`.
2. Apply it to **both** databases:

   ```sh
   npm run migrate:prod    -- --file=migrations/0003_add_thing.sql
   npm run migrate:preview -- --file=migrations/0003_add_thing.sql
   ```

Always run both. Skipping the preview one is the schema-drift trap this setup exists to prevent.

> These migrations have no tracking table, so they are **not** idempotent — only
> apply a file that hasn't been applied to that database yet.

## Ordering against the Worker deploy

Applying a migration is a manual step; the Worker deploys itself from a
Cloudflare build on every push. The two are not one atomic change, so apply the
file to **both** databases *before* — or at the same time as — merging the code
that depends on it. Land the code first and the new Worker goes live against the
old schema, where every statement naming the new column fails, including ones on
paths the change never touched.

Code that reads a newly added column should survive its absence anyway, rather
than rest on that ordering. `0007_contact_bug_reports.sql` is the worked
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
`0007_contact_bug_reports.sql` for the pattern and the tests that pin it.
