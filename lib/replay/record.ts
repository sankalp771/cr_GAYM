/**
 * What a finished match is saved as.
 *
 * A record is **only the move list**. Everything a viewer draws — every cascade
 * frame, every elimination, the winner — is re-derived by running those moves
 * back through `lib/engine`, which is the same thing the multiplayer client
 * already does to animate a broadcast move. That is only possible because the
 * engine is deterministic, and it is the reason a replay cannot drift from the
 * game: there is no second copy of the rules to disagree with.
 *
 * It also keeps the file small. A 14x14 eight-player match is a few kilobytes of
 * moves; the frames it expands to are megabytes.
 *
 * This module is clock-free and DOM-free for the same reason the engine is —
 * `recordedAt` is stamped by the caller.
 */

import {
  applyMove,
  BOARD_PRESETS,
  createInitialState,
  EngineError,
  isLegalMove,
  type GameState,
  type GridConfig,
  type Player,
  type PlayerId
} from "@/lib/engine";
import { framesToSteps, stepDurations, type AnimationStep } from "@/lib/cascade-animation";
import { buildVictoryFinale } from "@/lib/victory-finale";

/** Bumped only when an old file would be read wrongly by the current reader. */
export const REPLAY_FORMAT_VERSION = 1;

export type RecordedMove = {
  playerId: PlayerId;
  row: number;
  col: number;
  /** True when the turn timer played it — locally the arena, online the server. */
  auto: boolean;
};

export type RecordedPlayer = {
  id: PlayerId;
  name: string;
  color: string;
  /** The seat tag as it read during the match: "CPU" locally, "HOST" online. */
  badge?: string;
};

export type MatchRecord = {
  version: number;
  mode: "local" | "online";
  config: GridConfig;
  players: RecordedPlayer[];
  moves: RecordedMove[];
  winnerId: PlayerId | null;
  /** Epoch ms, supplied by the caller. Null when it was not recorded. */
  recordedAt: number | null;
  roomCode?: string;
};

export type ReplayMove = {
  /** 1-based, the number a viewer counts. */
  number: number;
  playerId: PlayerId;
  row: number;
  col: number;
  auto: boolean;
  /** The position as the move was played — whose turn it read as, and the standings then. */
  before: GameState;
  after: GameState;
  steps: AnimationStep[];
  durations: number[];
};

export type ReplayTimeline = {
  config: GridConfig;
  players: Player[];
  initial: GameState;
  moves: ReplayMove[];
  /** The winner's flourish, replayed exactly as the arena played it. Null when nobody won. */
  finale: { steps: AnimationStep[]; durations: number[] } | null;
  final: GameState;
  /**
   * The 1-based move where replay stopped early, or null when the whole record
   * played. Non-null means the file is truncated or was tampered with; the
   * viewer shows what it could reach rather than refusing outright.
   */
  truncatedAt: number | null;
};

export function buildRecord(input: {
  mode: "local" | "online";
  config: GridConfig;
  players: RecordedPlayer[];
  moves: RecordedMove[];
  winnerId: PlayerId | null;
  recordedAt: number | null;
  roomCode?: string;
}): MatchRecord {
  return {
    version: REPLAY_FORMAT_VERSION,
    mode: input.mode,
    config: input.config,
    players: input.players.map((player) => ({ ...player })),
    moves: input.moves.map((move) => ({ ...move })),
    winnerId: input.winnerId,
    recordedAt: input.recordedAt,
    ...(input.roomCode ? { roomCode: input.roomCode } : {})
  };
}

function enginePlayers(players: RecordedPlayer[]): Player[] {
  return players.map((player) => ({
    id: player.id,
    name: player.name,
    color: player.color,
    hasEnteredPlay: false,
    isEliminated: false
  }));
}

/**
 * Run a record back through the engine.
 *
 * Every frame the viewer shows comes out of this, so an animated replay is the
 * real game re-played rather than a recording of one.
 */
