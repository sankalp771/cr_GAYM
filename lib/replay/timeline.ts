/**
 * A replay flattened into one list of frames.
 *
 * The in-app viewer and the downloadable HTML both scrub a single array with a
 * duration on every entry, so a scrubber is an index and playback is a chain of
 * timeouts. Producing that array in one place is what keeps the two viewers
 * showing the same thing — the export is this list, serialised.
 */

import type { Board, GameState } from "@/lib/engine";
import { EMPTY_FLASH, type FlashSet } from "@/lib/cascade-animation";
import type { ReplayTimeline } from "./record";

/** A beat on the empty board before the opening move, so a replay does not start mid-air. */
export const OPENING_HOLD_MS = 600;

/** Added to a move's last frame so consecutive moves read as separate turns. */
export const BETWEEN_MOVES_MS = 340;

export type ReplayFrame = {
  board: Board;
  flash: FlashSet;
  /** Cells exploding on this frame — these get the particle burst. */
  burst: FlashSet;
  /** 1-based move this frame belongs to. 0 is the opening board. */
  moveNumber: number;
  durationMs: number;
  /**
   * The state to draw the chrome from: whose turn it reads as, the standings,
   * whether the match is over. Mid-cascade this is deliberately the state
   * *before* the move, so the mover is still named as the mover.
   */
  state: GameState;
  /** True for the winner's cosmetic flourish, which is not part of the game record. */
  isFinale: boolean;
};

export function flattenTimeline(timeline: ReplayTimeline): ReplayFrame[] {
  const frames: ReplayFrame[] = [
    {
      board: timeline.initial.board,
      flash: EMPTY_FLASH,
      burst: EMPTY_FLASH,
      moveNumber: 0,
      durationMs: OPENING_HOLD_MS,
      state: timeline.initial,
      isFinale: false
    }
  ];

  for (const move of timeline.moves) {
    for (const [index, step] of move.steps.entries()) {
      const isLastStep = index === move.steps.length - 1;
      frames.push({
        board: step.board,
        flash: step.flash,
        burst: step.burst,
        moveNumber: move.number,
        durationMs: (move.durations[index] ?? 60) + (isLastStep ? BETWEEN_MOVES_MS : 0),
        // Mid-cascade the mover is still the mover, so those frames carry the
        // state as it was before the move. The settled frame flips to the state
        // after it — that is the position, and the next seat is the one to move.
        state: isLastStep ? move.after : move.before,
        isFinale: false
      });
    }
  }

  if (timeline.finale) {
    const moveNumber = timeline.moves.length;
    for (const [index, step] of timeline.finale.steps.entries()) {
      frames.push({
        board: step.board,
        flash: step.flash,
        burst: step.burst,
        moveNumber,
        durationMs: timeline.finale.durations[index] ?? 60,
        state: timeline.final,
        isFinale: true
      });
    }
  }

  return frames;
}

/**
 * Frame index each move ends on, indexed by 1-based move number (slot 0 is the
 * opening board). This is what "step to the next move" jumps between — stepping
 * one cascade frame at a time would take hundreds of clicks to cross a match.
 *
 * The finale is excluded on purpose. Its frames carry the last move's number so
 * the counter does not tick past the end, and counting them here would drag that
 * move's boundary onto the emptied board — leaving no index that means "the
 * position the match actually finished in".
 */
export function moveBoundaries(frames: ReplayFrame[]): number[] {
  const boundaries: number[] = [];
  for (const [index, frame] of frames.entries()) {
    if (!frame.isFinale) boundaries[frame.moveNumber] = index;
  }
  return boundaries;
}
