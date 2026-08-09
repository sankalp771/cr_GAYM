import {
  cloneBoard,
  countPlayerOrbs,
  createEmptyBoard,
  criticalMass,
  getNeighbors,
  getOwnersWithOrbs,
  getValidMoves,
  isCellPlayable
} from "./rules";
import { EngineError } from "./types";
import type { Board, CascadeFrame, GameState, GridConfig, Move, MoveResult, Player, PlayerId } from "./types";

/**
 * Absolute ceiling on cascade passes.
 *
 * This is a defensive invariant, not a game rule — the single-owner check below
 * is what actually stops a runaway reaction. A legitimate cascade settles in
 * tens of passes even on a 14x14 board, so if this ever trips, something is
 * genuinely wrong and a loud error beats a frozen tab.
 */
const MAX_CASCADE_PASSES = 100_000;

/**
 * Cap on recorded animation frames. Beyond this the cascade still resolves
 * correctly, it just stops recording and the UI snaps to the result. Without a
 * cap, a long reaction allocates a full board clone per step and can exhaust
 * memory before it finishes.
 */
const DEFAULT_MAX_FRAMES = 400;

export type ApplyMoveOptions = {
  /** Record per-step frames for animation. Off by default: the AI search does not want the allocations. */
  recordFrames?: boolean;
  maxFrames?: number;
};

export function createInitialState(config: GridConfig, players: Player[]): GameState {
  if (players.length < 2) {
    throw new EngineError("A match needs at least two players.");
  }
  if (config.rows < 2 || config.cols < 2) {
    throw new EngineError("A board must be at least 2x2.");
  }

  return {
    config,
    board: createEmptyBoard(config),
    players: players.map((player) => ({ ...player, hasEnteredPlay: false, isEliminated: false })),
    currentPlayerIndex: 0,
    moveCount: 0,
    status: "playing",
    winnerId: null
  };
}

export function isLegalMove(state: GameState, move: Move): boolean {
  if (state.status !== "playing") return false;

  const current = state.players[state.currentPlayerIndex];
  if (!current || current.id !== move.playerId) return false;
  if (current.isEliminated) return false;

  const { rows, cols } = state.config;
  if (move.row < 0 || move.col < 0 || move.row >= rows || move.col >= cols) return false;

  return isCellPlayable(state.board[move.row][move.col], move.playerId);
}

/**
 * Resolve every unstable cell on a board until it settles.
 *
 * Two things make this loop non-trivial:
 *
 * 1. Orbs are perfectly conserved — an explosion removes `criticalMass` orbs
 *    from a cell and hands exactly that many to its neighbours, and the grid has
 *    no sink. So a board holding more orbs than its stable capacity has *no*
 *    resting configuration and the naive loop never terminates. Measured on the
 *    previous implementation: 93% of random 6x6 two-player games reached such a
 *    state and hung the browser tab, always at the moment somebody won.
 *
 * 2. That state is exactly a won game. Once every orb belongs to one player
 *    there is no opponent left to convert, so the reaction is pointless as well
 *    as endless. Stopping there is both the fix and the correct rule.
 *
 * The single-owner check is gated on every player having entered play, so an
 * opening move — where only the first player owns anything — is not mistaken
 * for a victory.
 */
function resolveBoardInPlace(
  board: Board,
  config: GridConfig,
  allPlayersEntered: boolean,
  frames: CascadeFrame[] | null,
  maxFrames: number
): { endedMidCascade: boolean; framesTruncated: boolean } {
  let framesTruncated = false;

  for (let pass = 0; pass < MAX_CASCADE_PASSES; pass += 1) {
    const exploding: Array<{ row: number; col: number; owner: PlayerId | null; mass: number }> = [];

    for (const row of board) {
      for (const cell of row) {
        const mass = criticalMass(cell.row, cell.col, config);
        if (cell.count >= mass) {
          exploding.push({ row: cell.row, col: cell.col, owner: cell.ownerId, mass });
        }
      }
    }

    if (exploding.length === 0) {
      return { endedMidCascade: false, framesTruncated };
    }

    // Every cell that explodes in a pass is drained by exactly its own critical
    // mass and its neighbours each gain one. Collecting the pass first and
    // applying it as a unit keeps the reaction order-independent and reads on
    // screen as a simultaneous chain rather than a sequential crawl.
    const received: Array<{ row: number; col: number }> = [];

    for (const source of exploding) {
      const cell = board[source.row][source.col];
      cell.count -= source.mass;
      if (cell.count === 0) cell.ownerId = null;

      for (const [neighborRow, neighborCol] of getNeighbors(source.row, source.col, config)) {
        const neighbor = board[neighborRow][neighborCol];
        neighbor.count += 1;
        neighbor.ownerId = source.owner;
        received.push({ row: neighborRow, col: neighborCol });
      }
    }

    if (frames) {
      if (frames.length < maxFrames) {
        frames.push({
          board: cloneBoard(board),
          exploded: exploding.map(({ row, col }) => ({ row, col })),
          received
        });
      } else {
        framesTruncated = true;
      }
    }

    // The match can be decided part-way through a reaction; see the note above.
    if (allPlayersEntered && getOwnersWithOrbs(board).length <= 1) {
      return { endedMidCascade: true, framesTruncated };
    }
  }

  throw new EngineError(
    `Cascade failed to settle within ${MAX_CASCADE_PASSES} passes. This should be unreachable — ` +
      "the single-owner guard is expected to stop a runaway reaction long before this."
  );
}

