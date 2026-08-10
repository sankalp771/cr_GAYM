/**
 * Depth search for the computer opponent.
 *
 * Pure, like the rest of `lib/engine/` — no React, no DOM, no `Date.now()`, no
 * `Math.random()`. That is not a style rule here, it is what makes the search
 * usable at all: the same code has to run in the browser, in Node tests, and
 * eventually inside an authoritative server, and all three must agree on the
 * move.
 *
 * ## Why this does not reuse `applyMove`
 *
 * It would be nicer to search over the real engine. Measured on this machine,
 * `applyMove` sustains ~88k positions/sec on a 6x6 board and ~54k on 14x14,
 * because every call clones each cell as an object, copies the player array, and
 * allocates a fresh neighbour list per cell per cascade pass. At those rates a
 * depth-3 search on the XXL board takes the best part of a second, which is a
 * frozen tab.
 *
 * So the search runs on a flat mirror of the board: two typed arrays for orb
 * counts and owners, a precomputed neighbour table, and one pre-allocated frame
 * per ply, so a node costs a memcpy rather than a few hundred allocations. That
 * measures 0.5M–1.1M positions/sec — six to twelve times faster — which is the
 * difference between depth 2 and depth 5.
 *
 * The obvious hazard is two implementations of the rules drifting apart. That is
 * covered mechanically: `__tests__/search.test.ts` replays thousands of random
 * positions through both `applyMove` and this simulation and asserts the boards,
 * the elimination flags and the winner all match exactly. If someone changes a
 * gameplay rule and only changes one side, that test fails.
 *
 * ## Why the budget is nodes and not milliseconds
 *
 * The engine may not read the clock. A node budget is the honest alternative and
 * is better anyway: it is deterministic, so the same position always yields the
 * same move, a seeded test is reproducible, and a server and a client cannot
 * disagree about what the "best" move was because one of them was busy.
 *
 * Iterative deepening is what turns that budget into a guarantee. The search
 * completes depth 1, then 2, then 3, keeping the best move it has; when the
 * budget runs out it stops and plays the deepest completed answer. A small board
 * gets more depth than a large one for the same cost, automatically, and the
 * worst case is bounded by construction rather than by hoping.
 *
 * ## The opponent model is paranoid
 *
 * Minimax is a two-player theorem and this game seats up to eight. The two
 * honest generalisations are maxn, where every seat maximises its own score, and
 * paranoid, where everyone else is collapsed into a single opponent trying to
 * minimise *ours*. Maxn is more truthful and prunes almost nothing — alpha-beta
 * needs a single scalar to bound. Paranoid keeps the pruning, and being
 * pessimistic about a free-for-all is a reasonable way to lose fewer orbs.
 */

import { criticalMass, getNeighbors } from "./rules";
import { EngineError } from "./types";
import type { GameState, GridConfig, Move } from "./types";
import {
  MATERIAL_WEIGHT,
  POSITION_WEIGHT,
  RISK_WEIGHT,
  SCORE_EPSILON,
  THREAT_WEIGHT,
  WIN_SCORE
} from "./weights";

/**
 * Default ceiling on positions examined for one move.
 *
 * Chosen from measurement rather than taste. The simulation sustains roughly
 * 0.5M–1.1M positions/sec depending on board size, and the cost of a position
 * varies a lot — a move that sets off a forty-pass cascade is far dearer than a
 * quiet placement — so the budget is set by the worst case, not the average.
 *
 * Measured here across forty distinct mid-game positions per board:
 *
 * | Budget | 6x6 worst | 10x10 worst | 14x14 worst | Depth reached      |
 * |--------|-----------|-------------|-------------|--------------------|
 * | 6k     | 10ms      | 14ms        | 19ms        | 3–5                |
 * | 12k    | 20ms      | 27ms        | 24ms        | 3–5                |
 * | 24k    | 39ms      | 59ms        | 54ms        | 3–5 (10x10 gains 1)|
 *
 * 12k is the knee. Doubling it buys one extra ply on the 10x10 board alone and
 * costs twice the latency everywhere, which is the wrong trade on the mid-range
 * Android the product brief calls out — that device is several times slower than
 * the machine these numbers came from, so a 27ms worst case there is nearer
 * 100ms, and a 59ms one would be a visible stall.
 *
 * All of it happens inside the 600ms pause the arena already puts before a
 * computer move, so none of it delays a human's own turn.
 */
