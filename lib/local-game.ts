export const TURN_SECONDS = 20;

export const BOARD_PRESETS = {
  classic: { id: "classic", label: "Classic", size: 6 },
  large: { id: "large", label: "Large", size: 8 },
  hd: { id: "hd", label: "HD", size: 10 },
  xl: { id: "xl", label: "XL", size: 12 },
  xxl: { id: "xxl", label: "XXL", size: 14 }
} as const;

export type PresetId = keyof typeof BOARD_PRESETS;

export type Player = {
  id: string;
  name: string;
  color: string;
  hasEnteredPlay: boolean;
  isEliminated: boolean;
};

export type Cell = {
  row: number;
  col: number;
  ownerId: string | null;
  count: number;
  flashTick: number;
};

export const PLAYER_COLORS = [
  "#ff5b8a",
  "#42f5d7",
  "#ffd54a",
  "#60a9ff",
  "#b583ff",
  "#ff9248",
  "#79ff6b",
  "#ff74f1"
];

export function createEmptyBoard(size: number): Cell[][] {
  return Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, col) => ({
      row,
      col,
      ownerId: null,
      count: 0,
      flashTick: 0
    }))
  );
}

export function getNeighbors(board: Cell[][], row: number, col: number): Array<[number, number]> {
  const neighbors: Array<[number, number]> = [];
  if (row > 0) neighbors.push([row - 1, col]);
  if (row < board.length - 1) neighbors.push([row + 1, col]);
  if (col > 0) neighbors.push([row, col - 1]);
  if (col < board.length - 1) neighbors.push([row, col + 1]);
  return neighbors;
}

export function getCriticalMass(board: Cell[][], row: number, col: number) {
  return getNeighbors(board, row, col).length;
}

export function cloneBoard(board: Cell[][]) {
  return board.map((row) => row.map((cell) => ({ ...cell })));
}

export function isCellPlayable(cell: Cell, playerId: string) {
  return cell.ownerId === null || cell.ownerId === playerId;
}

export function applyMove(board: Cell[][], playerId: string, row: number, col: number) {
  const nextBoard = cloneBoard(board);
  const touchedCells = new Set([`${row}:${col}`]);

  nextBoard[row][col].ownerId = playerId;
  nextBoard[row][col].count += 1;

  while (true) {
    const unstableCells: Array<{ row: number; col: number }> = [];

    nextBoard.forEach((boardRow) => {
      boardRow.forEach((cell) => {
        if (cell.count >= getCriticalMass(nextBoard, cell.row, cell.col)) {
          unstableCells.push({ row: cell.row, col: cell.col });
        }
      });
    });

    if (unstableCells.length === 0) {
      break;
    }

    unstableCells.forEach((unstableCell) => {
      const cell = nextBoard[unstableCell.row][unstableCell.col];
      const criticalMass = getCriticalMass(nextBoard, unstableCell.row, unstableCell.col);

      cell.count -= criticalMass;
      cell.ownerId = cell.count === 0 ? null : playerId;

      getNeighbors(nextBoard, unstableCell.row, unstableCell.col).forEach(([neighborRow, neighborCol]) => {
        const neighborCell = nextBoard[neighborRow][neighborCol];
        neighborCell.ownerId = playerId;
        neighborCell.count += 1;
        touchedCells.add(`${neighborRow}:${neighborCol}`);
      });
    });
  }

  const flashTick = Date.now();
  touchedCells.forEach((key) => {
    const [cellRow, cellCol] = key.split(":").map(Number);
    nextBoard[cellRow][cellCol].flashTick = flashTick;
  });

  return nextBoard;
}

export function countPlayerOrbs(board: Cell[][], playerId: string) {
  return board.reduce(
    (sum, row) => sum + row.reduce((rowSum, cell) => rowSum + (cell.ownerId === playerId ? cell.count : 0), 0),
    0
  );
}

export function getValidMoves(board: Cell[][], playerId: string) {
  return board.flatMap((row) =>
    row.filter((cell) => isCellPlayable(cell, playerId)).map((cell) => ({ row: cell.row, col: cell.col }))
  );
}
