// Minimal stub used only by `@better-auth/cli generate` to scaffold the schema.
// Replaced by the real config in worker/auth.js (Agent D's work).
import { betterAuth } from "better-auth";
import Database from "better-sqlite3";

export const auth = betterAuth({
  database: new Database(":memory:"),
  emailAndPassword: { enabled: true },
  socialProviders: {
    google: { clientId: "stub", clientSecret: "stub" },
  },
  user: {
    additionalFields: {
      username: { type: "string", required: false, unique: true },
    },
  },
});