export const DEFAULT_MAX_NODES = 12_000;

/**
 * Hard ceiling on iterative deepening.
 *
 * The node budget is what actually stops the search; this only bounds the
 * pre-allocated frame stack. Six plies is already unreachable on anything but a
 * nearly finished board.
 */
export const MAX_SEARCH_DEPTH = 6;

/** Mirrors the engine's own cascade ceiling. Unreachable — the single-owner check stops first. */
const MAX_CASCADE_PASSES = 100_000;

const EMPTY = -1;

export type SearchOptions = {
  /** Positions to examine before falling back to the deepest completed result. */
  maxNodes?: number;
  maxDepth?: number;
};

export type SearchResult = {
  move: Move | null;
  /** Plies of the deepest iteration that finished. 0 when there was nothing to search. */
  depth: number;
  nodes: number;
  score: number;
};

/**
 * Board geometry, derived once per board size.
 *
 * Neighbours are stored in the usual flattened adjacency form — `neighborIndex`
 * holds every neighbour back to back and `neighborOffset[i]` says where cell
 * `i`'s run starts — so walking them allocates nothing.
 */
type Geometry = {
  rows: number;
  cols: number;
  cellCount: number;
  /** Orbs a cell holds before it explodes, which is also its neighbour count. */
  mass: Uint8Array;
  /** 2 at a corner, 1 on an edge, 0 in the interior. */
  positionValue: Int8Array;
  neighborOffset: Int32Array;
  neighborIndex: Int32Array;
};

const geometryCache = new Map<string, Geometry>();

function getGeometry(config: GridConfig): Geometry {
  const key = `${config.rows}x${config.cols}`;
  const cached = geometryCache.get(key);
  if (cached) return cached;

  const { rows, cols } = config;
  const cellCount = rows * cols;
  const mass = new Uint8Array(cellCount);
  const positionValue = new Int8Array(cellCount);
  const neighborOffset = new Int32Array(cellCount + 1);
  const flat: number[] = [];

  for (let row = 0; row < rows; row += 1) {
    for (let col = 0; col < cols; col += 1) {
      const index = row * cols + col;
      neighborOffset[index] = flat.length;
      for (const [neighborRow, neighborCol] of getNeighbors(row, col, config)) {
        flat.push(neighborRow * cols + neighborCol);
      }
      mass[index] = criticalMass(row, col, config);
      positionValue[index] = 4 - mass[index];
    }
  }
  neighborOffset[cellCount] = flat.length;

  const geometry: Geometry = {
    rows,
    cols,
    cellCount,
    mass,
    positionValue,
    neighborOffset,
    neighborIndex: Int32Array.from(flat)
  };

  // Five board presets exist; the bound is only here so a rectangular board
  // built by hand in a test cannot grow this without limit.
  if (geometryCache.size >= 16) geometryCache.clear();
  geometryCache.set(key, geometry);
  return geometry;
}

/** One ply's position. Pre-allocated once per search and overwritten in place. */
type Frame = {
  counts: Uint8Array;
  owners: Int8Array;
  /** Orbs held by each player, maintained incrementally through the cascade. */
  orbs: Int32Array;
  entered: Uint8Array;
  eliminated: Uint8Array;
  turn: number;
  finished: boolean;
  winner: number;
  moveList: Int32Array;
  moveScores: Float64Array;
};

function createFrame(cellCount: number, playerCount: number): Frame {
  return {
    counts: new Uint8Array(cellCount),
    owners: new Int8Array(cellCount),
    orbs: new Int32Array(playerCount),
    entered: new Uint8Array(playerCount),
    eliminated: new Uint8Array(playerCount),
    turn: 0,
    finished: false,
    winner: EMPTY,
    moveList: new Int32Array(cellCount),
    moveScores: new Float64Array(cellCount)
  };
}

function copyFrame(from: Frame, to: Frame) {
  to.counts.set(from.counts);
  to.owners.set(from.owners);
  to.orbs.set(from.orbs);
  to.entered.set(from.entered);
  to.eliminated.set(from.eliminated);
  to.turn = from.turn;
  to.finished = from.finished;
  to.winner = from.winner;
}

