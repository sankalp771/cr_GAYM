/**
 * The cosmetic end-of-match finale.
 *
 * This lives beside `cascade-animation.ts` rather than inside the arena because
 * three surfaces now need it: the live match, the in-app replay viewer, and the
 * standalone HTML a player downloads. It is presentation, not rules, so it stays
 * out of `lib/engine/` — but it is deterministic and DOM-free like everything it
 * sits next to.
 */

import type { Board, Cell } from "@/lib/engine";
import { cellKey, EMPTY_FLASH, stepDurations, type AnimationStep } from "@/lib/cascade-animation";

/** Budgets for the two waves of the finale. */
export const FINALE_CLAIM_BUDGET_MS = 900;
export const FINALE_BLAST_BUDGET_MS = 1300;

/**
 * Cosmetic end-of-match finale.
 *
 * The engine stops a decided cascade the instant one player holds every orb.
 * That is not an optimisation: orbs are conserved and the grid has no sink, so a
 * board above its own stable capacity has *no* resting configuration and the
 * reaction would run forever. The cost is that the final board is frozen
 * mid-reaction, with cells sitting at or above critical mass looking as though
 * they jammed.
 *
 * So the ending is played out for the eye instead. Two waves, radiating from the
 * deciding move: the winner claims the board, then the whole thing goes off.
 *
 * It never touches game state — the engine's final state is already final and
 * this only drives what is drawn. Rings are Manhattan distance because that is
 * the way orbs actually travel, so the flourish moves like a real cascade rather
 * than a row-major wipe.
 */
export function buildVictoryFinale(
  board: Board,
  winnerId: string,
  origin: { row: number; col: number }
): { steps: AnimationStep[]; durations: number[] } {
  const working = board.map((row) => row.map((cell) => ({ ...cell })));
  const occupied = working.flat().filter((cell) => cell.count > 0);
  if (occupied.length === 0) return { steps: [], durations: [] };

  const byDistance = new Map<number, Cell[]>();
  for (const cell of occupied) {
    const distance = Math.abs(cell.row - origin.row) + Math.abs(cell.col - origin.col);
    const ring = byDistance.get(distance);
    if (ring) ring.push(cell);
    else byDistance.set(distance, [cell]);
  }

  const rings = [...byDistance.keys()].sort((a, b) => a - b).map((distance) => byDistance.get(distance)!);
  const snapshot = () => working.map((row) => row.map((cell) => ({ ...cell })));
  const keysOf = (ring: Cell[]) => new Set(ring.map((cell) => cellKey(cell.row, cell.col)));

  const claim: AnimationStep[] = rings.map((ring) => {
    for (const cell of ring) working[cell.row][cell.col].ownerId = winnerId;
    return { board: snapshot(), flash: keysOf(ring), burst: EMPTY_FLASH, exploded: false };
  });

  const blast: AnimationStep[] = rings.map((ring) => {
    // The owner is left in place on an emptied cell on purpose. This board is for
    // display only, and the burst particles inherit `--player-color` from the
    // cell — clearing the owner too would drop them back to the default cyan
    // instead of the winner's colour.
    for (const cell of ring) working[cell.row][cell.col].count = 0;
    return { board: snapshot(), flash: EMPTY_FLASH, burst: keysOf(ring), exploded: true };
  });

  return {
    steps: [...claim, ...blast],
    durations: [
      ...stepDurations(claim.length, FINALE_CLAIM_BUDGET_MS),
      ...stepDurations(blast.length, FINALE_BLAST_BUDGET_MS)
    ]
  };
}
