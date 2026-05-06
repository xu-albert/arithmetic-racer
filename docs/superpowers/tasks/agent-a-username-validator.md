# Agent A — Username Validator

**Spec:** `docs/superpowers/specs/2026-05-06-users-auth-stats-design.md`
**Plan:** `docs/superpowers/plans/2026-05-06-users-auth-stats-implementation.md`
**API contracts:** `worker/api-contracts.js` (frozen — do not edit)

---

## Mission

Implement a pure-function username validator that runs identically on the server and the client. The server is authoritative; the client copy exists only to give inline feedback (`✓ Available` / `✗ Not allowed`) without a network round trip.

## Files you own

- `worker/username-validator.js` — server module (full validation including DB uniqueness wiring point).
- `worker/username-validator.test.js` — server tests.
- `public/src/username-validator-client.js` — client mirror (no DB lookup; does pure-function checks only).
- `public/src/username-validator-client.test.js` — client tests (run via `node --test`).

## Files you must NOT touch

Anything not listed above. In particular: `worker/index.js`, `worker/routes/*`, `public/index.html`, any file owned by another agent.

## Contract

The server module exports:

```js
/**
 * @typedef {{ valid: true } | { valid: false, reason: 'banned'|'reserved'|'invalid_format' }} ValidationResult
 */

/**
 * Run all pure-function checks. Does NOT check DB uniqueness — caller does that separately.
 * @param {string} username
 * @returns {ValidationResult}
 */
export function validateUsernameSync(username) { ... }
```

The client module exports the same `validateUsernameSync` with identical behavior (so the client preview matches what the server will say).

**Format rules:**
- Length: 3-20 characters inclusive.
- Allowed chars: ASCII letters, digits, underscore. Must start with a letter.
- Regex: `^[A-Za-z][A-Za-z0-9_]{2,19}$`.
- Returns `{ valid: false, reason: 'invalid_format' }` on length or character violations.

**Reserved words (case-insensitive):**
`admin, administrator, moderator, mod, system, root, support, help, api, www, null, undefined, anonymous, guest, bot`

Returns `{ valid: false, reason: 'reserved' }` if the lowercased username matches.

**Profanity (using `obscenity`):**
- Server: import `RegExpMatcher`, `englishDataset`, `englishRecommendedTransformers` from `obscenity`. Match against the input. If any match found, return `{ valid: false, reason: 'banned' }`.
- Client: import the same. The `obscenity` package works in browsers; bundle size is fine (~50KB).

## Implementation sketch

```js
// worker/username-validator.js
import { RegExpMatcher, englishDataset, englishRecommendedTransformers } from "obscenity";

const RESERVED = new Set([
  "admin","administrator","moderator","mod","system","root",
  "support","help","api","www","null","undefined","anonymous",
  "guest","bot",
]);

const FORMAT_RE = /^[A-Za-z][A-Za-z0-9_]{2,19}$/;

const matcher = new RegExpMatcher({
  ...englishDataset.build(),
  ...englishRecommendedTransformers,
});

export function validateUsernameSync(username) {
  if (typeof username !== "string" || !FORMAT_RE.test(username)) {
    return { valid: false, reason: "invalid_format" };
  }
  if (RESERVED.has(username.toLowerCase())) {
    return { valid: false, reason: "reserved" };
  }
  if (matcher.hasMatch(username)) {
    return { valid: false, reason: "banned" };
  }
  return { valid: true };
}
```

The client file is identical — copy it. (Yes, duplicated. The cost of keeping them in sync is one `cp` away, and the cost of a build step to share them is much higher in this stack. Add a comment in both files: `// MIRROR OF public/src/username-validator-client.js — keep in sync.`)

## Testing

Both test files cover identical cases. Tests run with `node --test` for the client (existing test setup in `package.json`) and with `vitest run` for the server.

**Required test cases (each):**

1. `valid: true` — `BraveOtter`, `xu_27`, `albert`, `User_123`.
2. `invalid_format` — empty string, `ab` (too short), 21-char string, `1abc` (starts with digit), `has space`, `has-dash`, `é` (non-ASCII).
3. `reserved` — `admin`, `ADMIN`, `Admin`, `moderator`, `bot`.
4. `banned` — at least one obvious slur from `obscenity`'s dataset, plus one obfuscated form (e.g., letter substitution). Use a mild test case like a profanity well-known to be in the default dataset (do **not** hard-code an actual slur — use one of the dataset's tester strings or a clearly-flagged neutral example like an obfuscated mild word; check `obscenity`'s docs for safe test strings).

**Anti-flake guidance:** the test for `banned` depends on the specific dataset. Pin `obscenity` version exactly in `package.json`. If a string doesn't match across versions, prefer a documented-stable test string from the library's README.

## Milestones (each is a commit)

- [ ] **M1 — Server module + tests pass.** Files: `worker/username-validator.js` + `worker/username-validator.test.js`. `vitest run worker/username-validator.test.js` passes all four categories.
- [ ] **M2 — Client mirror + tests pass.** Files: `public/src/username-validator-client.js` + `public/src/username-validator-client.test.js`. `node --test public/src/username-validator-client.test.js` passes the same cases.

Each milestone is one commit. Commit messages:
- `M1: agent A — server username validator + tests`
- `M2: agent A — client username validator mirror + tests`

## Definition of done

1. Both modules export `validateUsernameSync` with identical behavior on identical inputs.
2. Both test files pass on `npm test`.
3. The "MIRROR OF" comment is present in both files.
4. No files outside your allowlist were modified.
5. `obscenity` is pinned to an exact version in `package.json` (no caret).

## How a subsequent agent / integrator uses your work

- **Agent C (profile API)** will import `validateUsernameSync` from `worker/username-validator.js` to validate before DB writes.
- **Agent F (auth modal)** will import from `public/src/username-validator-client.js` for inline preview.
- **Agent D (auth)** will call the server validator inside the better-auth signup hook.
