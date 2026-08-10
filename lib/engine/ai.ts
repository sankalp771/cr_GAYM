/**
 * Greedy computer opponent.
 *
 * Pure, like the rest of `lib/engine/` — no React, no DOM, no `Date.now()`, no
 * `Math.random()`. Randomness is injected exactly as it is for `pickAutoMove`,
 * so a match is reproducible from a seed, a test can pin the choice, and an
 * authoritative server could be the one rolling the dice.
 *
 * This is deliberately one ply: score every legal move by the position it
 * produces and take the best. No minimax, no alpha-beta, no opponent reply —
 * depth search is a separate piece of work and mixing the two would make
 * neither reviewable.
 */

import { applyMove, isLegalMove } from "./engine";
import { criticalMass, getNeighbors, getValidMoves } from "./rules";
import { chooseSearchMove } from "./search";
import type { Board, Cell, GameState, GridConfig, Move, PlayerId } from "./types";
import {
  MATERIAL_WEIGHT,
  POSITION_WEIGHT,
  RISK_WEIGHT,
  SCORE_EPSILON,
  THREAT_WEIGHT,
  WIN_SCORE
} from "./weights";

/** Orbs held by `playerId` minus the orbs held by everyone else. */
function materialBalance(board: Board, playerId: PlayerId): number {
  let mine = 0;
  let theirs = 0;

  for (const row of board) {
    for (const cell of row) {
      if (cell.ownerId === null) continue;
      if (cell.ownerId === playerId) mine += cell.count;
      else theirs += cell.count;
    }
  }

  return mine - theirs;
}

/** True when one more orb would tip this cell over and explode it. */
function isLoaded(cell: Cell, config: GridConfig): boolean {
  return cell.count > 0 && cell.count === criticalMass(cell.row, cell.col, config) - 1;
}

/**
 * How exposed each side is on a settled board.
 *
 * A cell is in danger when an *enemy* neighbour is loaded: the enemy can pop it
 * on their next turn and everything it spills into changes hands. Counting the
 * orbs at stake rather than the cells means a fat stack sitting next to a
 * loaded enemy cell is correctly treated as a bigger liability than a single
 * orb doing the same.
 */
function measurePressure(board: Board, config: GridConfig, playerId: PlayerId) {
  let ownOrbsAtRisk = 0;
  let enemyOrbsThreatened = 0;

  for (const row of board) {
    for (const cell of row) {
      if (cell.ownerId === null || cell.count === 0) continue;

      let hostileLoadedNeighbor = false;
      let loadedNeighborOfMine = false;

      for (const [neighborRow, neighborCol] of getNeighbors(cell.row, cell.col, config)) {
        const neighbor = board[neighborRow][neighborCol];
        if (neighbor.ownerId === null || neighbor.ownerId === cell.ownerId) continue;
        if (!isLoaded(neighbor, config)) continue;

        hostileLoadedNeighbor = true;
        if (neighbor.ownerId === playerId) loadedNeighborOfMine = true;
      }

      // Counted once per cell, not once per loaded neighbour — a cell can only
      // be taken once, and double-counting would make a crossfire look twice as
      // bad as it is.
      if (cell.ownerId === playerId) {
        if (hostileLoadedNeighbor) ownOrbsAtRisk += cell.count;
      } else if (loadedNeighborOfMine) {
        enemyOrbsThreatened += cell.count;
      }
    }
  }

  return { ownOrbsAtRisk, enemyOrbsThreatened };
}

function scoreMove(state: GameState, move: Move, balanceBefore: number): number {
  // Frames are for the UI to animate; the search only wants the resulting state.
  const next = applyMove(state, move).state;

  if (next.status === "finished") {
    return next.winnerId === move.playerId ? WIN_SCORE : -WIN_SCORE;
  }

  const { ownOrbsAtRisk, enemyOrbsThreatened } = measurePressure(next.board, next.config, move.playerId);
  const material = materialBalance(next.board, move.playerId) - balanceBefore;
  // 2 at a corner, 1 on an edge, 0 in the interior.
  const position = 4 - criticalMass(move.row, move.col, state.config);

  return (
    MATERIAL_WEIGHT * material +
    THREAT_WEIGHT * enemyOrbsThreatened -
    RISK_WEIGHT * ownOrbsAtRisk +
    POSITION_WEIGHT * position
  );
}

