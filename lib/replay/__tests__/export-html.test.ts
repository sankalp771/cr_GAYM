import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";
import {
  applyMove,
  chooseGreedyMove,
  createInitialState,
  type GameState,
  type Player
} from "@/lib/engine";
import { buildRecord, expandRecord, type MatchRecord, type RecordedMove } from "../record";
import { buildReplayHtml, buildReplayPayload, decodeBoardString } from "../export-html";

function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function playMatch(size = 6, playerCount = 2, seed = 5, names?: string[]) {
  const random = seeded(seed);
  const roster: Player[] = Array.from({ length: playerCount }, (_, index) => ({
    id: `player-${index + 1}`,
    name: names?.[index] ?? `Player ${index + 1}`,
    color: ["#ff5b8a", "#42f5d7", "#ffd54a", "#60a9ff"][index],
    hasEnteredPlay: false,
    isEliminated: false
  }));

  let state: GameState = createInitialState({ rows: size, cols: size }, roster);
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

/** Load an exported file the way a browser would, scripts and all. */
function open(html: string) {
  const dom = new JSDOM(html, { runScripts: "dangerously", pretendToBeVisual: true });
  const api = (dom.window as unknown as { chainReactionReplay: ReplayApi }).chainReactionReplay;
  return { dom, api, document: dom.window.document };
}

type ReplayApi = {
  seek: (index: number) => void;
  play: () => void;
  pause: () => void;
  frameCount: number;
  currentIndex: () => number;
  data: { frames: Array<{ b: string; m: number }>; moves: unknown[]; winner: number | null };
};

describe("buildReplayPayload", () => {
  it("encodes every frame so it decodes back to the board the engine produced", () => {
    const { record } = playMatch();
    const timeline = expandRecord(record);
    const payload = buildReplayPayload(record, timeline);

    // Spot-checking one frame would pass on an off-by-one; every frame of a
    // whole match is the only check that the encoding is actually lossless.
    const boards = [
      timeline.initial.board,
      ...timeline.moves.flatMap((move) => move.steps.map((step) => step.board)),
      ...(timeline.finale?.steps.map((step) => step.board) ?? [])
    ];

    expect(payload.frames).toHaveLength(boards.length);

    for (const [index, board] of boards.entries()) {
      const decoded = decodeBoardString(payload.frames[index].b, record.config);
      for (const cell of decoded) {
        const source = board[cell.row][cell.col];
        expect(cell.count).toBe(source.count);
        expect(cell.owner).toBe(
          source.ownerId === null ? -1 : record.players.findIndex((player) => player.id === source.ownerId)
        );
      }
    }
  });

  it("points every move at a frame belonging to that move", () => {
    const { record } = playMatch(6, 3, 61);
    const payload = buildReplayPayload(record, expandRecord(record));

    expect(payload.moves).toHaveLength(record.moves.length);
    for (const [index, move] of payload.moves.entries()) {
      expect(payload.frames[move.end].m).toBe(index + 1);
    }
  });

  it("carries the final tally so the winner's flourish does not zero the scoreboard", () => {
    const { record, state } = playMatch();
    const payload = buildReplayPayload(record, expandRecord(record));
    const winnerIndex = record.players.findIndex((player) => player.id === record.winnerId);

    expect(payload.finalTally[winnerIndex]).toBe(
      state.board.flat().reduce((sum, cell) => sum + (cell.ownerId === record.winnerId ? cell.count : 0), 0)
    );
    // The last frame is the emptied board; the tally must not come from it.
    expect(payload.finalTally[winnerIndex]).toBeGreaterThan(0);
  });
});

describe("buildReplayHtml", () => {
  it("reaches for nothing outside the file", () => {
    const { record } = playMatch();
    const html = buildReplayHtml(record, expandRecord(record));

    // A replay has to open years later on a laptop with no network, so a single
    // external reference is a broken file rather than a slow one.
    expect(html).not.toMatch(/src\s*=\s*["']https?:/i);
    expect(html).not.toMatch(/href\s*=\s*["']https?:/i);
    expect(html).not.toMatch(/@import|url\(\s*["']?https?:/i);
    expect(html).not.toContain("fonts.googleapis");
  });

  it("cannot be broken out of by a player name", () => {
    const hostile = '</script><img src=x onerror="alert(1)">';
    const { record } = playMatch(6, 2, 5, [hostile, "Player 2"]);
    const html = buildReplayHtml(record, expandRecord(record));

    // Two separate guards: the name reaches the payload only as an escaped JSON
    // string, and the title reaches the markup only HTML-escaped.
    expect(html).not.toContain("</script><img");
    expect(html).not.toContain("onerror=\"alert(1)\"");

    const { document, api } = open(html);
    expect(api).toBeDefined();
    expect(document.querySelectorAll("img")).toHaveLength(0);
    expect(document.getElementById("seats")!.textContent).toContain(hostile);
  });

  it("opens on the empty board and plays through to the winner", () => {
    const { record } = playMatch();
    const timeline = expandRecord(record);
    const html = buildReplayHtml(record, timeline);
    const { document, api } = open(html);

    const cells = document.querySelectorAll("#board .cell");
    expect(cells).toHaveLength(record.config.rows * record.config.cols);
    expect(document.querySelectorAll("#board .orb")).toHaveLength(0);
    expect(document.getElementById("readout")!.textContent).toBe(`Move 0 / ${record.moves.length}`);

    // Halfway through, the board has to be showing something.
    api.seek(Math.floor(api.frameCount / 2));
    expect(document.querySelectorAll("#board .orb").length).toBeGreaterThan(0);

    api.seek(api.frameCount - 1);
    const winner = record.players.find((player) => player.id === record.winnerId)!;
    expect(document.getElementById("status")!.textContent).toBe(`${winner.name} wins.`);
    expect(document.getElementById("readout")!.textContent).toBe(
      `Move ${record.moves.length} / ${record.moves.length}`
    );
  });

  it("draws the same orbs the engine put on the board", () => {
    const { record } = playMatch();
    const timeline = expandRecord(record);
    const html = buildReplayHtml(record, timeline);
    const { document, api } = open(html);

    // The settled board after the tenth move, straight out of the engine.
    const move = timeline.moves[9];
    const payload = buildReplayPayload(record, timeline);
    api.seek(payload.moves[9].end);

    const board = document.getElementById("board")!;
    for (const cell of move.after.board.flat()) {
      const element = board.children[cell.row * record.config.cols + cell.col];
      // Stacks cap at four drawn orbs, exactly as the arena does.
      expect(element.querySelectorAll(".orb")).toHaveLength(Math.min(cell.count, 4));
    }
  });

  it("steps a whole move at a time, forwards and back", () => {
    const { record } = playMatch();
    const html = buildReplayHtml(record, expandRecord(record));
    const { document } = open(html);

    const click = (id: string) => (document.getElementById(id) as HTMLElement).click();
    const readout = () => document.getElementById("readout")!.textContent;

    click("next");
    expect(readout()).toBe(`Move 1 / ${record.moves.length}`);
    click("next");
    expect(readout()).toBe(`Move 2 / ${record.moves.length}`);
    click("prev");
    expect(readout()).toBe(`Move 1 / ${record.moves.length}`);

    // Off the end of the last move sits the winner's flourish; forward from
    // there runs it out rather than jumping backwards to the settled board.
    click("end");
    const atEnd = document.getElementById("status")!.textContent;
    click("next");
    expect(document.getElementById("status")!.textContent).toBe(atEnd);
    click("prev");
    expect(readout()).toBe(`Move ${record.moves.length} / ${record.moves.length}`);
  });

  it("keeps the record itself, so the file is the match and not only a rendering of it", () => {
    const { record } = playMatch();
    const html = buildReplayHtml(record, expandRecord(record));
    const { document } = open(html);

    const embedded = JSON.parse(document.getElementById("replay-data")!.textContent!) as {
      record: MatchRecord;
    };
    expect(embedded.record).toEqual(record);
  });

  it("stays a sane size for the biggest board this game offers", () => {
    const { record } = playMatch(14, 4, 97);
    const html = buildReplayHtml(record, expandRecord(record));

    // Shipping frames instead of rules is a deliberate trade, and this is the
    // ceiling that makes it an acceptable one. Measured on this seed — a 375
    // move greedy game on XXL, the longest this game produces — the file is
    // 1.4MB, against 55KB for a typical Classic match. Blowing this means the
    // encoding regressed, not that somebody played a long game.
    expect(html.length).toBeLessThan(2_000_000);
    // And a guard the other way, so the check cannot quietly become trivial.
    expect(record.moves.length).toBeGreaterThan(200);
  });
});