export function expandRecord(record: MatchRecord): ReplayTimeline {
  const initial = createInitialState(record.config, enginePlayers(record.players));

  const moves: ReplayMove[] = [];
  let state = initial;
  let truncatedAt: number | null = null;

  for (const [index, recorded] of record.moves.entries()) {
    const move = { playerId: recorded.playerId, row: recorded.row, col: recorded.col };
    if (state.status !== "playing" || !isLegalMove(state, move)) {
      truncatedAt = index + 1;
      break;
    }

    let result;
    try {
      result = applyMove(state, move, { recordFrames: true });
    } catch (error) {
      // Only reachable on a corrupt file — `isLegalMove` above already cleared it.
      if (!(error instanceof EngineError)) throw error;
      truncatedAt = index + 1;
      break;
    }

    const steps = framesToSteps(result.frames);
    moves.push({
      number: index + 1,
      playerId: recorded.playerId,
      row: recorded.row,
      col: recorded.col,
      auto: recorded.auto,
      before: state,
      after: result.state,
      steps,
      durations: stepDurations(steps.length)
    });

    state = result.state;
  }

  const last = moves.at(-1);
  const finale =
    state.status === "finished" && state.winnerId && last
      ? buildVictoryFinale(state.board, state.winnerId, { row: last.row, col: last.col })
      : null;

  return {
    config: record.config,
    players: initial.players,
    initial,
    moves,
    finale: finale && finale.steps.length > 0 ? finale : null,
    final: state,
    truncatedAt
  };
}

/** `"Classic (6x6)"` when the board matches a preset, `"9x14"` when it does not. */
export function describeBoard(config: GridConfig): string {
  const preset = Object.values(BOARD_PRESETS).find(
    (entry) => entry.size === config.rows && entry.size === config.cols
  );
  return preset ? `${preset.label} (${config.rows}x${config.cols})` : `${config.rows}x${config.cols}`;
}

export function serializeRecord(record: MatchRecord): string {
  return JSON.stringify(record);
}

const isFiniteInt = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value);

/**
 * Read a record back.
 *
 * Returns null rather than throwing on anything it does not recognise: this
 * parses a file a player may have edited, and a viewer that throws on bad input
 * is a viewer that shows a blank page.
 */
export function parseRecord(raw: string): MatchRecord | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;
  const candidate = parsed as Partial<MatchRecord>;

  if (candidate.version !== REPLAY_FORMAT_VERSION) return null;
  if (candidate.mode !== "local" && candidate.mode !== "online") return null;

  const config = candidate.config;
  if (!config || !isFiniteInt(config.rows) || !isFiniteInt(config.cols)) return null;
  if (config.rows < 2 || config.cols < 2) return null;

  if (!Array.isArray(candidate.players) || candidate.players.length < 2) return null;
  const players: RecordedPlayer[] = [];
  for (const player of candidate.players) {
    if (typeof player?.id !== "string" || typeof player?.name !== "string") return null;
    if (typeof player?.color !== "string") return null;
    players.push({
      id: player.id,
      name: player.name,
      color: player.color,
      ...(typeof player.badge === "string" ? { badge: player.badge } : {})
    });
  }

  if (!Array.isArray(candidate.moves)) return null;
  const moves: RecordedMove[] = [];
  for (const move of candidate.moves) {
    if (typeof move?.playerId !== "string" || !isFiniteInt(move?.row) || !isFiniteInt(move?.col)) return null;
    moves.push({ playerId: move.playerId, row: move.row, col: move.col, auto: move.auto === true });
  }

  return {
    version: REPLAY_FORMAT_VERSION,
    mode: candidate.mode,
    config: { rows: config.rows, cols: config.cols },
    players,
    moves,
    winnerId: typeof candidate.winnerId === "string" ? candidate.winnerId : null,
    recordedAt: isFiniteInt(candidate.recordedAt) ? candidate.recordedAt : null,
    ...(typeof candidate.roomCode === "string" ? { roomCode: candidate.roomCode } : {})
  };
}
