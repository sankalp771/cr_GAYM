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
import type { Board, Cell, GameState, GridConfig, Move, PlayerId } from "./types";

/**
 * Scoring weights.
 *
 * The units are "orbs", so the weights say how many orbs of material each
 * consideration is worth. They are ordered by how decisive they are:
 *
 * - `WIN_SCORE` dominates everything, so a move that ends the match is always
 *   taken. Nothing else can add up to it.
 * - `MATERIAL_WEIGHT` is the main signal. Every move adds exactly one orb to
 *   the mover, and a capture also flips the victim's orbs, so capturing `k`
 *   orbs swings the balance by `1 + 2k` — a single-orb capture already scores
 *   12 here, comfortably above any positional term. That is what makes "reach
 *   critical mass next to a loaded enemy cell" the strongly preferred move
 *   without needing a special case for it: the capture shows up as material.
 * - `RISK_WEIGHT` outweighs `THREAT_WEIGHT` because the opponent moves next.
 *   Orbs parked beside an enemy cell that is one orb from exploding are orbs
 *   you are about to hand over; the mirror image is only a maybe.
 * - `POSITION_WEIGHT` is the tie-breaker. A corner needs 2 orbs to hold and an
 *   interior cell needs 4, so corners and edges are cheaper to keep and dearer
 *   to take. It is worth a few tenths of an orb, never enough to pass up a
 *   capture for.
 */
const WIN_SCORE = 1_000_000;
const MATERIAL_WEIGHT = 6;
const RISK_WEIGHT = 3;
const THREAT_WEIGHT = 1;
const POSITION_WEIGHT = 1.5;

/** Scores this close together count as equal, and the injected rng breaks the tie. */
const SCORE_EPSILON = 1e-9;

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