/**
 * Buffers shared by every node.
 *
 * A cascade runs to completion inside one `simulate` call and never recurses, so
 * these do not need to be per-frame — which keeps the whole search down to a
 * fixed allocation made before the first node.
 */
type Scratch = {
  frontierA: Int32Array;
  frontierB: Int32Array;
  exploding: Int32Array;
  /** Stamped rather than cleared: bumping the counter invalidates every entry at once. */
  mark: Int32Array;
  stamp: number;
};

function createScratch(cellCount: number): Scratch {
  return {
    // An exploding cell pushes one entry per neighbour, and it has `mass` of
    // them, so four per cell is the ceiling for a whole pass.
    frontierA: new Int32Array(cellCount * 4),
    frontierB: new Int32Array(cellCount * 4),
    exploding: new Int32Array(cellCount),
    mark: new Int32Array(cellCount),
    stamp: 0
  };
}

/** The engine's `nextLivingPlayerIndex`, on the flat representation. */
function nextLiving(eliminated: Uint8Array, fromIndex: number, playerCount: number): number {
  for (let step = 1; step <= playerCount; step += 1) {
    const candidate = (fromIndex + step) % playerCount;
    if (!eliminated[candidate]) return candidate;
  }
  return fromIndex;
}

/**
 * Play one move into `frame`, in place.
 *
 * This is `applyMove` and `resolveBoardInPlace` rewritten over typed arrays, and
 * it has to match them exactly — including the parts that look incidental:
 *
 * - Explosions are collected as a whole pass and then applied, so the reaction is
 *   order-independent the way the engine's is.
 * - Within a pass, sources are applied in row-major order. That matters: when two
 *   cells with different owners spill into the same cell on the same pass, the
 *   last writer owns it.
 * - The cascade stops the moment one player holds every orb. Orbs are conserved
 *   and the grid has no sink, so a board above its own stable capacity has no
 *   resting configuration and the loop would otherwise never end. See the long
 *   note in `engine.ts`.
 */
