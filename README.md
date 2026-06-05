# Arithmetic Racer

A real-time multiplayer arithmetic race. Players join a lobby, agree on difficulty, then race to be the first to answer 10 math problems correctly. TypeRacer-style horizontal track, animated cars, live opponent positions.

## Status

Solo-vs-bots, accounts and stats, and private multiplayer rooms are all on `main`.

Live: https://arithmetic-racer.albertwxu.workers.dev

## Local development

```bash
npm run dev
```

Runs `wrangler dev`. Open http://localhost:8787.

## Tests

```bash
npm test
```

Runs `node --test public/src/*.test.js` (pure game logic) and `vitest run` (Worker routes).

See [`docs/testing.md`](./docs/testing.md) for the full manual test plan — Quickplay smoke, the two-browser multiplayer matrix, regression things to watch for, and notes on deploys.

## Stack

- Cloudflare Workers (server entry `server/server.js`)
- Durable Objects via PartyServer for race rooms (`server/room.js`)
- D1 (SQLite) for users and race results
- better-auth for email/password and Google OAuth
- Loops for transactional email
- Vanilla HTML / CSS / JS frontend, no framework

## Difficulty reference

Calibration is provisional — revisit after playtesting. Defined in `src/game.js`.

### Easy
Single-digit `+` and `−`. Operands 0-9. Subtraction never goes negative.

```
2 - 2  = 0
3 + 8  = 11
7 - 6  = 1
6 + 4  = 10
```

### Medium
Two-digit `+` and `−` (10-99 each side), and two-digit × single-digit (10-99 × 2-9).

```
96 - 42  = 54
84 - 59  = 25
40 × 9   = 360
17 × 5   = 85
```

### Hard
Mid-range multiplication (11-19 × 2-9) and clean integer division (dividend = divisor × quotient, divisor 2-9, quotient 2-19).

```
16 ÷ 2   = 8
11 × 6   = 66
54 ÷ 6   = 9
15 × 5   = 75
```

### Notes for future calibration
- Easy includes trivial cases like `1 + 1`. Bump operand floor if it feels too easy.
- Hard division is `(2-9) × (2-19)` so dividends top out at 171 and divisors are always single-digit. Could widen to two-digit divisors for a harder tier later.
- All answers are integers. No fractions, no negatives in answers.

## License

MIT
