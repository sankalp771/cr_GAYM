import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { buildRecord, type MatchRecord } from "@/lib/replay";
import { ReplayScreen } from "@/components/replay/replay-screen";

/**
 * A 2x2 board decided in four moves.
 *
 * Every cell is a corner, so critical mass is 2 everywhere and the whole thing
 * settles fast — which keeps the frame list short enough to assert on by hand.
 */
function tinyRecord(): MatchRecord {
  return buildRecord({
    mode: "local",
    config: { rows: 2, cols: 2 },
    players: [
      { id: "player-1", name: "Ada", color: "#ff5b8a" },
      { id: "player-2", name: "Bo", color: "#42f5d7", badge: "CPU" }
    ],
    moves: [
      { playerId: "player-1", row: 0, col: 0, auto: false },
      { playerId: "player-2", row: 1, col: 1, auto: false },
      { playerId: "player-1", row: 0, col: 0, auto: false },
      { playerId: "player-2", row: 1, col: 1, auto: true }
    ],
    winnerId: "player-2",
    recordedAt: 1_700_000_000_000
  });
}

describe("ReplayScreen", () => {
  it("opens on the empty board with the transport parked at move zero", () => {
    render(<ReplayScreen record={tinyRecord()} onExit={() => undefined} autoPlay={false} />);

    expect(screen.getByTestId("replay-position")).toHaveTextContent("Move 0 / 4");
    expect(screen.queryAllByTestId("orb")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Play" })).toBeInTheDocument();
  });

  it("steps a whole move at a time and names who played it", () => {
    render(<ReplayScreen record={tinyRecord()} onExit={() => undefined} autoPlay={false} />);

    fireEvent.click(screen.getByRole("button", { name: "Next move" }));
    expect(screen.getByTestId("replay-position")).toHaveTextContent("Move 1 / 4");
    expect(screen.getByText("Ada played row 1, column 1.")).toBeInTheDocument();
    expect(screen.getAllByTestId("orb")).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Next move" }));
    expect(screen.getByTestId("replay-position")).toHaveTextContent("Move 2 / 4");
    expect(screen.getAllByTestId("orb")).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Previous move" }));
    expect(screen.getByTestId("replay-position")).toHaveTextContent("Move 1 / 4");
  });

  it("says when a move was played by the clock rather than the player", () => {
    render(<ReplayScreen record={tinyRecord()} onExit={() => undefined} autoPlay={false} />);

    // Move 4 both auto-plays and decides the match, and the deciding wording wins.
    fireEvent.click(screen.getByRole("button", { name: "Jump to the end" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous move" }));
    expect(screen.getByText(/Bo played row 2, column 2 and took the board\./)).toBeInTheDocument();
  });

  it("plays the winner's flourish past the last move and rewinds out of it", () => {
    render(<ReplayScreen record={tinyRecord()} onExit={() => undefined} autoPlay={false} />);

    fireEvent.click(screen.getByRole("button", { name: "Jump to the end" }));
    // The flourish empties the board, but the standings still read the real
    // final position rather than a row of zeroes.
    expect(screen.queryAllByTestId("orb")).toHaveLength(0);
    const [, second] = screen.getAllByTestId("player-row");
    expect(second).toHaveTextContent("Bo");
    expect(second).toHaveTextContent("4");

    fireEvent.click(screen.getByRole("button", { name: "Previous move" }));
    expect(screen.getByTestId("replay-position")).toHaveTextContent("Move 4 / 4");
    expect(screen.getAllByTestId("orb").length).toBeGreaterThan(0);
  });

  it("keeps the board out of reach — a replay is watched, not played", () => {
    render(<ReplayScreen record={tinyRecord()} onExit={() => undefined} autoPlay={false} />);

    const cells = screen.getAllByRole("button", { name: /^Row \d+, column \d+:/ });
    expect(cells).toHaveLength(4);
    expect(cells.every((cell) => cell.hasAttribute("disabled"))).toBe(true);
  });

  it("closes back to where it was opened from", () => {
    const onExit = vi.fn();
    render(<ReplayScreen record={tinyRecord()} onExit={onExit} autoPlay={false} />);

    fireEvent.click(screen.getByRole("button", { name: "Close replay" }));
    expect(onExit).toHaveBeenCalledOnce();
  });

  it("says so rather than pretending when a record cannot be played out", () => {
    const broken: MatchRecord = {
      ...tinyRecord(),
      // Second move handed back to the player who just moved.
      moves: [
        { playerId: "player-1", row: 0, col: 0, auto: false },
        { playerId: "player-1", row: 1, col: 1, auto: false }
      ]
    };

    render(<ReplayScreen record={broken} onExit={() => undefined} autoPlay={false} />);
    expect(screen.getByRole("status")).toHaveTextContent("stops at move 2");
  });
});
