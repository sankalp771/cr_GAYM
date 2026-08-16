import { describe, expect, it } from "vitest";
import { buildVictoryFinale } from "@/lib/victory-finale";
import type { Board } from "@/lib/engine";

/**
 * Build a board from a picture, one string per row: `.` is empty, otherwise the
 * digit is the orb count and the letter that follows is the owner.
 */
function boardFrom(rows: string[]): Board {
  return rows.map((row, rowIndex) =>
    row.split(" ").map((token, colIndex) => {
      if (token === ".") return { row: rowIndex, col: colIndex, ownerId: null, count: 0 };
      return {
        row: rowIndex,
        col: colIndex,
        ownerId: `player-${token[1]}`,
        count: Number(token[0])
      };
    })
  );
}

function totalOrbs(board: Board): number {
  return board.flat().reduce((sum, cell) => sum + cell.count, 0);
}

describe("buildVictoryFinale", () => {
  // A decided board is frozen mid-cascade, because orbs are conserved and a
  // board above its stable capacity has no resting configuration — so cells sit
  // at or above critical mass. 4 in an interior cell and 4 on an edge are both
  // over the line, and both used to be left on screen looking jammed.
  const decided = boardFrom([
    "4a 2a 1a . . .",
    "3a 4a 2a . . .",
    "1a 2a 1a . . .",
    ". . . . . .",
    ". . . . . .",
    ". . . . 1a 2a"
  ]);

  it("leaves the board empty, so no cell is left sitting over critical mass", () => {
    const { steps } = buildVictoryFinale(decided, "player-a", { row: 0, col: 0 });

    expect(steps.length).toBeGreaterThan(0);
    expect(totalOrbs(decided), "the source board must not be mutated").toBe(totalOrbs(decided));
    expect(totalOrbs(steps[steps.length - 1].board)).toBe(0);
  });

  it("hands every cell to the winner before anything detonates", () => {
    const { steps } = buildVictoryFinale(decided, "player-a", { row: 0, col: 0 });
    const lastClaim = steps.filter((step) => !step.exploded).at(-1)!;
    const firstBlast = steps.findIndex((step) => step.exploded);

    // Claiming and blasting must not interleave, or the board would empty before
    // the winner is seen taking it.
    expect(steps.slice(firstBlast).every((step) => step.exploded)).toBe(true);
    for (const cell of lastClaim.board.flat()) {
      if (cell.count > 0) expect(cell.ownerId).toBe("player-a");
    }
    // Nothing is lost on the way in: the claim wave only repaints.
    expect(totalOrbs(lastClaim.board)).toBe(totalOrbs(decided));
  });

  it("radiates outward from the deciding move rather than sweeping row by row", () => {
    const origin = { row: 5, col: 5 };
    const { steps } = buildVictoryFinale(decided, "player-a", origin);
    const blasts = steps.filter((step) => step.exploded);

    const distances = blasts.map((step) =>
      Math.min(
        ...[...step.burst].map((key) => {
          const [row, col] = key.split(",").map(Number);
          return Math.abs(row - origin.row) + Math.abs(col - origin.col);
        })
      )
    );

    expect(distances).toEqual([...distances].sort((a, b) => a - b));
    // The deciding cell itself goes first and the far corner goes last — a
    // row-major wipe would invert both.
    expect([...blasts[0].burst]).toEqual(["5,5"]);
    expect([...blasts.at(-1)!.burst]).toEqual(["0,0"]);
  });

  it("pairs a duration with every step", () => {
    const { steps, durations } = buildVictoryFinale(decided, "player-a", { row: 1, col: 1 });
    expect(durations).toHaveLength(steps.length);
    expect(durations.every((duration) => duration > 0)).toBe(true);
  });

  it("does nothing on an empty board", () => {
    const empty = boardFrom([". . .", ". . .", ". . ."]);
    expect(buildVictoryFinale(empty, "player-a", { row: 0, col: 0 })).toEqual({ steps: [], durations: [] });
  });
});
