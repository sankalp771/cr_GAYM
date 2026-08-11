/**
 * Turning a resolved move into something to watch.
 *
 * Shared by local play and by online play. Online, the server never sends
 * animation frames — a long cascade is hundreds of full board clones — so the
 * client replays the move through its own copy of the engine and produces the
 * frames itself. That only works because the engine is deterministic, and it
 * means both modes must animate from the same code or they would drift into
 * looking like different games.
 */

import type { Board, CascadeFrame } from "@/lib/engine";

export type FlashSet = ReadonlySet<string>;

export const EMPTY_FLASH: FlashSet = new Set<string>();

export const cellKey = (row: number, col: number) => `${row},${col}`;

export type AnimationStep = {
  board: Board;
  flash: FlashSet;
  /** Cells that exploded on this step — these get the particle burst. */
  burst: FlashSet;
  exploded: boolean;
};

/**
 * Cascade pacing. A fixed step made short reactions sluggish and long ones
 * interminable, so the reaction gets a rough budget and the step shrinks as it
 * lengthens, easing out so the opening steps read before it accelerates.
 */
export const CASCADE_BUDGET_MS = 2200;
export const MAX_STEP_MS = 165;
export const MIN_STEP_MS = 45;

export function stepDurations(count: number, budgetMs = CASCADE_BUDGET_MS): number[] {
  if (count <= 0) return [];

  const flat = Math.min(MAX_STEP_MS, Math.max(MIN_STEP_MS, budgetMs / count));

  return Array.from({ length: count }, (_, index) => {
    const progress = count === 1 ? 0 : index / (count - 1);
    return Math.max(MIN_STEP_MS, flat * (1.25 - 0.5 * progress));
  });
}

/** Engine cascade frames as animation steps. */
export function framesToSteps(frames: CascadeFrame[]): AnimationStep[] {
  return frames.map((frame) => ({
    board: frame.board,
    flash: new Set([
      ...frame.exploded.map((cell) => cellKey(cell.row, cell.col)),
      ...frame.received.map((cell) => cellKey(cell.row, cell.col))
    ]),
    burst: new Set(frame.exploded.map((cell) => cellKey(cell.row, cell.col))),
    exploded: frame.exploded.length > 0
  }));
}
