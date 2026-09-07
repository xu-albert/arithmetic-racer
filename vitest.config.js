import { defineConfig } from "vitest/config";
import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-pool-workers";

// Read once here in Node, then hand the parsed migrations to every test worker
// as a binding — `worker/test-setup.js` applies them. Reading from inside the
// worker isn't an option; there's no filesystem there.
const migrations = await readD1Migrations("./migrations");

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        compatibilityFlags: ["nodejs_compat"],
        bindings: { TEST_MIGRATIONS: migrations },
      },
    }),
  ],
  // Mirror of wrangler.jsonc's alias. wrangler's alias config doesn't
  // propagate to vitest-pool-workers' Vite resolution, so we set it here too.
  // See worker/username-validator.js for why obscenity needs aliasing.
  resolve: {
    alias: {
      obscenity: "./node_modules/obscenity/dist/index.js",
    },
  },
  test: {
    // Every test file gets its own ephemeral D1, so the schema is applied per
    // file rather than once globally.
    setupFiles: ["./worker/test-setup.js"],
    // Worker / DO tests use vitest-pool-workers (real bindings via
    // `cloudflare:test`). Pure-logic test files using `node:test` are run
    // separately via `node --test` — see the test script in package.json.
    // server/room-stats.test.js is pure helper math and lives on node:test.
    include: ["worker/**/*.test.js", "server/**/*.test.js"],
    exclude: [
      "**/node_modules/**",
      "server/room-stats.test.js",
      // Pure helpers run under node:test (see the test script in package.json);
      // vitest would load them with the wrong runner.
      "server/captcha.test.js",
    ],
  },
});
