import { describe, expect, it } from "vitest";
import { chooseAiMove } from "../ai";
import type { AiDifficulty } from "../ai";
import { applyMove, createInitialState, isLegalMove } from "../engine";
import { getValidMoves } from "../rules";
import { DEFAULT_MAX_NODES, chooseSearchMove, searchBestMove, simulateMove } from "../search";
import type { GameState, GridConfig, Move, Player } from "../types";

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

/** Deterministic PRNG so a failure is reproducible. Same generator the rest of the suite uses. */
function makeRandom(seed: number) {
  let value = seed;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 4294967296;
  };
}

function randomLegalMove(state: GameState, random: () => number): Move | null {
  const current = state.players[state.currentPlayerIndex];
  const candidates = getValidMoves(state.board, current.id);
  if (candidates.length === 0) return null;
  const choice = candidates[Math.min(candidates.length - 1, Math.floor(random() * candidates.length))];
  return { playerId: current.id, row: choice.row, col: choice.col };
}

/** The engine's own view of a position, in the same plain shape `simulateMove` returns. */
function snapshotFromState(state: GameState) {
  const counts: number[] = [];
  const owners: Array<number | null> = [];
  const indexOf = new Map(state.players.map((player, index) => [player.id, index]));

  for (const row of state.board) {
    for (const cell of row) {
      counts.push(cell.count);
      owners.push(cell.ownerId === null ? null : (indexOf.get(cell.ownerId) ?? null));
    }
  }

  return {
    counts,
    owners,
    entered: state.players.map((player) => player.hasEnteredPlay),
    eliminated: state.players.map((player) => player.isEliminated),
    currentPlayerIndex: state.currentPlayerIndex,
    finished: state.status === "finished",
    winner: state.winnerId === null ? null : (indexOf.get(state.winnerId) ?? null)
  };
}

describe("search simulation — parity with the engine", () => {
  // The search runs on its own flat rewrite of the rules for speed. That is only
  // acceptable while it provably agrees with `applyMove`, so this replays whole
  // games and checks every reachable move on the way, not just the one played.
  const scenarios: Array<{ config: GridConfig; players: number; games: number }> = [
    { config: { rows: 6, cols: 6 }, players: 2, games: 25 },
    { config: { rows: 6, cols: 6 }, players: 4, games: 15 },
    { config: { rows: 8, cols: 8 }, players: 3, games: 10 },
    { config: { rows: 5, cols: 9 }, players: 2, games: 10 }
  ];

  for (const scenario of scenarios) {
    const label = `${scenario.config.rows}x${scenario.config.cols}, ${scenario.players} players`;

    it(`matches applyMove on every legal move throughout a game (${label})`, () => {
      let comparisons = 0;

      for (let game = 0; game < scenario.games; game += 1) {
        const random = makeRandom(game * 7919 + 13);
        let state = newGame(scenario.players, scenario.config);

        for (let ply = 0; ply < 400 && state.status === "playing"; ply += 1) {
          const current = state.players[state.currentPlayerIndex];

          // Every legal move from this position, through both implementations.
          for (const candidate of getValidMoves(state.board, current.id)) {
            const move: Move = { playerId: current.id, row: candidate.row, col: candidate.col };
            if (!isLegalMove(state, move)) continue;

            const fromEngine = snapshotFromState(applyMove(state, move).state);
            const fromSearch = simulateMove(state, move);

            expect(fromSearch, `divergence at ${label} game ${game} ply ${ply} on ${move.row},${move.col}`)
              .toEqual(fromEngine);
            comparisons += 1;
          }

          const played = randomLegalMove(state, random);
          if (!played) break;
          state = applyMove(state, played).state;
        }
      }

      // Guards the guard: a scenario that silently stopped exercising anything
      // would otherwise pass by doing nothing.
      expect(comparisons).toBeGreaterThan(500);
    });
  }
});

describe("searchBestMove — contract", () => {
  it("only ever returns a legal move, across many random positions", () => {
    for (let game = 0; game < 12; game += 1) {
      const random = makeRandom(game * 104729 + 7);
      let state = newGame(game % 3 === 0 ? 3 : 2);

      for (let ply = 0; ply < 60 && state.status === "playing"; ply += 1) {
        const move = chooseSearchMove(state, random, { maxNodes: 2_000 });
        expect(move).not.toBeNull();
        expect(isLegalMove(state, move!), `illegal move at game ${game} ply ${ply}`).toBe(true);
        state = applyMove(state, move!).state;
      }
    }
  });

  it("returns null when there is nothing to play", () => {
    const finished: GameState = { ...newGame(), status: "finished", winnerId: "p1" };
    expect(chooseSearchMove(finished, makeRandom(1))).toBeNull();
  });

  it("is deterministic for a given position and seed", () => {
    let state = newGame(2);
    const setup = makeRandom(99);
    for (let ply = 0; ply < 14; ply += 1) {
      state = applyMove(state, randomLegalMove(state, setup)!).state;
    }

    const first = searchBestMove(state, makeRandom(4242));
    const second = searchBestMove(state, makeRandom(4242));

    expect(second.move).toEqual(first.move);
    expect(second.nodes).toBe(first.nodes);
    expect(second.depth).toBe(first.depth);
  });

  it("searches deeper than one ply on a normal board", () => {
    let state = newGame(2);
    const setup = makeRandom(31);
    for (let ply = 0; ply < 12; ply += 1) {
      state = applyMove(state, randomLegalMove(state, setup)!).state;
    }

    // The whole point of the feature. If the budget or the ordering regresses to
    // the point where only one ply fits, `expert` is just `hard` wearing a hat.
    expect(searchBestMove(state, makeRandom(5)).depth).toBeGreaterThanOrEqual(3);
  });

  it("takes a move that wins immediately", () => {
    // Player 1 owns a loaded corner beside player 2's only orbs; detonating it
    // takes everything and ends the match.
    const base = newGame(2);
    const board = base.board.map((row) => row.map((cell) => ({ ...cell })));
    board[0][0] = { row: 0, col: 0, ownerId: "p1", count: 1 };
    board[0][1] = { row: 0, col: 1, ownerId: "p2", count: 1 };
    board[1][0] = { row: 1, col: 0, ownerId: "p2", count: 1 };

    const state: GameState = {
      ...base,
      board,
      players: base.players.map((player) => ({ ...player, hasEnteredPlay: true })),
      moveCount: 3
    };

    const result = searchBestMove(state, makeRandom(3));
    expect(result.move).toEqual({ playerId: "p1", row: 0, col: 0 });
    expect(applyMove(state, result.move!).state.winnerId).toBe("p1");
  });
});