/**
 * Pick the greedy move for whoever is to play, or `null` when there is nothing
 * to pick — the match is over, the seat is eliminated, or the board is full.
 *
 * The returned move is always legal for the current player. Ties are broken
 * with the injected `random`, so equally good openings vary between matches
 * while a seeded test still gets the same answer every run.
 */
export function chooseGreedyMove(state: GameState, random: () => number): Move | null {
  if (state.status !== "playing") return null;

  const current = state.players[state.currentPlayerIndex];
  if (!current || current.isEliminated) return null;

  const candidates: Move[] = getValidMoves(state.board, current.id)
    .map((cell) => ({ playerId: current.id, row: cell.row, col: cell.col }))
    .filter((move) => isLegalMove(state, move));

  if (candidates.length === 0) return null;

  const balanceBefore = materialBalance(state.board, current.id);

  let bestScore = Number.NEGATIVE_INFINITY;
  let best: Move[] = [];

  for (const move of candidates) {
    const score = scoreMove(state, move, balanceBefore);

    if (score > bestScore + SCORE_EPSILON) {
      bestScore = score;
      best = [move];
    } else if (score > bestScore - SCORE_EPSILON) {
      best.push(move);
    }
  }

  // Clamped the same way `pickAutoMove` clamps, so an rng that returns exactly
  // 1 cannot index off the end.
  const index = Math.min(best.length - 1, Math.floor(random() * best.length));
  return best[index];
}

/**
 * Difficulty levels for a computer seat.
 *
 * The first three are one heuristic at three honesties. The greedy move wins
 * about 98% of games against random play, which makes it a poor default for
 * someone picking the game up, so rather than write separate opponents,
 * difficulty is expressed as how often the seat *declines* to play its best move
 * and plays a random legal one instead:
 *
 * - `easy` never plays the greedy move — it is the random auto-player, which is
 *   the same thing a timed-out human turn does.
 * - `normal` plays well most of the time and blunders often enough to be
 *   beatable by someone learning the game.
 * - `hard` is the greedy move every time.
 *
 * `expert` is the one that is genuinely a different opponent: the depth search
 * in `search.ts`, which reads several moves ahead instead of one. It was added
 * *beside* `hard` rather than replacing it, deliberately — someone who settled
 * on Hard should keep getting the opponent they are used to, and a difficulty
 * setting that silently gets stronger is a bad surprise, not a feature.
 */
export type AiDifficulty = "easy" | "normal" | "hard" | "expert";

export const AI_DIFFICULTIES: readonly AiDifficulty[] = ["easy", "normal", "hard", "expert"];

/** Probability of playing a random legal move instead of the best one. Not consulted for `expert`. */
const BLUNDER_CHANCE: Record<AiDifficulty, number> = {
  easy: 1,
  normal: 0.4,
  hard: 0,
  expert: 0
};

export function isAiDifficulty(value: unknown): value is AiDifficulty {
  return typeof value === "string" && (AI_DIFFICULTIES as readonly string[]).includes(value);
}

/**
 * Choose a move for a computer seat at the given difficulty.
 *
 * Randomness is injected, so a seeded test gets the same game every run and a
 * server could be the one rolling. Returns `null` when there is nothing to play.
 */
export function chooseAiMove(state: GameState, difficulty: AiDifficulty, random: () => number): Move | null {
  if (state.status !== "playing") return null;

  const current = state.players[state.currentPlayerIndex];
  if (!current || current.isEliminated) return null;

  // The only level that is not the one-ply heuristic. It reads ahead instead of
  // rolling, so it never touches the blunder table.
  if (difficulty === "expert") return chooseSearchMove(state, random);

  const blunderChance = BLUNDER_CHANCE[difficulty];

  // `hard` never blunders, so it skips the roll entirely rather than burning a
  // draw on a decision it cannot act on. That keeps a real guarantee — at
  // `hard`, this function IS `chooseGreedyMove`, same seed and same answer —
  // which is asserted in the tests and is worth more than every level happening
  // to consume the same number of random draws.
  if (blunderChance === 0) return chooseGreedyMove(state, random);

  if (random() < blunderChance) {
    const candidates = getValidMoves(state.board, current.id);
    if (candidates.length === 0) return null;
    const index = Math.min(candidates.length - 1, Math.floor(random() * candidates.length));
    return { playerId: current.id, row: candidates[index].row, col: candidates[index].col };
  }

  return chooseGreedyMove(state, random);
}
