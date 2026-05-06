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
  test: {
    // Worker tests only. The `public/src/*.test.js` files use node:test
    // and are run separately via `node --test`.
    include: ["worker/**/*.test.js"],
  },
});