describe("expert difficulty — strength", () => {
  it("beats hard convincingly head to head", () => {
    // The justification for the whole feature. If depth ever stops paying for
    // itself — a broken evaluation, ordering that prunes the good move, a budget
    // trimmed too far — `expert` quietly becomes `hard` with a longer pause, and
    // this is what notices.
    //
    // Measured at 60 games a side on 6x6 and again on 10x10: expert won 120 of
    // 120. The bar is set at 80% so a tie-break shifting a few games cannot fail
    // CI, while a real regression to parity still does.
    const GAMES = 24;
    let expertWins = 0;
    let decided = 0;

    for (let game = 0; game < GAMES; game += 1) {
      // Alternate the opening seat, so first-move advantage cannot flatter either side.
      const expertSeat = game % 2;
      const seats: AiDifficulty[] = expertSeat === 0 ? ["expert", "hard"] : ["hard", "expert"];
      const random = makeRandom(game * 6421 + 17);
      let state = newGame(2);

      for (let ply = 0; ply < 600 && state.status === "playing"; ply += 1) {
        const move = chooseAiMove(state, seats[state.currentPlayerIndex], random);
        if (!move || !isLegalMove(state, move)) break;
        state = applyMove(state, move).state;
      }

      if (state.status !== "finished" || state.winnerId === null) continue;
      decided += 1;
      if (state.players.findIndex((player) => player.id === state.winnerId) === expertSeat) {
        expertWins += 1;
      }
    }

    expect(decided).toBeGreaterThan(GAMES * 0.8);
    expect(expertWins / decided, `expert won only ${expertWins} of ${decided}`).toBeGreaterThan(0.8);
  }, 120_000);

  it("is the search, not the greedy heuristic in disguise", () => {
    // `hard` is documented to *be* `chooseGreedyMove` for a given seed. `expert`
    // must not be, or the ladder has a duplicate rung.
    let state = newGame(2);
    const setup = makeRandom(77);
    for (let ply = 0; ply < 16; ply += 1) {
      state = applyMove(state, randomLegalMove(state, setup)!).state;
    }

    expect(chooseAiMove(state, "expert", makeRandom(5))).toEqual(chooseSearchMove(state, makeRandom(5)));
  });
});

describe("searchBestMove — budget", () => {
  it("never exceeds its node budget", () => {
    for (const maxNodes of [50, 500, 5_000]) {
      let state = newGame(2);
      const setup = makeRandom(maxNodes);
      for (let ply = 0; ply < 16; ply += 1) {
        state = applyMove(state, randomLegalMove(state, setup)!).state;
      }

      const result = searchBestMove(state, makeRandom(1), { maxNodes });
      expect(result.nodes).toBeLessThanOrEqual(maxNodes);
      expect(result.move).not.toBeNull();
    }
  });

  it("still returns a move on the tiniest budget", () => {
    // Depth 1 is always affordable because the first root child is searched
    // before the budget can be consulted; the guarantee is that *something*
    // comes back, never that a partial search returns nothing.
    let state = newGame(2);
    const setup = makeRandom(64);
    for (let ply = 0; ply < 10; ply += 1) {
      state = applyMove(state, randomLegalMove(state, setup)!).state;
    }

    const result = searchBestMove(state, makeRandom(1), { maxNodes: 1 });
    expect(result.move).not.toBeNull();
    expect(isLegalMove(state, result.move!)).toBe(true);
  });

  it("stays responsive on the largest board", () => {
    // Not a microbenchmark — a smoke alarm. The ceiling is many times the
    // measured cost so it cannot flake on a loaded CI box, but a change that
    // made the search an order of magnitude slower would trip it.
    const config: GridConfig = { rows: 14, cols: 14 };
    let state = newGame(4, config);
    const setup = makeRandom(2024);
    for (let ply = 0; ply < 120 && state.status === "playing"; ply += 1) {
      state = applyMove(state, randomLegalMove(state, setup)!).state;
    }

    const start = performance.now();
    const result = searchBestMove(state, makeRandom(8), { maxNodes: DEFAULT_MAX_NODES });
    const elapsed = performance.now() - start;

    expect(result.move).not.toBeNull();
    expect(elapsed, `search took ${elapsed.toFixed(0)}ms on a 14x14 board`).toBeLessThan(500);
  });
});