function simulate(geo: Geometry, scratch: Scratch, frame: Frame, cellIndex: number, playerCount: number) {
  const { counts, owners, orbs, entered, eliminated } = frame;
  const { mass, neighborOffset, neighborIndex } = geo;
  const mover = frame.turn;

  counts[cellIndex] += 1;
  owners[cellIndex] = mover;
  orbs[mover] += 1;
  entered[mover] = 1;

  let allEntered = true;
  for (let player = 0; player < playerCount; player += 1) {
    if (!entered[player]) {
      allEntered = false;
      break;
    }
  }

  let endedMidCascade = false;
  let frontier = scratch.frontierA;
  let nextFrontier = scratch.frontierB;
  let frontierLength = 1;
  frontier[0] = cellIndex;

  let pass = 0;
  for (; pass < MAX_CASCADE_PASSES; pass += 1) {
    // Only cells that received an orb last pass can be newly unstable: a cell
    // has exactly `mass` neighbours, so it gains at most `mass` in a pass, and
    // one that explodes drains to below `mass` unless it also received.
    scratch.stamp += 1;
    const stamp = scratch.stamp;
    const exploding = scratch.exploding;
    let explodingCount = 0;

    for (let i = 0; i < frontierLength; i += 1) {
      const index = frontier[i];
      if (scratch.mark[index] === stamp) continue;
      if (counts[index] < mass[index]) continue;
      scratch.mark[index] = stamp;

      // Insertion keeps the pass in row-major order, which is what the engine
      // does and what decides ownership when two sources hit one cell.
      let slot = explodingCount - 1;
      while (slot >= 0 && exploding[slot] > index) {
        exploding[slot + 1] = exploding[slot];
        slot -= 1;
      }
      exploding[slot + 1] = index;
      explodingCount += 1;
    }

    if (explodingCount === 0) break;

    let nextLength = 0;
    for (let i = 0; i < explodingCount; i += 1) {
      const source = exploding[i];
      const owner = owners[source];
      const sourceMass = mass[source];

      counts[source] -= sourceMass;
      orbs[owner] -= sourceMass;
      if (counts[source] === 0) owners[source] = EMPTY;

      for (let k = neighborOffset[source]; k < neighborOffset[source + 1]; k += 1) {
        const neighbor = neighborIndex[k];
        const previousOwner = owners[neighbor];
        if (previousOwner !== EMPTY && previousOwner !== owner) {
          const captured = counts[neighbor];
          orbs[previousOwner] -= captured;
          orbs[owner] += captured;
        }
        counts[neighbor] += 1;
        orbs[owner] += 1;
        owners[neighbor] = owner;
        nextFrontier[nextLength] = neighbor;
        nextLength += 1;
      }
    }

    if (allEntered) {
      let ownersWithOrbs = 0;
      for (let player = 0; player < playerCount; player += 1) {
        if (orbs[player] > 0) ownersWithOrbs += 1;
      }
      if (ownersWithOrbs <= 1) {
        endedMidCascade = true;
        break;
      }
    }

    const swap = frontier;
    frontier = nextFrontier;
    nextFrontier = swap;
    frontierLength = nextLength;
  }

  if (pass >= MAX_CASCADE_PASSES) {
    throw new EngineError(
      `Search cascade failed to settle within ${MAX_CASCADE_PASSES} passes. This should be unreachable — ` +
        "the single-owner guard is expected to stop a runaway reaction long before this."
    );
  }

  // A player is only out once they have actually played and then lost every orb.
  if (allEntered) {
    for (let player = 0; player < playerCount; player += 1) {
      if (entered[player] && !eliminated[player] && orbs[player] === 0) eliminated[player] = 1;
    }
  }

  let survivors = 0;
  let firstSurvivor = EMPTY;
  for (let player = 0; player < playerCount; player += 1) {
    if (!eliminated[player]) {
      survivors += 1;
      if (firstSurvivor === EMPTY) firstSurvivor = player;
    }
  }

  if ((allEntered && survivors === 1) || endedMidCascade) {
    const winner = firstSurvivor !== EMPTY ? firstSurvivor : mover;
    for (let player = 0; player < playerCount; player += 1) {
      if (player !== winner) eliminated[player] = 1;
    }
    frame.finished = true;
    frame.winner = winner;
    return;
  }

  frame.finished = false;
  frame.winner = EMPTY;
  frame.turn = nextLiving(eliminated, mover, playerCount);
}

/**
 * Static evaluation of a settled position, from `me`'s point of view.
 *
 * Same four terms as the one-ply heuristic and the same weights, so a change in
 * strength can only be coming from the depth. The pressure terms walk out from
 * *loaded* cells rather than over every cell, and stamp each victim so a cell
 * caught in a crossfire is still only counted once — double-counting would make
 * one square look like two.
 */
function evaluate(geo: Geometry, scratch: Scratch, frame: Frame, me: number, playerCount: number): number {
  const { counts, owners, orbs } = frame;
  const { mass, positionValue, neighborOffset, neighborIndex } = geo;

  let material = orbs[me];
  for (let player = 0; player < playerCount; player += 1) {
    if (player !== me) material -= orbs[player];
  }

  scratch.stamp += 1;
  const stamp = scratch.stamp;
  const mark = scratch.mark;

  let position = 0;
  let ownOrbsAtRisk = 0;
  let enemyOrbsThreatened = 0;

  for (let index = 0; index < geo.cellCount; index += 1) {
    const owner = owners[index];
    if (owner === EMPTY) continue;
    if (owner === me) position += positionValue[index];

    const count = counts[index];
    if (count === 0 || count !== mass[index] - 1) continue;

    for (let k = neighborOffset[index]; k < neighborOffset[index + 1]; k += 1) {
      const victim = neighborIndex[k];
      const victimOwner = owners[victim];
      if (victimOwner === EMPTY || victimOwner === owner) continue;
      if (mark[victim] === stamp) continue;

      if (victimOwner === me) {
        mark[victim] = stamp;
        ownOrbsAtRisk += counts[victim];
      } else if (owner === me) {
        mark[victim] = stamp;
        enemyOrbsThreatened += counts[victim];
      }
    }
  }

  return (
    MATERIAL_WEIGHT * material +
    THREAT_WEIGHT * enemyOrbsThreatened -
    RISK_WEIGHT * ownOrbsAtRisk +
    POSITION_WEIGHT * position
  );
}

