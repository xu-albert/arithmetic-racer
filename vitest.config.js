import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        compatibilityFlags: ["nodejs_compat"],
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
    // Worker / DO tests use vitest-pool-workers (real bindings via
    // `cloudflare:test`). Pure-logic test files using `node:test` are run
    // separately via `node --test` — see the test script in package.json.
    // server/room-stats.test.js is pure helper math and lives on node:test.
    include: ["worker/**/*.test.js", "server/**/*.test.js"],
    exclude: [
      "**/node_modules/**",
      "server/room-stats.test.js",
    ],
  },
});
