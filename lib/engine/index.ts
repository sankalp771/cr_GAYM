/**
 * Public surface of the game engine.
 *
 * Everything here is pure and framework-free — see `types.ts`. Import from
 * `@/lib/engine`, never from the individual modules, so the boundary stays a
 * single reviewable seam as multiplayer and AI start consuming it.
 */

export {
  applyMove,
  checkWinner,
  createInitialState,
  isLegalMove,
  nextLivingPlayerIndex,
  pickAutoMove,
  resolveCascade
} from "./engine";
export type { ApplyMoveOptions } from "./engine";

export {
  BOARD_PRESETS,
  PLAYER_COLORS,
  TURN_SECONDS,
  cloneBoard,
  countPlayerOrbs,
  countTotalOrbs,
  createEmptyBoard,
  criticalMass,
  getNeighbors,
  getOwnersWithOrbs,
  getValidMoves,
  isCellPlayable,
  isInsideBoard
} from "./rules";
export type { PresetId } from "./rules";

export { EngineError } from "./types";
export type {
  Board,
  CascadeFrame,
  Cell,
  GameState,
  GameStatus,
  GridConfig,
  Move,
  MoveResult,
  Player,
  PlayerId
} from "./types";
