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
