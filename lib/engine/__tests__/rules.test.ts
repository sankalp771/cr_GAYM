import { describe, expect, it } from "vitest";
import { createEmptyBoard, criticalMass, getNeighbors, getValidMoves, isCellPlayable } from "../rules";
import type { GridConfig } from "../types";

const standard: GridConfig = { rows: 6, cols: 6 };

describe("criticalMass", () => {
  it("is 2 at every corner", () => {
    expect(criticalMass(0, 0, standard)).toBe(2);
    expect(criticalMass(0, 5, standard)).toBe(2);
    expect(criticalMass(5, 0, standard)).toBe(2);
    expect(criticalMass(5, 5, standard)).toBe(2);
  });

  it("is 3 along an edge", () => {
    expect(criticalMass(0, 3, standard)).toBe(3);
    expect(criticalMass(5, 3, standard)).toBe(3);
    expect(criticalMass(3, 0, standard)).toBe(3);
    expect(criticalMass(3, 5, standard)).toBe(3);
  });

  it("is 4 in the interior", () => {
    expect(criticalMass(1, 1, standard)).toBe(4);
    expect(criticalMass(3, 4, standard)).toBe(4);
  });

  it("always equals the orthogonal neighbour count", () => {
    for (let row = 0; row < standard.rows; row += 1) {
      for (let col = 0; col < standard.cols; col += 1) {
        expect(criticalMass(row, col, standard)).toBe(getNeighbors(row, col, standard).length);
      }
    }
  });

  it("uses the column bound for columns on a rectangular board", () => {
    // Regression: the original derived the column bound from the row count, so a
    // non-square board scored its edges wrongly. Invisible while every preset was
    // square, but wrong the moment one is not.
    const wide: GridConfig = { rows: 3, cols: 7 };
    expect(criticalMass(0, 6, wide)).toBe(2); // top-right corner
    expect(criticalMass(1, 6, wide)).toBe(3); // right edge
    expect(criticalMass(1, 3, wide)).toBe(4); // interior
  });
});

describe("move legality", () => {
  it("allows empty cells and own cells, rejects opponent cells", () => {
    const board = createEmptyBoard(standard);
    expect(isCellPlayable(board[0][0], "p1")).toBe(true);

    board[0][0].ownerId = "p1";
    board[0][0].count = 1;
    expect(isCellPlayable(board[0][0], "p1")).toBe(true);
    expect(isCellPlayable(board[0][0], "p2")).toBe(false);
  });

  it("lists every cell as valid on an empty board", () => {
    expect(getValidMoves(createEmptyBoard(standard), "p1")).toHaveLength(36);
  });
});