/**
 * Cheap ordering score for a candidate move — no simulation, no allocation.
 *
 * Ordering is not a nicety here. Alpha-beta only reaches its `b^(d/2)` node count
 * when the best move is tried first; with moves in board order the search prunes
 * almost nothing and a ply costs the full branching factor. Detonations are tried
 * first because they are what wins orbs, biggest capture first.
 */
function orderScore(geo: Geometry, frame: Frame, index: number): number {
  const { counts, owners } = frame;
  const { mass, positionValue, neighborOffset, neighborIndex } = geo;
  const turn = frame.turn;
  const count = counts[index];

  let score = positionValue[index] * 2 + count;

  if (count === mass[index] - 1) {
    score += 500;
    for (let k = neighborOffset[index]; k < neighborOffset[index + 1]; k += 1) {
      const neighbor = neighborIndex[k];
      const owner = owners[neighbor];
      if (owner !== EMPTY && owner !== turn) score += 20 * (counts[neighbor] + 1);
    }
    return score;
  }

  // Stacking next to a loaded enemy hands them the pile.
  for (let k = neighborOffset[index]; k < neighborOffset[index + 1]; k += 1) {
    const neighbor = neighborIndex[k];
    const owner = owners[neighbor];
    if (owner !== EMPTY && owner !== turn && counts[neighbor] === mass[neighbor] - 1) score -= 30;
  }

  return score;
}

function generateMoves(geo: Geometry, frame: Frame): number {
  const { owners, moveList, moveScores } = frame;
  const turn = frame.turn;
  let count = 0;

  for (let index = 0; index < geo.cellCount; index += 1) {
    const owner = owners[index];
    if (owner !== EMPTY && owner !== turn) continue;
    moveList[count] = index;
    moveScores[count] = orderScore(geo, frame, index);
    count += 1;
  }

  return count;
}

/**
 * Pull the next-best move to position `from`, in place.
 *
 * Selection rather than a full sort, because alpha-beta usually cuts off after a
 * handful of moves — sorting 150 candidates to look at three is wasted work.
 */
function selectNextMove(frame: Frame, from: number, count: number) {
  const { moveList, moveScores } = frame;
  let best = from;
  for (let i = from + 1; i < count; i += 1) {
    if (moveScores[i] > moveScores[best]) best = i;
  }
  if (best === from) return;

  const move = moveList[from];
  const score = moveScores[from];
  moveList[from] = moveList[best];
  moveScores[from] = moveScores[best];
  moveList[best] = move;
  moveScores[best] = score;
}

/** Thrown to unwind the recursion when the node budget runs out. Caught in `searchBestMove`. */
class BudgetExhausted extends Error {
  constructor() {
    super("Search node budget exhausted.");
    this.name = "BudgetExhausted";
  }
}

class Searcher {
  private readonly frames: Frame[];
  private readonly scratch: Scratch;
  nodes = 0;

  constructor(
    private readonly geo: Geometry,
    private readonly playerCount: number,
    private readonly me: number,
    private readonly maxNodes: number,
    maxDepth: number
  ) {
    this.scratch = createScratch(geo.cellCount);
    this.frames = Array.from({ length: maxDepth + 1 }, () => createFrame(geo.cellCount, playerCount));
  }

  frame(ply: number): Frame {
    return this.frames[ply];
  }

  /** Copy the position at `ply` into `ply + 1` and play `cellIndex` there. */
  descend(ply: number, cellIndex: number): void {
    const parent = this.frames[ply];
    const child = this.frames[ply + 1];
    copyFrame(parent, child);
    simulate(this.geo, this.scratch, child, cellIndex, this.playerCount);
  }

  generateRootMoves(): number {
    return generateMoves(this.geo, this.frames[0]);
  }

