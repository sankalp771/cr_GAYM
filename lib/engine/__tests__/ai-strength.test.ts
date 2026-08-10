import { describe, expect, it } from "vitest";
import { chooseGreedyMove } from "../ai";
import { applyMove, createInitialState, pickAutoMove } from "../engine";
import type { GameState, Player } from "../types";

function players(n: number): Player[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `p${i + 1}`, name: `P${i + 1}`, color: "#fff", hasEnteredPlay: false, isEliminated: false
  }));
}
function rng(seed: number) {
  let v = seed >>> 0;
  return () => ((v = (v * 1664525 + 1013904223) >>> 0) / 4294967296);
}

describe("greedy strength", () => {
  it("beats random decisively", () => {
    const size = 6;
    let greedyWins = 0, randomWins = 0, moves = 0;
    const GAMES = 120;

    for (let g = 0; g < GAMES; g++) {
      const r = rng(g * 7919 + 13);
      // Alternate who moves first so first-move advantage cancels out.
      const greedySeat = g % 2;
      let s: GameState = createInitialState({ rows: size, cols: size }, players(2));

      while (s.status === "playing" && s.moveCount < 3000) {
        const isGreedy = s.currentPlayerIndex === greedySeat;
        const move = isGreedy ? chooseGreedyMove(s, r) : pickAutoMove(s, r);
        if (!move) break;
        s = applyMove(s, move).state;
        moves++;
      }

      if (s.winnerId === `p${greedySeat + 1}`) greedyWins++;
      else if (s.winnerId) randomWins++;
    }

    const rate = (greedyWins / GAMES) * 100;
    console.log(`greedy ${greedyWins} / random ${randomWins} of ${GAMES}  =>  ${rate.toFixed(1)}% win rate`);
    console.log(`avg game length: ${(moves / GAMES).toFixed(1)} moves`);
    expect(greedyWins + randomWins).toBe(GAMES);
    expect(rate).toBeGreaterThan(60);
  });

  it("is fast enough for a 14x14 board", () => {
    const s = createInitialState({ rows: 14, cols: 14 }, players(2));
    const r = rng(1);
    const t0 = performance.now();
    for (let i = 0; i < 20; i++) chooseGreedyMove(s, r);
    const per = (performance.now() - t0) / 20;
    console.log(`14x14 opening move: ${per.toFixed(1)}ms per decision`);
    expect(per).toBeLessThan(1000);
  });
});
