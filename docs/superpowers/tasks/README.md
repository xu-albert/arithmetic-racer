# Phase 2 Parallel Agent Briefs

This directory contains one brief per parallel agent for Phase 2 of the Users + Auth + Stats implementation. Read these files in order:

1. **`/docs/superpowers/specs/2026-05-06-users-auth-stats-design.md`** — design (what + why)
2. **`/docs/superpowers/plans/2026-05-06-users-auth-stats-implementation.md`** — master plan (Phase 1 Foundation, Phase 3 Integration)
3. **This directory** — Phase 2 agent briefs (one per agent)

## Dispatch order

Phase 1 (Foundation) must complete before any agent here is dispatched. Foundation produces:

- D1 created with all migrations applied (`migrations/0001_better_auth.sql`, `migrations/0002_username_and_race_results.sql`)
- `worker/api-contracts.js` (frozen — agents read but don't modify)
- `worker/index.js` skeleton with stub routes returning mock data
- `worker/db.js` D1 helper
- `public/src/stats-api.js` skeleton client
- `vitest.config.js` configured for vitest-pool-workers
- `package.json` deps installed: better-auth, obscenity, uuid, wrangler, vitest, @cloudflare/vitest-pool-workers

Once Phase 1 is committed, all 7 agents (A-G) can run in parallel — they have no shared file ownership and depend only on Foundation outputs.

## Agent index

| Agent | Brief | Slice |
|-------|-------|-------|
| A | `agent-a-username-validator.md` | Server + client username validator (pure functions) |
| B | `agent-b-race-result-api.md` | `POST /api/race-result` handler + tests |
| C | `agent-c-profile-api.md` | `GET /api/me`, `POST /api/me/username`, `GET /api/stats/by-device/:id` + tests |
| D | `agent-d-auth-email.md` | better-auth config, Resend email module, reset-password page |
| E | `agent-e-header-ui.md` | Persistent header (logged-in + logged-out states, stat pills) |
| F | `agent-f-auth-modal.md` | Auth modal (signup/signin/forgot/Google) + pick-username modal |
| G | `agent-g-profile-screen.md` | Profile screen (identity, tiles, info, race list, rename) |

## Coordination contracts

Agents do not import from each other (except Agent A's validator, which both Agent C and Agent F import). All UI state changes propagate via `document` custom events:

- `open-signup`, `open-signin`, `open-profile`, `request-signout` — fired by header (Agent E), consumed by auth modal / profile.
- `auth-changed` — fired by auth modal (Agent F) after sign-in / sign-out / signup; consumed by header and profile.

Backend coordination: all routes share `worker/api-contracts.js` (frozen) and `worker/db.js` (read-only utility). Cross-agent imports are limited to:

- Agent C → `worker/username-validator.js` (Agent A's server module)
- Agent D → `worker/username-validator.js` (Agent A's server module)
- Agent F → `public/src/username-validator-client.js` (Agent A's client mirror)
- Agent G → `public/src/username-validator-client.js` (Agent A's client mirror)

## Execution-time guidance

When the user is ready to dispatch agents:

1. The user (or main session) creates an isolated worktree per `superpowers:using-git-worktrees`.
2. The main session completes Phase 1 (Foundation) sequentially — small enough to do inline without subagents.
3. The main session dispatches Phase 2 agents using `superpowers:dispatching-parallel-agents`. Pass each agent its brief file path and the spec/plan paths as context.
4. After all agents commit, the main session executes Phase 3 (Integration) sequentially.

The user has explicitly asked NOT to launch agents at this stage. These files are documentation only until the user gives the go-ahead.
