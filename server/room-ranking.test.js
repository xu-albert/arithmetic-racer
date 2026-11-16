// The room's podium order (rankPlayers, the order `finish` broadcasts) and the
// client's (rankRacers, which draws the podium and the finish banner's place)
// must be one rule, or a reconnecting client contradicts the room it is in.
// The out tiers are where they used to agree on the wrong thing: dropped and
// dnf seats kept arrival order, so a Quick Match podium could list 8/10 above
// 9/10. Now dnf (stayed to the end) ranks above dropped (left), each by score.

import { describe, it, expect } from "vitest";
import { rankPlayers } from "./room.js";
import { rankRacers } from "../public/src/rankings.js";

const seat = (id, extra = {}) => ({ id, score: 0, finishMs: null, dropped: false, dnf: false, ...extra });

describe("rankPlayers", () => {
  it("orders dnf above dropped, and each by score, highest first", () => {
    const out = rankPlayers([
      seat("eight", { score: 8, dnf: true }),
      seat("quit", { score: 2, dropped: true }),
      seat("nine", { score: 9, dnf: true }),
    ]);
    expect(out.map((p) => p.id)).toEqual(["nine", "eight", "quit"]);
    expect(rankPlayers([seat("quit-9", { score: 9, dropped: true }), seat("dnf-1", { score: 1, dnf: true })])
      .map((p) => p.id)).toEqual(["dnf-1", "quit-9"]);
  });

  it("matches the client's rankRacers across every tier", () => {
    const field = [
      seat("dnf-3", { score: 3, dnf: true }),
      seat("racing-4", { score: 4 }),
      seat("slow", { score: 10, finishMs: 9000 }),
      seat("dropped-7", { score: 7, dropped: true }),
      seat("fast", { score: 10, finishMs: 4000 }),
      seat("racing-6", { score: 6 }),
      seat("dnf-3b", { score: 3, dnf: true }),
    ];
    const ids = (rows) => rows.map((p) => p.id);
    expect(ids(rankPlayers(field))).toEqual(ids(rankRacers(field)));
    expect(ids(rankPlayers(field))).toEqual([
      "fast", "slow", "racing-6", "racing-4", "dnf-3", "dnf-3b", "dropped-7",
    ]);
  });
});
