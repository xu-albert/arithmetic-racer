// Applies migrations/ to each test file's D1 before its tests run.
//
// vitest-pool-workers hands every test file its own ephemeral in-memory D1, so
// each one previously bootstrapped the schema by hand in `beforeAll`. That left
// seven copies of DDL to keep in sync with the migrations directory, and they
// had already drifted — race-result-store.test.js declared `user_id TEXT` while
// me.test.js had the real `user_id TEXT REFERENCES "user"(id)` foreign key.
//
// Worse, the copies were mirrors of migrations that had never been applied to
// production: the suite happily tested a race_results shape with a `room_id`
// column that prod did not have. Driving the schema from migrations/ means a
// test database can only ever be a schema that actually exists as a migration.
// It does not prove the migration reached a real database — that is what
// `npm run check:schema` is for.
//
// TEST_MIGRATIONS is injected by vitest.config.js via readD1Migrations().
import { applyD1Migrations, env } from "cloudflare:test";

await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
