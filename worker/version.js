// The running app version, for bug reports.
//
// There is no build step for `public/` — wrangler's ASSETS binding serves those
// files byte-for-byte — so there is no existing place where a build-time value
// gets substituted into client code, and nothing to hook into. The Worker, by
// contrast, *is* bundled (esbuild, via wrangler), so importing package.json
// here collapses to a string literal in the output with no new tooling; the
// same import resolves under vitest, which is why it can be asserted on.
//
// Reading it server-side also means a bug report cannot claim a version it
// isn't running. Assets and Worker ship in a single deploy, so this is the
// version of the page the reporter had open, not just of the API.
import pkg from "../package.json";

export const APP_VERSION = pkg.version;
