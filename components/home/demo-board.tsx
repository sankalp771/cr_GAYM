"use client";

import { useEffect, useRef, useState } from "react";
import {
  PLAYER_COLORS,
  applyMove,
  chooseGreedyMove,
  createInitialState,
  criticalMass,
  type Board,
  type GameState,
  type Player
} from "@/lib/engine";
import { EMPTY_FLASH, cellKey, framesToSteps, stepDurations, type FlashSet } from "@/lib/cascade-animation";
import styles from "./demo-board.module.css";

/**
 * The landing page's board, playing itself.
 *
 * This is the real engine — `chooseGreedyMove` picking, `applyMove` resolving,
 * `framesToSteps` pacing — not a hand-authored loop of pretty frames. The page
 * that sells a game about chain reactions should show one happening, and the
 * cheapest way to keep that honest is to make it impossible for the demo and
 * the game to disagree: if a rule changes, this changes with it.
 *
 * Three things keep it from being a battery tax:
 *
 * - It stops when scrolled out of view, and when the tab is hidden.
 * - It is 6x6, which is small enough that a greedy ply is free.
 * - Under `prefers-reduced-motion` it never animates at all — it plays a fixed,
 *   seeded game to a mid-match position and shows that still. The cascade
 *   exemption in the arena does not apply here, because on this page the motion
 *   really is decoration.
 */

const ROWS = 6;
const COLS = 6;

/** Pink, teal and amber — three of the game's own seat colours, far apart on the wheel. */
const DEMO_PLAYERS: Player[] = [0, 1, 2].map((index) => ({
  id: `demo-${index}`,
  name: `Demo ${index + 1}`,
  color: PLAYER_COLORS[index],
  hasEnteredPlay: false,
  isEliminated: false
}));

/** Shorter than a real match's budget: this is a background loop, not a turn. */
const DEMO_CASCADE_BUDGET_MS = 1500;
const BETWEEN_MOVES_MS = 520;
const AFTER_WIN_MS = 1700;
const REDUCED_MOTION_MOVES = 16;

const freshState = (): GameState => createInitialState({ rows: ROWS, cols: COLS }, DEMO_PLAYERS);

/**
 * A tiny LCG, used only for the reduced-motion still.
 *
 * The engine takes its randomness as an argument precisely so a caller can pin
 * it, and a fixed seed here means every visitor who prefers reduced motion sees
 * the same considered position rather than whatever chance produced.
 */
function seededRandom(seed: number): () => number {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x100000000;
  };
}

function staticPosition(): Board {
  const random = seededRandom(0x5eed);
  let state = freshState();

  for (let index = 0; index < REDUCED_MOTION_MOVES; index += 1) {
    const move = chooseGreedyMove(state, random);
    if (!move) break;
    state = applyMove(state, move).state;
    if (state.status === "finished") break;
  }

  return state.board;
}

export function DemoBoard() {
  const [board, setBoard] = useState<Board>(() => freshState().board);
  const [flash, setFlash] = useState<FlashSet>(EMPTY_FLASH);
  const [burst, setBurst] = useState<FlashSet>(EMPTY_FLASH);
  const [active, setActive] = useState(false);

  const frameRef = useRef<HTMLDivElement>(null);
  /**
   * The match survives being paused.
   *
   * Scrolling the board out of view tears the playback effect down, and holding
   * the position here is what lets it resume rather than restart. Keeping it in
   * component state instead would restart the game every time it re-entered the
   * viewport — scroll down, scroll back, and the board is empty again.
   */
  const stateRef = useRef<GameState | null>(null);

  // Only play while the board is both on screen and in a foreground tab.
  useEffect(() => {
    const node = frameRef.current;
    if (!node) return;

    let onScreen = false;

    const sync = () => setActive(onScreen && !document.hidden);

    const observer = new IntersectionObserver(
      ([entry]) => {
        onScreen = entry.isIntersecting;
        sync();
      },
      { threshold: 0.15 }
    );
    observer.observe(node);
    document.addEventListener("visibilitychange", sync);

    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", sync);
    };
  }, []);

  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduced) {
      setBoard(staticPosition());
      return;
    }
    if (!active) return;

    let cancelled = false;
    const timers: number[] = [];

    const wait = (ms: number) =>
      new Promise<void>((resolve) => {
        timers.push(window.setTimeout(resolve, ms));
      });

    const run = async () => {
      if (!stateRef.current) stateRef.current = freshState();

      // Paint the resumed position before playing on, so a board interrupted
      // mid-cascade does not carry a half-resolved frame into the next move.
      const resuming = stateRef.current.moveCount > 0;
      setBoard(stateRef.current.board);
      setFlash(EMPTY_FLASH);
      setBurst(EMPTY_FLASH);
      await wait(resuming ? 320 : 650);

      while (!cancelled) {
        const state = stateRef.current;
        if (!state) return;

        if (state.status === "finished") {
          await wait(AFTER_WIN_MS);
          if (cancelled) return;
          stateRef.current = freshState();
          setBoard(stateRef.current.board);
          setFlash(EMPTY_FLASH);
          setBurst(EMPTY_FLASH);
          await wait(600);
          continue;
        }

        const move = chooseGreedyMove(state, Math.random);
        if (!move) return;

        const result = applyMove(state, move, { recordFrames: true });
        // Commit before animating: if playback is interrupted part-way through
        // the cascade, the resumed position is the finished one, not a frame.
        stateRef.current = result.state;

        const steps = framesToSteps(result.frames);
        const durations = stepDurations(steps.length, DEMO_CASCADE_BUDGET_MS);

        for (const [index, step] of steps.entries()) {
          if (cancelled) return;
          setBoard(step.board);
          setFlash(step.flash);
          setBurst(step.burst);
          await wait(durations[index] ?? 60);
        }

        if (cancelled) return;
        setBoard(result.state.board);
        setFlash(EMPTY_FLASH);
        setBurst(EMPTY_FLASH);
        await wait(BETWEEN_MOVES_MS);
      }
    };

    void run();

    return () => {
      cancelled = true;
      timers.forEach((id) => window.clearTimeout(id));
    };
  }, [active]);

  return (
    <div
      ref={frameRef}
      className={styles.frame}
      data-testid="demo-board"
      role="img"
      aria-label="A demonstration match playing itself: three colours trading orbs on a six by six board."
    >
      <div className={styles.board} style={{ gridTemplateColumns: `repeat(${COLS}, 1fr)` }}>
        {board.flatMap((row) =>
          row.map((cell) => {
            const key = cellKey(cell.row, cell.col);
            const limit = criticalMass(cell.row, cell.col, { rows: ROWS, cols: COLS });

            return (
              <div
                key={key}
                className={styles.cell}
                data-testid="demo-cell"
                data-flash={flash.has(key) ? "1" : undefined}
                data-burst={burst.has(key) ? "1" : undefined}
                /* One orb short of detonating — the tension the whole game runs on. */
                data-primed={cell.count === limit - 1 ? "1" : undefined}
              >
                {cell.ownerId ? (
                  <span className={styles.orbs} style={{ ["--player-color" as string]: colorFor(cell.ownerId) }}>
                    {Array.from({ length: Math.min(cell.count, 4) }, (_, index) => (
                      <span key={index} className={styles.orb} />
                    ))}
                  </span>
                ) : null}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

function colorFor(playerId: string): string {
  const player = DEMO_PLAYERS.find((entry) => entry.id === playerId);
  return player?.color ?? PLAYER_COLORS[0];
}
