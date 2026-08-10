# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Add durable project-specific notes here as they are discovered through real work.

## Dependencies and the lockfile

The Cloudflare Workers build runs `npm ci`, which hard-fails unless `package-lock.json`
records the optional platform packages for *every* platform (`@esbuild/*`,
`lightningcss-*`, `@rolldown/binding-*`, `@img/sharp-*`, `@cloudflare/workerd-*`,
`fsevents`) — not just the `darwin-arm64` ones a Mac install needs. npm 10.x tolerates a
lockfile missing them; npm 11.x rejects it. `.nvmrc` pins the build's Node (and therefore
its bundled npm), so treat that pin as build configuration, not a local preference.

When changing dependencies:

- Refresh the lockfile with **npm 11 or newer** — run `npx npm@11 install --package-lock-only`,
  which works without leaving `.nvmrc`'s Node 22 (it bundles npm 10, and npm 10 will not add
  the foreign-platform entries back, nor will CI on Node 22 notice they are gone).
- **Never** delete `package-lock.json` to regenerate it from scratch. A clean resolve
  ignores the currently pinned versions and dies on an `ERESOLVE` conflict, because
  `wrangler`'s newest release peer-requires `@cloudflare/workers-types@^5` while
  `package.json` asks for `^4`.
- Sanity check before committing: the lockfile should contain ~82 of those platform
  entries, and `npm ci` should pass on the newest Node you have, not only on `.nvmrc`'s.

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
