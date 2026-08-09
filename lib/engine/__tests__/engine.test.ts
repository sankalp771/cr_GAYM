import { describe, expect, it } from "vitest";
import { applyMove, createInitialState, isLegalMove, pickAutoMove } from "../engine";
import { countTotalOrbs, criticalMass, getOwnersWithOrbs } from "../rules";
import { EngineError } from "../types";
import type { GameState, GridConfig, Player } from "../types";

const standard: GridConfig = { rows: 6, cols: 6 };

function makePlayers(count: number): Player[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `p${index + 1}`,
    name: `Player ${index + 1}`,
    color: "#ffffff",
    hasEnteredPlay: false,
    isEliminated: false
  }));
}

function newGame(playerCount = 2, config: GridConfig = standard): GameState {
  return createInitialState(config, makePlayers(playerCount));
}

/** Play a move as whoever's turn it currently is. */
function play(state: GameState, row: number, col: number): GameState {
  const playerId = state.players[state.currentPlayerIndex].id;
  return applyMove(state, { playerId, row, col }).state;
}

/** Deterministic PRNG so failures are reproducible. */
function makeRandom(seed: number) {
  let value = seed;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

describe("placement", () => {
  it("adds one orb, claims the cell, and passes the turn", () => {
    const state = play(newGame(), 2, 2);

    expect(state.board[2][2].count).toBe(1);
    expect(state.board[2][2].ownerId).toBe("p1");
    expect(state.currentPlayerIndex).toBe(1);
    expect(state.moveCount).toBe(1);
    expect(state.status).toBe("playing");
  });

  it("rejects a move onto an opponent's cell", () => {
    const afterP1 = play(newGame(), 0, 0);

    expect(isLegalMove(afterP1, { playerId: "p2", row: 0, col: 0 })).toBe(false);
    expect(() => applyMove(afterP1, { playerId: "p2", row: 0, col: 0 })).toThrow(EngineError);
  });

  it("rejects a move from a player when it is not their turn", () => {
    expect(isLegalMove(newGame(), { playerId: "p2", row: 0, col: 0 })).toBe(false);
  });

  it("rejects a move outside the board", () => {
    expect(isLegalMove(newGame(), { playerId: "p1", row: 6, col: 0 })).toBe(false);
    expect(isLegalMove(newGame(), { playerId: "p1", row: -1, col: 0 })).toBe(false);
  });
});

describe("explosions", () => {
  it("explodes a corner on the second placement", () => {
    expect(criticalMass(0, 0, standard)).toBe(2);

    let state = newGame();
    state = play(state, 0, 0); // p1
    state = play(state, 5, 5); // p2, far away
    state = play(state, 0, 0); // p1 reaches critical mass

    expect(state.board[0][0].count).toBe(0);
    expect(state.board[0][0].ownerId).toBeNull();
    expect(state.board[0][1]).toMatchObject({ count: 1, ownerId: "p1" });
    expect(state.board[1][0]).toMatchObject({ count: 1, ownerId: "p1" });
  });

  it("converts an opponent's neighbouring cell", () => {
    let state = newGame();
    state = play(state, 0, 0); // p1 corner
    state = play(state, 0, 1); // p2 next to it
    state = play(state, 0, 0); // p1 explodes into p2's cell

    expect(state.board[0][1].ownerId).toBe("p1");
    expect(state.board[0][1].count).toBe(2);
  });

  it("conserves orbs: total after a move is exactly one more than before", () => {
    let state = newGame();
    const random = makeRandom(7);

    for (let turn = 0; turn < 40 && state.status === "playing"; turn += 1) {
      const before = countTotalOrbs(state.board);
      const move = pickAutoMove(state, random);
      if (!move) break;

      state = applyMove(state, move).state;
      expect(countTotalOrbs(state.board)).toBe(before + 1);
    }
  });
});

describe("elimination", () => {
  it("does not eliminate a player who has not moved yet", () => {
    // The classic bug: after player 1's opening move, player 2 owns nothing and
    // a naive "owns no cells" check declares them eliminated before their turn.
    const state = play(newGame(), 0, 0);

    expect(state.players.find((player) => player.id === "p2")?.isEliminated).toBe(false);
    expect(state.status).toBe("playing");
    expect(state.winnerId).toBeNull();
  });

  it("does not eliminate anyone during the opening round of a four-player game", () => {
    let state = newGame(4);

    for (let move = 0; move < 3; move += 1) {
      state = play(state, 0, move);
      expect(state.players.every((player) => !player.isEliminated)).toBe(true);
      expect(state.status).toBe("playing");
    }
  });

  it("eliminates a player once they have played and then lost every orb", () => {
    let state = newGame();
    state = play(state, 0, 0); // p1 corner, 1 orb
    state = play(state, 0, 1); // p2 beside it, 1 orb
    state = play(state, 0, 0); // p1 explodes, taking p2's only cell

    const p2 = state.players.find((player) => player.id === "p2");
    expect(p2?.isEliminated).toBe(true);
    expect(state.status).toBe("finished");
    expect(state.winnerId).toBe("p1");
  });
});

describe("cascade termination", () => {
  /**
   * Regression for a browser-freezing bug.
   *
   * Explosions conserve orbs and the grid has no sink, so a board holding more
   * orbs than its stable capacity has no resting state at all — the old loop ran
   * forever and exhausted memory recording frames. It always happened at the
   * moment somebody won, which is precisely when the reaction should stop.
   */
  it("settles a saturated board instead of looping forever", () => {
    const base = newGame();
    const board = base.board.map((row) =>
      row.map((cell) => ({
        ...cell,
        ownerId: "p1" as string | null,
        count: criticalMass(cell.row, cell.col, standard) - 1
      }))
    );

    const state: GameState = {
      ...base,
      board,
      players: base.players.map((player) => ({ ...player, hasEnteredPlay: true }))
    };

    const before = countTotalOrbs(state.board);
    const result = applyMove(state, { playerId: "p1", row: 0, col: 0 }, { recordFrames: true });

    expect(result.state.status).toBe("finished");
    expect(result.state.winnerId).toBe("p1");
    expect(result.endedMidCascade).toBe(true);
    expect(countTotalOrbs(result.state.board)).toBe(before + 1);
    expect(getOwnersWithOrbs(result.state.board)).toEqual(["p1"]);
  });

  it("caps recorded frames rather than allocating without bound", () => {
    const base = newGame();
    const board = base.board.map((row) =>
      row.map((cell) => ({
        ...cell,
        ownerId: "p1" as string | null,
        count: criticalMass(cell.row, cell.col, standard) - 1
      }))
    );
    const state: GameState = {
      ...base,
      board,
      players: base.players.map((player) => ({ ...player, hasEnteredPlay: true }))
    };

    const result = applyMove(state, { playerId: "p1", row: 0, col: 0 }, { recordFrames: true, maxFrames: 5 });
    expect(result.frames.length).toBeLessThanOrEqual(5);
  });

  /**
   * The strongest form of the regression: play whole games out at random and
   * require every one of them to finish. Against the previous implementation
   * 279 of 300 such games hung.
   */
  it("plays 200 random games to completion on several board sizes and player counts", () => {
    const scenarios: Array<{ config: GridConfig; players: number }> = [
      { config: { rows: 6, cols: 6 }, players: 2 },
      { config: { rows: 6, cols: 6 }, players: 3 },
      { config: { rows: 8, cols: 8 }, players: 2 },
      { config: { rows: 5, cols: 7 }, players: 2 }
    ];

    for (const scenario of scenarios) {
      for (let game = 0; game < 50; game += 1) {
        const random = makeRandom(game * 2654435761 + scenario.players);
        let state = newGame(scenario.players, scenario.config);
        let moves = 0;

        while (state.status === "playing" && moves < 5000) {
          const move = pickAutoMove(state, random);
          if (!move) break;
          state = applyMove(state, move).state;
          moves += 1;
        }

        expect(state.status).toBe("finished");
        expect(state.winnerId).not.toBeNull();
        expect(state.players.filter((player) => !player.isEliminated)).toHaveLength(1);
      }
    }
  });
});

describe("auto-play", () => {
  it("is deterministic for a given random source", () => {
    const state = newGame();
    expect(pickAutoMove(state, makeRandom(42))).toEqual(pickAutoMove(state, makeRandom(42)));
  });

  it("only ever picks a legal move", () => {
    let state = newGame();
    const random = makeRandom(99);

    for (let turn = 0; turn < 30 && state.status === "playing"; turn += 1) {
      const move = pickAutoMove(state, random);
      if (!move) break;
      expect(isLegalMove(state, move)).toBe(true);
      state = applyMove(state, move).state;
    }
  });
});
