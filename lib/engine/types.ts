/**
 * Core game types.
 *
 * This module — and everything else under `lib/engine/` — is pure: no React, no
 * DOM, no timers, no randomness, no I/O. The same code is meant to run in the
 * browser, in Node tests, and later inside an authoritative multiplayer server,
 * so it must never reach for anything only one of those environments has.
 * `eslint.config.mjs` enforces this mechanically.
 */

export type PlayerId = string;

/** Board geometry. Rectangular boards are supported even though every shipped preset is square. */
export type GridConfig = {
  rows: number;
  cols: number;
};

export type Cell = {
  row: number;
  col: number;
  ownerId: PlayerId | null;
  /** Number of orbs sitting in this cell. Always < criticalMass when the board is stable. */
  count: number;
};

export type Board = Cell[][];

/**
 * The redundant, non-colour channel for player identity. See `PLAYER_SHAPES`.
 */
export type PlayerShape = "circle" | "diamond" | "triangle" | "square" | "hexagon" | "star" | "pentagon" | "cross";

export type Player = {
  id: PlayerId;
  name: string;
  color: string;
  /** Paired with `color` so identity never depends on hue alone. */
  shape: PlayerShape;
  /**
   * Set once the player has actually taken a turn. Elimination is gated on this
   * so that a player who simply has not moved yet is never mistaken for a player
   * who has been wiped off the board.
   */
  hasEnteredPlay: boolean;
  isEliminated: boolean;
};

export type Move = {
  playerId: PlayerId;
  row: number;
  col: number;
};

export type GameStatus = "playing" | "finished";

export type GameState = {
  config: GridConfig;
  board: Board;
  players: Player[];
  currentPlayerIndex: number;
  /** Total moves played this match. Also equals the total orbs on the board, since explosions conserve orbs. */
  moveCount: number;
  status: GameStatus;
  winnerId: PlayerId | null;
};

/**
 * One step of a chain reaction, for the UI to animate.
 *
 * Frames carry *what changed* rather than a wall-clock timestamp, so the engine
 * stays deterministic and the same move always produces the same frames. The UI
 * derives animation timing from the frame index.
 */
export type CascadeFrame = {
  board: Board;
  /** Cells that exploded on this step. */
  exploded: Array<{ row: number; col: number }>;
  /** Cells that received an orb from an explosion on this step. */
  received: Array<{ row: number; col: number }>;
};

export type MoveResult = {
  state: GameState;
  frames: CascadeFrame[];
  /**
   * True when the cascade was cut short because the match was already decided
   * mid-reaction. See `resolveCascade` — without this, a winning move can spin
   * forever, because orbs are conserved and a single-owner board above its own
   * stable capacity has no resting state to reach.
   */
  endedMidCascade: boolean;
  /** True when frame recording hit its ceiling and the tail was resolved without frames. */
  framesTruncated: boolean;
};

export class EngineError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EngineError";
  }
}
