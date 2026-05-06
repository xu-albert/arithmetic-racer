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
    // Worker tests only. The `public/src/*.test.js` files use node:test
    // and are run separately via `node --test`.
    include: ["worker/**/*.test.js"],
  },
});
