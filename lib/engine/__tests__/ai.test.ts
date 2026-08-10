import { describe, expect, it } from "vitest";
import { AI_DIFFICULTIES, chooseAiMove, chooseGreedyMove, isAiDifficulty } from "../ai";
import type { AiDifficulty } from "../ai";
import { applyMove, createInitialState, isLegalMove, pickAutoMove } from "../engine";
import { countPlayerOrbs, criticalMass } from "../rules";
import type { Board, GameState, GridConfig, Move, Player } from "../types";

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

/** Deterministic PRNG so failures are reproducible. Same generator the engine suite uses. */
function makeRandom(seed: number) {
  let value = seed;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

/** Build a state directly, for positions that would take a long game to reach. */
function stateFrom(
  cells: Array<{ row: number; col: number; ownerId: string; count: number }>,
  options: { playerCount?: number; config?: GridConfig; currentPlayerIndex?: number } = {}
): GameState {
  const { playerCount = 2, config = standard, currentPlayerIndex = 0 } = options;
  const base = newGame(playerCount, config);
  const board: Board = base.board.map((row) => row.map((cell) => ({ ...cell })));

  for (const cell of cells) {
    board[cell.row][cell.col] = { row: cell.row, col: cell.col, ownerId: cell.ownerId, count: cell.count };
  }

  return {
    ...base,
    board,
    // Every seat has played, so elimination and the mid-cascade victory check
    // are both live — the same conditions a real mid-game position has.
    players: base.players.map((player) => ({ ...player, hasEnteredPlay: true })),
    currentPlayerIndex,
    moveCount: cells.length
  };
}

describe("chooseGreedyMove — legality", () => {
  it("only ever returns a legal move, across many random positions", () => {
    const scenarios: Array<{ config: GridConfig; players: number }> = [
      { config: { rows: 6, cols: 6 }, players: 2 },
      { config: { rows: 6, cols: 6 }, players: 4 },
      { config: { rows: 5, cols: 7 }, players: 3 },
      { config: { rows: 3, cols: 3 }, players: 2 }
    ];

    let positionsChecked = 0;

    for (const scenario of scenarios) {
      for (let game = 0; game < 6; game += 1) {
        const scatter = makeRandom(game * 7919 + scenario.players);
        const aiRandom = makeRandom(game * 104_729 + 5);
        let state = newGame(scenario.players, scenario.config);

        // Walk the game forward with random play, asking the AI for its move at
        // every single position along the way. Random play reaches lopsided and
        // near-saturated boards a greedy self-play game never would.
        while (state.status === "playing") {
          const suggestion = chooseGreedyMove(state, aiRandom);
          expect(suggestion).not.toBeNull();
          expect(isLegalMove(state, suggestion as Move)).toBe(true);
          positionsChecked += 1;

          const move = pickAutoMove(state, scatter);
          if (!move) break;
          state = applyMove(state, move).state;
        }

        // Nothing left to choose once the match is decided.
        expect(chooseGreedyMove(state, aiRandom)).toBeNull();
      }
    }

    expect(positionsChecked).toBeGreaterThan(200);
  });

  it("returns null for a finished match and for an eliminated seat", () => {
    const finished: GameState = { ...newGame(), status: "finished", winnerId: "p1" };
    expect(chooseGreedyMove(finished, makeRandom(1))).toBeNull();

    const base = newGame();
    const eliminated: GameState = {
      ...base,
      players: base.players.map((player, index) =>
        index === 0 ? { ...player, hasEnteredPlay: true, isEliminated: true } : player
      )
    };
    expect(chooseGreedyMove(eliminated, makeRandom(1))).toBeNull();
  });
});

describe("chooseGreedyMove — determinism", () => {
  it("returns the same move twice for the same seed", () => {
    const state = newGame();
    expect(chooseGreedyMove(state, makeRandom(42))).toEqual(chooseGreedyMove(state, makeRandom(42)));
  });

  it("replays an entire self-play game identically for the same seed", () => {
    const playOut = (seed: number) => {
      const random = makeRandom(seed);
      let state = newGame(3);
      const moves: Move[] = [];

      while (state.status === "playing" && moves.length < 400) {
        const move = chooseGreedyMove(state, random);
        if (!move) break;
        moves.push(move);
        state = applyMove(state, move).state;
      }

      return moves;
    };

    expect(playOut(2024)).toEqual(playOut(2024));
  });

  it("uses the injected randomness only to break ties", () => {
    // An empty board is symmetric enough that several corners score alike, so a
    // different seed is allowed to pick a different one — but every choice must
    // still be one of the tied best moves, never an interior cell.
    const state = newGame();
    const picks = [1, 2, 3, 4, 5, 6, 7, 8].map((seed) => chooseGreedyMove(state, makeRandom(seed)));

    for (const pick of picks) {
      expect(pick).not.toBeNull();
      expect(criticalMass(pick!.row, pick!.col, standard)).toBe(2);
    }
  });
});

describe("chooseGreedyMove — heuristic", () => {
  it("takes an available capture over a neutral move", () => {
    // p1's edge cell at (0,2) holds 2 of the 3 orbs it needs; one more explodes
    // it into (0,1), taking p2's three orbs with it. Every other legal move is
    // quiet. The capture must win.
    const state = stateFrom([
      { row: 0, col: 2, ownerId: "p1", count: 2 },
      { row: 0, col: 1, ownerId: "p2", count: 2 },
      { row: 5, col: 5, ownerId: "p2", count: 1 }
    ]);

    const move = chooseGreedyMove(state, makeRandom(11));
    expect(move).toEqual({ playerId: "p1", row: 0, col: 2 });

    // The captured stack is over its own critical mass once it changes hands, so
    // it explodes on in p1's colour rather than sitting there — count what p2 is
    // left holding instead of inspecting the square.
    const after = applyMove(state, move as Move).state;
    expect(countPlayerOrbs(after.board, "p2")).toBe(1);
    expect(countPlayerOrbs(state.board, "p2")).toBe(3);
  });

  it("prefers a corner to an interior cell when nothing else separates them", () => {
    // Both sides are already established and far apart, so no capture is on
    // offer anywhere and only the positional term can decide.
    const state = stateFrom([
      { row: 0, col: 0, ownerId: "p1", count: 1 },
      { row: 5, col: 5, ownerId: "p2", count: 1 }
    ]);

    const move = chooseGreedyMove(state, makeRandom(3));
    expect(move).not.toBeNull();
    expect(criticalMass(move!.row, move!.col, standard)).toBe(2);
  });

  it("does not park orbs beside an enemy cell that is one orb from exploding", () => {
    // (3,3) is interior, so p2's 3 orbs there are one short of critical: any
    // p1 orb on one of its four neighbours is handed straight over next turn.
    const state = stateFrom([
      { row: 3, col: 3, ownerId: "p2", count: 3 },
      { row: 0, col: 5, ownerId: "p1", count: 1 }
    ]);

    const move = chooseGreedyMove(state, makeRandom(17));
    expect(move).not.toBeNull();

    const touchesTheLoadedCell =
      Math.abs(move!.row - 3) + Math.abs(move!.col - 3) === 1;
    expect(touchesTheLoadedCell, `AI played ${move!.row},${move!.col}, next to the loaded enemy cell`).toBe(false);
  });

  it("still takes the exchange when the capture is worth more than the exposure", () => {
    // p1 at (0,1) is one orb from exploding into p2's loaded corner. Playing it
    // costs p1 exposure on that side but wins the corner and the orbs behind
    // it, so the material has to outvote the risk penalty.
    const state = stateFrom([
      { row: 0, col: 1, ownerId: "p1", count: 2 },
      { row: 0, col: 0, ownerId: "p2", count: 1 },
      { row: 1, col: 1, ownerId: "p2", count: 3 },
      { row: 5, col: 0, ownerId: "p2", count: 1 }
    ]);

    const move = chooseGreedyMove(state, makeRandom(5));
    expect(move).toEqual({ playerId: "p1", row: 0, col: 1 });
  });

  it("takes an immediately winning move when one exists", () => {
    // p2 is down to a single orb at (0,0). p1's corner-adjacent stack at (0,1)
    // is one orb from exploding into it, which wipes p2 off the board.
    const state = stateFrom([
      { row: 0, col: 1, ownerId: "p1", count: 2 },
      { row: 0, col: 0, ownerId: "p2", count: 1 },
      { row: 4, col: 4, ownerId: "p1", count: 1 }
    ]);

    const move = chooseGreedyMove(state, makeRandom(8));
    expect(move).toEqual({ playerId: "p1", row: 0, col: 1 });

    const after = applyMove(state, move as Move).state;
    expect(after.status).toBe("finished");
    expect(after.winnerId).toBe("p1");
  });

  it("prefers the winning move even when it sits on the worst square on the board", () => {
    // The winning move is the interior cell (3,3) — the square the positional
    // term likes least — while four untouched corners are on offer. Winning has
    // to outrank every other consideration, so the interior cell must still win.
    const state = stateFrom([
      { row: 3, col: 3, ownerId: "p1", count: 3 },
      { row: 3, col: 4, ownerId: "p2", count: 1 }
    ]);

    const move = chooseGreedyMove(state, makeRandom(13));
    expect(move).toEqual({ playerId: "p1", row: 3, col: 3 });
    expect(criticalMass(3, 3, standard)).toBe(4);

    const after = applyMove(state, move as Move).state;
    expect(after.status).toBe("finished");
    expect(after.winnerId).toBe("p1");
  });
});

describe("chooseGreedyMove — self play", () => {
  it("plays an all-AI game to completion on every seat count from 2 to 8", () => {
    for (let playerCount = 2; playerCount <= 8; playerCount += 1) {
      const random = makeRandom(playerCount * 31 + 7);
      let state = newGame(playerCount);
      let moves = 0;

      while (state.status === "playing" && moves < 2000) {
        const move = chooseGreedyMove(state, random);
        expect(move).not.toBeNull();
        if (!move) break;
        expect(isLegalMove(state, move)).toBe(true);
        state = applyMove(state, move).state;
        moves += 1;
      }

      expect(state.status, `${playerCount}-seat all-AI game did not finish in ${moves} moves`).toBe("finished");
      expect(state.winnerId).not.toBeNull();
      expect(state.players.filter((player) => !player.isEliminated)).toHaveLength(1);
    }
  });

  it("beats random play far more often than it loses", () => {
    // Not a rule the engine guarantees, but a greedy opponent that cannot
    // reliably out-play coin flips is not worth shipping as an opponent.
    let greedyWins = 0;
    const rounds = 20;

    for (let round = 0; round < rounds; round += 1) {
      const random = makeRandom(round * 2_654_435_761 + 1);
      let state = newGame(2);

      while (state.status === "playing" && state.moveCount < 2000) {
        // Seat 1 is greedy, seat 2 plays at random.
        const move =
          state.currentPlayerIndex === 0 ? chooseGreedyMove(state, random) : pickAutoMove(state, random);
        if (!move) break;
        state = applyMove(state, move).state;
      }

      if (state.winnerId === "p1") greedyWins += 1;
    }

    expect(greedyWins, `greedy won only ${greedyWins} of ${rounds}`).toBeGreaterThan(rounds * 0.6);
  });
});

describe("difficulty levels", () => {
  it("recognises only the three known levels", () => {
    expect(AI_DIFFICULTIES).toEqual(["easy", "normal", "hard"]);
    for (const level of AI_DIFFICULTIES) expect(isAiDifficulty(level)).toBe(true);
    for (const bogus of ["", "expert", "HARD", null, 3]) expect(isAiDifficulty(bogus)).toBe(false);
  });

  it("only ever returns a legal move, at every level", () => {
    for (const level of AI_DIFFICULTIES) {
      let state = newGame();
      const random = makeRandom(17);

      for (let turn = 0; turn < 40 && state.status === "playing"; turn += 1) {
        const move = chooseAiMove(state, level, random);
        if (!move) break;
        expect(isLegalMove(state, move), `${level} produced an illegal move`).toBe(true);
        state = applyMove(state, move).state;
      }
    }
  });

  it("is deterministic for a fixed seed at every level", () => {
    for (const level of AI_DIFFICULTIES) {
      const state = newGame();
      expect(chooseAiMove(state, level, makeRandom(99))).toEqual(chooseAiMove(state, level, makeRandom(99)));
    }
  });

  it("plays hard as pure greedy", () => {
    // `hard` must never blunder, so it has to agree with the raw heuristic on
    // every position — with the same seed, since both consume the rng.
    let state = newGame();
    const drive = makeRandom(5);

    for (let turn = 0; turn < 25 && state.status === "playing"; turn += 1) {
      expect(chooseAiMove(state, "hard", makeRandom(turn + 1))).toEqual(
        chooseGreedyMove(state, makeRandom(turn + 1))
      );
      const move = chooseAiMove(state, "hard", drive);
      if (!move) break;
      state = applyMove(state, move).state;
    }
  });

  it("orders the ladder: easy loses to normal, normal loses to hard", () => {
    // A difficulty selector is only worth having if the levels differ in
    // strength. Each level plays a series against `hard`; the win rates must
    // come out strictly increasing.
    const winRateVsHard = (level: AiDifficulty) => {
      const games = 40;
      let wins = 0;

      for (let game = 0; game < games; game += 1) {
        const random = makeRandom(game * 104_729 + 11);
        const testedSeat = game % 2; // alternate who opens, cancelling that edge
        let state = newGame();

        while (state.status === "playing" && state.moveCount < 3000) {
          const level_ = state.currentPlayerIndex === testedSeat ? level : "hard";
          const move = chooseAiMove(state, level_, random);
          if (!move) break;
          state = applyMove(state, move).state;
        }

        if (state.winnerId === `p${testedSeat + 1}`) wins += 1;
      }

      return (wins / games) * 100;
    };

    const easy = winRateVsHard("easy");
    const normal = winRateVsHard("normal");
    console.log(`win rate against hard — easy ${easy.toFixed(1)}%, normal ${normal.toFixed(1)}%`);

    expect(easy, "easy should not be beating hard").toBeLessThan(normal);
    expect(normal, "normal should still lose to hard on balance").toBeLessThan(50);
  });
});
