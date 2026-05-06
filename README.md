# Arithmetic Racer

A real-time multiplayer arithmetic race. Players join a lobby, agree on difficulty, then race to be the first to answer 20 math problems correctly. TypeRacer-style horizontal track, animated cars, live opponent positions.

## Status

In active development. Building local-first (single-browser solo-vs-bots), then layering on real multiplayer.

## Local development

```bash
npm run dev
```

Open http://localhost:3000.

## Tests

```bash
npm test
```

## Stack (planned)

- Node.js + Express + Socket.io (server, added in Phase 6)
- Vanilla HTML / CSS / JS (frontend)
- Postgres (leaderboard)
- Render (deploy target)

## Architecture notes

Game logic is written as pure functions with no DOM access. In local-first mode (Phases 1-5), a browser-side `runner.js` shim drives the loop. In Phase 6, that shim is replaced with a Socket.io client; the game-logic module ports straight to the server unchanged.

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