  /**
   * Paranoid alpha-beta.
   *
   * Every seat that is not `me` is treated as one opponent minimising `me`'s
   * evaluation, which is what lets a single alpha/beta pair bound a game with up
   * to eight players.
   */
  search(depth: number, ply: number, alpha: number, beta: number): number {
    // Checked before counting, so a node that trips the budget is never counted
    // as examined — `nodes` is exactly the work done, and the ceiling is a real
    // ceiling rather than one over it.
    if (this.nodes >= this.maxNodes) throw new BudgetExhausted();
    this.nodes += 1;

    const frame = this.frames[ply];

    // Winning sooner scores higher than winning later, so the search takes the
    // move that ends it rather than dawdling in an equally won position.
    if (frame.finished) {
      return frame.winner === this.me ? WIN_SCORE - ply : -(WIN_SCORE - ply);
    }
    if (depth === 0) return evaluate(this.geo, this.scratch, frame, this.me, this.playerCount);

    const moveCount = generateMoves(this.geo, frame);
    if (moveCount === 0) return evaluate(this.geo, this.scratch, frame, this.me, this.playerCount);

    const maximizing = frame.turn === this.me;
    const child = this.frames[ply + 1];
    let best = maximizing ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;

    for (let picked = 0; picked < moveCount; picked += 1) {
      selectNextMove(frame, picked, moveCount);
      copyFrame(frame, child);
      simulate(this.geo, this.scratch, child, frame.moveList[picked], this.playerCount);

      const score = this.search(depth - 1, ply + 1, alpha, beta);

      if (maximizing) {
        if (score > best) best = score;
        if (best > alpha) alpha = best;
      } else {
        if (score < best) best = score;
        if (best < beta) beta = best;
      }
      if (alpha >= beta) break;
    }

    return best;
  }
}

/** Map a `GameState` onto the flat representation the search runs on. */
function loadRootFrame(state: GameState, geo: Geometry, frame: Frame): void {
  const indexOf = new Map<string, number>();
  state.players.forEach((player, index) => indexOf.set(player.id, index));

  frame.counts.fill(0);
  frame.owners.fill(EMPTY);
  frame.orbs.fill(0);

  for (const row of state.board) {
    for (const cell of row) {
      const index = cell.row * geo.cols + cell.col;
      frame.counts[index] = cell.count;
      if (cell.ownerId === null || cell.count === 0) continue;
      const owner = indexOf.get(cell.ownerId);
      if (owner === undefined) continue;
      frame.owners[index] = owner;
      frame.orbs[owner] += cell.count;
    }
  }

  state.players.forEach((player, index) => {
    frame.entered[index] = player.hasEnteredPlay ? 1 : 0;
    frame.eliminated[index] = player.isEliminated ? 1 : 0;
  });

  frame.turn = state.currentPlayerIndex;
  frame.finished = state.status === "finished";
  frame.winner = EMPTY;
}

/**
 * Search the position and report the best move along with how deep it got.
 *
 * Iterative deepening: each pass re-searches from scratch one ply deeper, using
 * the previous pass's scores to decide what to try first. That sounds wasteful —
 * it is not, because the tree grows geometrically, so every previous depth put
 * together costs a fraction of the current one, and the ordering it buys pays for
 * itself several times over in pruning.
 *
 * When the budget runs out mid-pass the result of the completed passes still
 * stands, and any root moves finished in the abandoned pass are kept too: they
 * were searched in best-first order, so the useful ones went first.
 */
