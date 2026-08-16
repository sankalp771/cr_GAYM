import { describe, expect, it } from "vitest";
import {
  applyMove,
  chooseGreedyMove,
  countTotalOrbs,
  createInitialState,
  type GameState,
  type Player
} from "@/lib/engine";
import {
  buildRecord,
  expandRecord,
  parseRecord,
  serializeRecord,
  type MatchRecord,
  type RecordedMove
} from "../record";
import { flattenTimeline, moveBoundaries } from "../timeline";

function players(count: number): Player[] {
  const colors = ["#ff5b8a", "#42f5d7", "#ffd54a", "#60a9ff"];
  return Array.from({ length: count }, (_, index) => ({
    id: `player-${index + 1}`,
    name: `Player ${index + 1}`,
    color: colors[index],
    hasEnteredPlay: false,
    isEliminated: false
  }));
}

/** A deterministic rng, so a failing case is a case that can be re-run. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

/**
 * Play a whole match with the greedy bot and keep the move list — the same thing
 * the arena does while a human plays, minus the human.
 */
function playMatch(size: number, playerCount: number, seed: number) {
  const random = seeded(seed);
  let state: GameState = createInitialState({ rows: size, cols: size }, players(playerCount));
  const moves: RecordedMove[] = [];

  while (state.status === "playing" && moves.length < 4000) {
    const move = chooseGreedyMove(state, random);
    if (!move) break;
    moves.push({ playerId: move.playerId, row: move.row, col: move.col, auto: false });
    state = applyMove(state, move).state;
  }

  const record = buildRecord({
    mode: "local",
    config: state.config,
    players: state.players.map((player) => ({ id: player.id, name: player.name, color: player.color })),
    moves,
    winnerId: state.winnerId,
    recordedAt: 1_700_000_000_000
  });

  return { record, state };
}

describe("expandRecord", () => {
  // The whole feature rests on this: a record is only a move list, and every
  // board a replay draws is the engine re-deriving those moves. If the replay
  // and the match could reach different final positions, the file a player
  // downloads would be a recording of a game that never happened.
  it.each([
    [6, 2, 11],
    [6, 3, 29],
    [8, 2, 47],
    [8, 4, 83]
  ])("replays a %ix%i, %i-player match to the same final position", (size, playerCount, seed) => {
    const { record, state } = playMatch(size, playerCount, seed);
    const timeline = expandRecord(record);

    expect(timeline.truncatedAt).toBeNull();
    expect(timeline.moves).toHaveLength(record.moves.length);
    expect(timeline.final.status).toBe(state.status);
    expect(timeline.final.winnerId).toBe(state.winnerId);
    expect(timeline.final.moveCount).toBe(state.moveCount);
    expect(timeline.final.board).toEqual(state.board);
    expect(timeline.final.players).toEqual(state.players);
  });

  it("keeps orb count equal to move count on every settled board", () => {
    const { record } = playMatch(6, 2, 101);
    const timeline = expandRecord(record);

    // Orbs are conserved and the grid has no sink, so a settled board holds
    // exactly one orb per move played — except once the match is decided, where
    // the engine stops the cascade deliberately.
    for (const move of timeline.moves) {
      if (move.after.status === "finished") continue;
      expect(countTotalOrbs(move.after.board)).toBe(move.number);
    }
  });

  it("produces frames for every move and a finale for the winner", () => {
    const { record } = playMatch(6, 2, 7);
    const timeline = expandRecord(record);

    expect(timeline.moves.every((move) => move.steps.length > 0)).toBe(true);
    expect(timeline.moves.every((move) => move.durations.length === move.steps.length)).toBe(true);
    expect(timeline.finale).not.toBeNull();
    // The finale exists to clear a board the engine froze mid-cascade.
    expect(countTotalOrbs(timeline.finale!.steps.at(-1)!.board)).toBe(0);
  });

  it("stops at the first move a tampered record cannot legally play", () => {
    const { record } = playMatch(6, 2, 13);
    const broken: MatchRecord = {
      ...record,
      // Move 3 handed to the wrong seat: legal square, wrong player's turn.
      moves: record.moves.map((move, index) =>
        index === 2 ? { ...move, playerId: move.playerId === "player-1" ? "player-2" : "player-1" } : move
      )
    };

    const timeline = expandRecord(broken);
    expect(timeline.truncatedAt).toBe(3);
    expect(timeline.moves).toHaveLength(2);
  });

  it("expands an unfinished match without a finale", () => {
    const { record } = playMatch(6, 2, 19);
    const partial: MatchRecord = { ...record, moves: record.moves.slice(0, 4), winnerId: null };

    const timeline = expandRecord(partial);
    expect(timeline.truncatedAt).toBeNull();
    expect(timeline.final.status).toBe("playing");
    expect(timeline.finale).toBeNull();
  });
});

describe("flattenTimeline", () => {
  it("opens on an empty board and ends on the last frame the game produced", () => {
    const { record } = playMatch(6, 2, 23);
    const timeline = expandRecord(record);
    const frames = flattenTimeline(timeline);

    expect(frames[0].moveNumber).toBe(0);
    expect(countTotalOrbs(frames[0].board)).toBe(0);
    expect(frames.at(-1)!.isFinale).toBe(true);
    expect(frames.every((frame) => frame.durationMs > 0)).toBe(true);
  });

  it("gives every move a boundary that lands inside that move", () => {
    const { record } = playMatch(6, 2, 31);
    const frames = flattenTimeline(expandRecord(record));
    const boundaries = moveBoundaries(frames);

    expect(boundaries[0]).toBe(0);
    for (let move = 1; move <= record.moves.length; move += 1) {
      expect(frames[boundaries[move]].moveNumber).toBe(move);
      // The boundary is the *end* of the move, so the next frame belongs to the
      // next move — that is what makes "step forward" a single jump.
      const next = frames[boundaries[move] + 1];
      if (next) expect(next.moveNumber).toBeGreaterThanOrEqual(move);
    }

    // The finale carries the last move's number too. If it were counted, the
    // last move's marker would land on the emptied board and there would be no
    // way to step back to the position the match finished in.
    const last = boundaries[record.moves.length];
    expect(frames[last].isFinale).toBe(false);
    expect(frames[last].state.status).toBe("finished");
  });
});

describe("serializeRecord / parseRecord", () => {
  it("round-trips a record", () => {
    const { record } = playMatch(6, 2, 37);
    expect(parseRecord(serializeRecord(record))).toEqual(record);
  });

  it("rejects anything it does not recognise rather than throwing", () => {
    expect(parseRecord("not json")).toBeNull();
    expect(parseRecord("[]")).toBeNull();
    expect(parseRecord(JSON.stringify({ version: 99 }))).toBeNull();
    expect(parseRecord(JSON.stringify({ version: 1, mode: "local" }))).toBeNull();
  });

  it("refuses a record with a single seat", () => {
    const { record } = playMatch(6, 2, 41);
    const solo = JSON.stringify({ ...record, players: record.players.slice(0, 1) });
    expect(parseRecord(solo)).toBeNull();
  });
});
