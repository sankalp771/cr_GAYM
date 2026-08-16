"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { playSound } from "@/lib/sound";
import {
  downloadReplay,
  expandRecord,
  flattenTimeline,
  moveBoundaries,
  type MatchRecord
} from "@/lib/replay";
import { MatchScreen } from "@/components/local/match-screen";
import styles from "./replay-screen.module.css";

const SPEEDS = [0.5, 1, 2, 4] as const;

type ReplayScreenProps = {
  record: MatchRecord;
  onExit: () => void;
  showDownload?: boolean;
  /** Off only in tests, which want a still frame rather than a moving one. */
  autoPlay?: boolean;
};

/**
 * Watching a finished match back.
 *
 * The record is only a move list, so everything drawn here is produced by
 * running those moves through `lib/engine` again — the same trick online play
 * uses to animate a move the server never sent frames for. A replay therefore
 * cannot show a game this app would not actually play.
 *
 * It borrows `MatchScreen` rather than reimplementing the board. The differences
 * are all optional props on that component: no clock, no playable cells, the
 * turn track repurposed as a position bar, and the transport controls slotted in
 * above the standings.
 */
export function ReplayScreen({
  record,
  onExit,
  showDownload = true,
  autoPlay = true
}: ReplayScreenProps) {
  const timeline = useMemo(() => expandRecord(record), [record]);
  const frames = useMemo(() => flattenTimeline(timeline), [timeline]);
  const boundaries = useMemo(() => moveBoundaries(frames), [frames]);
  const badges = useMemo(
    () => new Map(record.players.map((player) => [player.id, player.badge ?? null])),
    [record]
  );

  const [index, setIndex] = useState(0);
  const [isPlaying, setIsPlaying] = useState(autoPlay);
  const [speed, setSpeed] = useState(1);
  const [savedAs, setSavedAs] = useState<string | null>(null);

  const lastIndex = frames.length - 1;
  const frame = frames[Math.min(index, lastIndex)];

  const seek = useCallback(
    (next: number) => setIndex(Math.max(0, Math.min(lastIndex, next))),
    [lastIndex]
  );

  const pause = useCallback(() => setIsPlaying(false), []);

  const play = useCallback(() => {
    // Play from the top when the replay has already run out, so the button is
    // never a no-op.
    setIndex((current) => (current >= lastIndex ? 0 : current));
    setIsPlaying(true);
  }, [lastIndex]);

  const toggle = useCallback(() => {
    if (isPlaying) pause();
    else play();
  }, [isPlaying, pause, play]);

  /**
   * Jump a whole move.
   *
   * Stepping one cascade frame at a time would take hundreds of clicks to cross
   * a match, so the buttons land on the settled board at the end of each move —
   * `moveBoundaries` is that index. Past the last move we are in the winner's
   * flourish, where back rewinds to the settled board and forward runs it out.
   */
  const jumpMove = useCallback(
    (delta: number) => {
      pause();
      const settled = boundaries[frame.moveNumber] ?? 0;
      if (index > settled) {
        seek(delta > 0 ? lastIndex : settled);
        return;
      }

      const target = frame.moveNumber + delta;
      if (target < 0) seek(0);
      else if (target > timeline.moves.length) seek(lastIndex);
      else seek(target === 0 ? 0 : boundaries[target] ?? 0);
    },
    [boundaries, frame.moveNumber, index, lastIndex, pause, seek, timeline.moves.length]
  );

  // Advancing is a chain of timeouts rather than one interval, because every
  // frame carries its own duration — the same pacing the live cascade uses.
  useEffect(() => {
    if (!isPlaying) return;
    if (index >= lastIndex) {
      setIsPlaying(false);
      return;
    }

    const hold = Math.max(16, frames[index].durationMs / speed);
    const timeoutId = window.setTimeout(() => {
      const next = frames[index + 1];
      // Sound fires only here, so scrubbing by hand stays silent.
      if (next.burst.size > 0) playSound("explode", (index + 1) / frames.length);
      else if (next.moveNumber !== frames[index].moveNumber) playSound("place");
      setIndex(index + 1);
    }, hold);

    return () => window.clearTimeout(timeoutId);
  }, [frames, index, isPlaying, lastIndex, speed]);

  // Read through a ref: the listener is bound once, and closing over the
  // handlers directly would pin them to the first frame.
  const keyHandlerRef = useRef<(event: KeyboardEvent) => void>(() => {});
  keyHandlerRef.current = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    if (target && /^(INPUT|SELECT|TEXTAREA)$/.test(target.tagName)) return;

    if (event.key === " ") {
      event.preventDefault();
      toggle();
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      if (event.shiftKey) jumpMove(1);
      else {
        pause();
        seek(index + 1);
      }
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (event.shiftKey) jumpMove(-1);
      else {
        pause();
        seek(index - 1);
      }
    } else if (event.key === "Home") {
      pause();
      seek(0);
    } else if (event.key === "End") {
      pause();
      seek(lastIndex);
    } else if (event.key === "Escape") {
      onExit();
    }
  };

  useEffect(() => {
    const listener = (event: KeyboardEvent) => keyHandlerRef.current(event);
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  const moveTotal = timeline.moves.length;
  const played = frame.moveNumber === 0 ? null : timeline.moves[frame.moveNumber - 1];
  const mover = played
    ? record.players.find((player) => player.id === played.playerId)?.name ?? "Someone"
    : null;

  const statusText = played
    ? frame.state.status === "finished" && frame.moveNumber === moveTotal
      ? `${mover} played row ${played.row + 1}, column ${played.col + 1} and took the board.`
      : `${mover} ${played.auto ? "ran out of time and the arena auto-played" : "played"} row ${
          played.row + 1
        }, column ${played.col + 1}.`
    : "The opening position.";

  const currentPlayer =
    frame.state.status === "playing"
      ? frame.state.players[frame.state.currentPlayerIndex] ?? null
      : null;

  const controls = (
    <section className={styles.card}>
      <h2 className={styles.title}>Replay</h2>

      <div className={styles.transport}>
        <button
          className={`button-reset ${styles.button}`}
          type="button"
          aria-label="Back to the start"
          onClick={() => {
            pause();
            seek(0);
          }}
        >
          &#9198;
        </button>
        <button
          className={`button-reset ${styles.button}`}
          type="button"
          aria-label="Previous move"
          onClick={() => jumpMove(-1)}
        >
          &#9664;
        </button>
        <button
          className={`button-reset ${styles.button} ${styles.play}`}
          type="button"
          aria-label={isPlaying ? "Pause" : "Play"}
          onClick={toggle}
        >
          {isPlaying ? "Pause" : "Play"}
        </button>
        <button
          className={`button-reset ${styles.button}`}
          type="button"
          aria-label="Next move"
          onClick={() => jumpMove(1)}
        >
          &#9654;
        </button>
        <button
          className={`button-reset ${styles.button}`}
          type="button"
          aria-label="Jump to the end"
          onClick={() => {
            pause();
            seek(lastIndex);
          }}
        >
          &#9197;
        </button>
      </div>

      <input
        className={styles.scrub}
        type="range"
        min={0}
        max={lastIndex}
        step={1}
        value={index}
        aria-label="Replay position"
        onChange={(event) => {
          pause();
          seek(Number(event.target.value));
        }}
      />

      <div className={styles.readout}>
        <span data-testid="replay-position">
          Move {frame.moveNumber} / {moveTotal}
        </span>
        <label className={styles.speed}>
          Speed
          <select
            className={styles.select}
            aria-label="Playback speed"
            value={speed}
            onChange={(event) => setSpeed(Number(event.target.value))}
          >
            {SPEEDS.map((option) => (
              <option key={option} value={option}>
                {option}x
              </option>
            ))}
          </select>
        </label>
      </div>

      {showDownload ? (
        <button
          className={`ghost-link button-reset ${styles.download}`}
          type="button"
          onClick={() => setSavedAs(downloadReplay(record))}
        >
          {savedAs ? "Saved to downloads" : "Download .html"}
        </button>
      ) : null}

      {timeline.truncatedAt !== null ? (
        <p className={styles.truncated} role="status">
          This replay stops at move {timeline.truncatedAt} — the record is incomplete.
        </p>
      ) : null}
    </section>
  );

  return (
    <MatchScreen
      game={frame.state}
      displayBoard={frame.board}
      flashCells={frame.flash}
      burstCells={frame.burst}
      frameTick={index}
      currentPlayer={currentPlayer}
      statusText={statusText}
      timerRemainingMs={0}
      turnProgress={lastIndex === 0 ? 1 : index / lastIndex}
      isResolving
      canAct={false}
      showClock={false}
      turnCardTitle="Position"
      turnLabel={`Replay · move ${frame.moveNumber} of ${moveTotal}`}
      seatBadge={(playerId) => badges.get(playerId) ?? null}
      sideExtra={controls}
      onCellClick={() => undefined}
      onLeave={onExit}
      leaveLabel="Close replay"
      showWinnerModal={false}
      onDismissWinner={() => undefined}
      onRematch={() => undefined}
      canRematch={false}
    />
  );
}
