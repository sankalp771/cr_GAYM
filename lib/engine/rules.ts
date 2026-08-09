import type { Board, Cell, GridConfig, PlayerId } from "./types";

/**
 * Board size presets. The product spec is explicit that the UI offers these five
 * and nothing else — no arbitrary board-size input.
 */
export const BOARD_PRESETS = {
  classic: { id: "classic", label: "Classic", size: 6 },
  large: { id: "large", label: "Large", size: 8 },
  hd: { id: "hd", label: "HD", size: 10 },
  xl: { id: "xl", label: "XL", size: 12 },
  xxl: { id: "xxl", label: "XXL", size: 14 }
} as const;

export type PresetId = keyof typeof BOARD_PRESETS;

/** Seconds a player has to move before the turn is auto-played. Part of the game's identity, not a tunable. */
export const TURN_SECONDS = 20;

export const PLAYER_COLORS = [
  "#ff5b8a",
  "#42f5d7",
  "#ffd54a",
  "#60a9ff",
  "#b583ff",
  "#ff9248",
  "#79ff6b",
  "#ff74f1"
] as const;

export function isInsideBoard(row: number, col: number, config: GridConfig) {
  return row >= 0 && col >= 0 && row < config.rows && col < config.cols;
}

/**
 * Orthogonal neighbours of a cell.
 *
 * The previous implementation derived the column bound from `board.length`,
 * which is the *row* count. That was invisible only because every preset is
 * square; it would have silently mis-scored a rectangular board. Bounds come
 * from the config now.
 */
export function getNeighbors(row: number, col: number, config: GridConfig): Array<[number, number]> {
  const neighbors: Array<[number, number]> = [];
  if (row > 0) neighbors.push([row - 1, col]);
  if (row < config.rows - 1) neighbors.push([row + 1, col]);
  if (col > 0) neighbors.push([row, col - 1]);
  if (col < config.cols - 1) neighbors.push([row, col + 1]);
  return neighbors;
}

/**
 * How many orbs a cell holds before it explodes: 2 at a corner, 3 on an edge,
 * 4 in the interior — i.e. its orthogonal neighbour count. A cell *reaching*
 * this number explodes, so a stable cell always holds at most `criticalMass - 1`.
 */
export function criticalMass(row: number, col: number, config: GridConfig): number {
  let mass = 0;
  if (row > 0) mass += 1;
  if (row < config.rows - 1) mass += 1;
  if (col > 0) mass += 1;
  if (col < config.cols - 1) mass += 1;
  return mass;
}

export function createEmptyBoard(config: GridConfig): Board {
  return Array.from({ length: config.rows }, (_, row) =>
    Array.from({ length: config.cols }, (_, col) => ({
      row,
      col,
      ownerId: null,
      count: 0
    }))
  );
}

export function cloneBoard(board: Board): Board {
  const rows = board.length;
  const next: Board = new Array(rows);
  for (let row = 0; row < rows; row += 1) {
    const source = board[row];
    const cols = source.length;
    const target: Cell[] = new Array(cols);
    for (let col = 0; col < cols; col += 1) {
      const cell = source[col];
      target[col] = { row: cell.row, col: cell.col, ownerId: cell.ownerId, count: cell.count };
    }
    next[row] = target;
  }
  return next;
}

/** A player may only play into an empty cell or one they already own. */
export function isCellPlayable(cell: Cell, playerId: PlayerId): boolean {
  return cell.ownerId === null || cell.ownerId === playerId;
}

export function countPlayerOrbs(board: Board, playerId: PlayerId): number {
  let total = 0;
  for (const row of board) {
    for (const cell of row) {
      if (cell.ownerId === playerId) total += cell.count;
    }
  }
  return total;
}

export function countTotalOrbs(board: Board): number {
  let total = 0;
  for (const row of board) {
    for (const cell of row) total += cell.count;
  }
  return total;
}

/**
 * Every player id currently holding at least one orb.
 *
 * The cascade loop leans on this: once it collapses to a single id, the match is
 * decided and there is no reason — and, on a saturated board, no way — to keep
 * resolving explosions.
 */
export function getOwnersWithOrbs(board: Board): PlayerId[] {
  const owners = new Set<PlayerId>();
  for (const row of board) {
    for (const cell of row) {
      if (cell.count > 0 && cell.ownerId !== null) owners.add(cell.ownerId);
    }
  }
  return [...owners];
}

export function getValidMoves(board: Board, playerId: PlayerId): Array<{ row: number; col: number }> {
  const moves: Array<{ row: number; col: number }> = [];
  for (const row of board) {
    for (const cell of row) {
      if (isCellPlayable(cell, playerId)) moves.push({ row: cell.row, col: cell.col });
    }
  }
  return moves;
}