/** Resolve an already-placed, possibly unstable board. Exposed for callers that build state by hand. */
export function resolveCascade(state: GameState): GameState {
  const board = cloneBoard(state.board);
  const allPlayersEntered = state.players.every((player) => player.hasEnteredPlay);
  resolveBoardInPlace(board, state.config, allPlayersEntered, null, 0);
  return { ...state, board };
}

export function applyMove(state: GameState, move: Move, options: ApplyMoveOptions = {}): MoveResult {
  if (!isLegalMove(state, move)) {
    throw new EngineError(`Illegal move: ${move.playerId} cannot play ${move.row},${move.col}.`);
  }

  const { recordFrames = false, maxFrames = DEFAULT_MAX_FRAMES } = options;
  const board = cloneBoard(state.board);
  const frames: CascadeFrame[] | null = recordFrames ? [] : null;

  // The acting player has now entered play, which is what unlocks both
  // elimination and the mid-cascade victory check for this move.
  const players = state.players.map((player) =>
    player.id === move.playerId ? { ...player, hasEnteredPlay: true } : { ...player }
  );
  const allPlayersEntered = players.every((player) => player.hasEnteredPlay);

  const placed = board[move.row][move.col];
  placed.count += 1;
  placed.ownerId = move.playerId;

  if (frames) {
    frames.push({
      board: cloneBoard(board),
      exploded: [],
      received: [{ row: move.row, col: move.col }]
    });
  }

  const { endedMidCascade, framesTruncated } = resolveBoardInPlace(
    board,
    state.config,
    allPlayersEntered,
    frames,
    maxFrames
  );

  const moveCount = state.moveCount + 1;

  // A player is only out once they have actually played and then lost every orb.
  // Gating on "every player has entered play" is what stops player 2 being
  // declared eliminated before their opening move — the classic Chain Reaction bug.
  if (allPlayersEntered) {
    for (const player of players) {
      if (player.hasEnteredPlay && !player.isEliminated && countPlayerOrbs(board, player.id) === 0) {
        player.isEliminated = true;
      }
    }
  }

  const survivors = players.filter((player) => !player.isEliminated);
  const decided = allPlayersEntered && survivors.length === 1;

  if (decided || endedMidCascade) {
    const winnerId = survivors.length >= 1 ? survivors[0].id : move.playerId;
    for (const player of players) {
      if (player.id !== winnerId) player.isEliminated = true;
    }

    return {
      state: {
        ...state,
        board,
        players,
        moveCount,
        status: "finished",
        winnerId
      },
      frames: frames ?? [],
      endedMidCascade,
      framesTruncated
    };
  }

  return {
    state: {
      ...state,
      board,
      players,
      moveCount,
      currentPlayerIndex: nextLivingPlayerIndex(players, state.currentPlayerIndex),
      status: "playing",
      winnerId: null
    },
    frames: frames ?? [],
    endedMidCascade,
    framesTruncated
  };
}

export function nextLivingPlayerIndex(players: Player[], fromIndex: number): number {
  for (let step = 1; step <= players.length; step += 1) {
    const candidate = (fromIndex + step) % players.length;
    if (!players[candidate].isEliminated) return candidate;
  }
  return fromIndex;
}

export function checkWinner(state: GameState): Player | null {
  if (state.winnerId === null) return null;
  return state.players.find((player) => player.id === state.winnerId) ?? null;
}

/**
 * Pick the auto-play move for a timed-out turn.
 *
 * The randomness is injected rather than taken from `Math.random`, so the engine
 * stays deterministic and testable — and so an authoritative server can be the
 * one that rolls the dice, as the architecture doc requires.
 */
export function pickAutoMove(state: GameState, random: () => number): Move | null {
  const current = state.players[state.currentPlayerIndex];
  if (!current || state.status !== "playing") return null;

  const candidates = getValidMoves(state.board, current.id);
  if (candidates.length === 0) return null;

  const index = Math.min(candidates.length - 1, Math.floor(random() * candidates.length));
  const choice = candidates[index];
  return { playerId: current.id, row: choice.row, col: choice.col };
}