export function searchBestMove(
  state: GameState,
  random: () => number,
  options: SearchOptions = {}
): SearchResult {
  const empty: SearchResult = { move: null, depth: 0, nodes: 0, score: 0 };
  if (state.status !== "playing") return empty;

  const current = state.players[state.currentPlayerIndex];
  if (!current || current.isEliminated) return empty;

  const geo = getGeometry(state.config);
  const playerCount = state.players.length;
  const maxNodes = Math.max(1, options.maxNodes ?? DEFAULT_MAX_NODES);
  const maxDepth = Math.max(1, Math.min(options.maxDepth ?? MAX_SEARCH_DEPTH, MAX_SEARCH_DEPTH));

  const searcher = new Searcher(geo, playerCount, state.currentPlayerIndex, maxNodes, maxDepth);
  const root = searcher.frame(0);
  loadRootFrame(state, geo, root);

  const rootMoveCount = searcher.generateRootMoves();
  if (rootMoveCount === 0) return empty;

  // Order stays across iterations, so each deeper pass starts with what the
  // shallower one liked best.
  const order = Array.from({ length: rootMoveCount }, (_, i) => {
    selectNextMove(root, i, rootMoveCount);
    return root.moveList[i];
  });
  const scores = new Float64Array(rootMoveCount);

  let completedDepth = 0;
  let bestScore = Number.NEGATIVE_INFINITY;
  let bestCells: number[] = [order[0]];

  for (let depth = 1; depth <= maxDepth; depth += 1) {
    let alpha = Number.NEGATIVE_INFINITY;
    let iterationBest = Number.NEGATIVE_INFINITY;
    let iterationCells: number[] = [];
    let searched = 0;

    try {
      for (let i = 0; i < rootMoveCount; i += 1) {
        searcher.descend(0, order[i]);
        const score = searcher.search(depth - 1, 1, alpha, Number.POSITIVE_INFINITY);
        scores[i] = score;
        searched += 1;

        if (score > iterationBest + SCORE_EPSILON) {
          iterationBest = score;
          iterationCells = [order[i]];
          if (score > alpha) alpha = score;
        } else if (score > iterationBest - SCORE_EPSILON) {
          iterationCells.push(order[i]);
        }
      }
    } catch (error) {
      if (!(error instanceof BudgetExhausted)) throw error;
    }

    if (searched === 0) break;

    bestScore = iterationBest;
    bestCells = iterationCells;
    completedDepth = depth;

    // Re-order for the next pass, best first. Only the moves actually searched
    // have a fresh score; the rest keep their place behind them.
    const searchedOrder = order.slice(0, searched);
    const searchedScores = Array.from(scores.slice(0, searched));
    searchedOrder
      .map((cell, i) => ({ cell, score: searchedScores[i] }))
      .sort((a, b) => b.score - a.score)
      .forEach((entry, i) => {
        order[i] = entry.cell;
      });

    if (searched < rootMoveCount) break; // budget ran out; deeper is not affordable
    if (Math.abs(iterationBest) >= WIN_SCORE - maxDepth) break; // decided; no point looking further
  }

  const index = Math.min(bestCells.length - 1, Math.floor(random() * bestCells.length));
  const cell = bestCells[index];

  return {
    move: { playerId: current.id, row: Math.floor(cell / geo.cols), col: cell % geo.cols },
    depth: completedDepth,
    nodes: searcher.nodes,
    score: bestScore
  };
}

/** A settled position as plain data, for holding the fast simulation against the engine. */
export type SimulationSnapshot = {
  /** Orb counts in row-major order. */
  counts: number[];
  /** Player index per cell, or `null` where the cell is empty. */
  owners: Array<number | null>;
  entered: boolean[];
  eliminated: boolean[];
  currentPlayerIndex: number;
  finished: boolean;
  winner: number | null;
};

/**
 * Play one move through the search's own simulation and return the result.
 *
 * This exists so the duplicate rules implementation can be tested rather than
 * trusted: `__tests__/search.test.ts` runs the same move through `applyMove` and
 * through this, and asserts every cell, every elimination flag and the winner
 * agree. Without it the two could drift apart silently, which is the one real
 * risk this file takes on.
 */
export function simulateMove(state: GameState, move: Move): SimulationSnapshot {
  const geo = getGeometry(state.config);
  const playerCount = state.players.length;
  const frame = createFrame(geo.cellCount, playerCount);
  const scratch = createScratch(geo.cellCount);

  loadRootFrame(state, geo, frame);
  frame.turn = state.players.findIndex((player) => player.id === move.playerId);
  simulate(geo, scratch, frame, move.row * geo.cols + move.col, playerCount);

  return {
    counts: Array.from(frame.counts),
    owners: Array.from(frame.owners, (owner) => (owner === EMPTY ? null : owner)),
    entered: Array.from(frame.entered, Boolean),
    eliminated: Array.from(frame.eliminated, Boolean),
    currentPlayerIndex: frame.turn,
    finished: frame.finished,
    winner: frame.winner === EMPTY ? null : frame.winner
  };
}

/** Convenience wrapper matching `chooseGreedyMove`'s shape. */
export function chooseSearchMove(
  state: GameState,
  random: () => number,
  options: SearchOptions = {}
): Move | null {
  return searchBestMove(state, random, options).move;
}
