"use client";

import type { CSSProperties } from "react";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  applyMove,
  BOARD_PRESETS,
  createEmptyBoard,
  createInitialState,
  criticalMass,
  isLegalMove,
  PLAYER_COLORS,
  pickAutoMove,
  TURN_SECONDS,
  type Board,
  type GameState,
  type GridConfig,
  type Player,
  type PresetId
} from "@/lib/engine";

type GamePhase = "setup" | "playing" | "finished";

/** Cells lit up by the step currently on screen, keyed "row,col". */
type FlashSet = ReadonlySet<string>;

const FRAME_MS = 140;
const VICTORY_FRAME_MS = 100;
const EMPTY_FLASH: FlashSet = new Set<string>();

const cellKey = (row: number, col: number) => `${row},${col}`;

function configForPreset(presetId: PresetId): GridConfig {
  const { size } = BOARD_PRESETS[presetId];
  return { rows: size, cols: size };
}

function buildPlayers(playerNames: string[]): Player[] {
  return playerNames.map((name, index) => ({
    id: `player-${index + 1}`,
    name: name.trim() || `Player ${index + 1}`,
    color: PLAYER_COLORS[index],
    hasEnteredPlay: false,
    isEliminated: false
  }));
}

function countPlayerOrbsOnBoard(board: Board, playerId: string) {
  return board.reduce(
    (sum, row) => sum + row.reduce((rowSum, cell) => rowSum + (cell.ownerId === playerId ? cell.count : 0), 0),
    0
  );
}

/**
 * Purely cosmetic end-of-match sweep: repaint every occupied cell in the
 * winner's colour, one at a time. This is presentation, not a rule, which is why
 * it lives here rather than in the engine.
 */
function buildVictorySweep(board: Board, winnerId: string): Array<{ board: Board; flash: FlashSet }> {
  const working = board.map((row) => row.map((cell) => ({ ...cell })));
  const occupied = working.flat().filter((cell) => cell.count > 0);

  return occupied.map((cell) => {
    working[cell.row][cell.col].ownerId = winnerId;
    return {
      board: working.map((row) => row.map((entry) => ({ ...entry }))),
      flash: new Set([cellKey(cell.row, cell.col)])
    };
  });
}

function createOrbMarkup(count: number, color: string) {
  return Array.from({ length: count }, (_, index) => (
    <span
      key={`${color}-${count}-${index}`}
      className={`orb count-${Math.min(count, 4)}`}
      style={{ ["--player-color" as string]: color }}
    />
  ));
}

const panelReveal = {
  initial: { opacity: 0, y: 24, filter: "blur(10px)" },
  animate: { opacity: 1, y: 0, filter: "blur(0px)" },
  transition: { duration: 0.45, ease: [0.22, 1, 0.36, 1] as const }
};

const staggerList = {
  animate: {
    transition: {
      staggerChildren: 0.05,
      delayChildren: 0.06
    }
  }
};

export function LocalArena() {
  const [presetId, setPresetId] = useState<PresetId>("classic");
  const [playerCount, setPlayerCount] = useState(2);
  const [playerNames, setPlayerNames] = useState<string[]>(["Player 1", "Player 2"]);

  // The authoritative match state lives in the engine. Everything else in this
  // component is presentation: which frame is on screen, what the status line
  // says, whether the modal is open.
  const [game, setGame] = useState<GameState | null>(null);
  const [displayBoard, setDisplayBoard] = useState<Board>(() => createEmptyBoard(configForPreset("classic")));
  const [flashCells, setFlashCells] = useState<FlashSet>(EMPTY_FLASH);
  const [frameTick, setFrameTick] = useState(0);

  const [phase, setPhase] = useState<GamePhase>("setup");
  const [statusText, setStatusText] = useState("Configure the arena and launch a local battle.");
  const [timerRemainingMs, setTimerRemainingMs] = useState(TURN_SECONDS * 1000);
  const [showWinnerModal, setShowWinnerModal] = useState(false);
  const [isResolving, setIsResolving] = useState(false);

  const turnStartedAtRef = useRef<number>(0);
  const intervalRef = useRef<number | null>(null);
  const timeoutRef = useRef<number[]>([]);
  const autoMoveFiredRef = useRef(false);

  const config = useMemo(() => configForPreset(presetId), [presetId]);
  const players = useMemo(() => game?.players ?? [], [game]);
  const currentPlayer = game && game.status === "playing" ? players[game.currentPlayerIndex] ?? null : null;
  const winner = players.find((player) => player.id === game?.winnerId) ?? null;
  const activePlayers = useMemo(() => players.filter((player) => !player.isEliminated), [players]);
  const nextPlayer = useMemo(() => {
    if (!game || game.status !== "playing" || players.length < 2) return null;
    for (let step = 1; step <= players.length; step += 1) {
      const candidate = players[(game.currentPlayerIndex + step) % players.length];
      if (!candidate.isEliminated) return candidate;
    }
    return null;
  }, [game, players]);

  useEffect(() => {
    setPlayerNames((previous) =>
      Array.from({ length: playerCount }, (_, index) => previous[index] ?? `Player ${index + 1}`)
    );
  }, [playerCount]);

  function clearPendingTimeouts() {
    timeoutRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
    timeoutRef.current = [];
  }

  useEffect(() => {
    return () => {
      timeoutRef.current.forEach((timeoutId) => window.clearTimeout(timeoutId));
      timeoutRef.current = [];
    };
  }, []);

  const waitForFrame = useCallback((delayMs: number) => {
    return new Promise<void>((resolve) => {
      const timeoutId = window.setTimeout(() => {
        timeoutRef.current = timeoutRef.current.filter((entry) => entry !== timeoutId);
        resolve();
      }, delayMs);

      timeoutRef.current.push(timeoutId);
    });
  }, []);

  const playFrames = useCallback(
    async (steps: Array<{ board: Board; flash: FlashSet }>, delayMs: number) => {
      for (const step of steps) {
        setDisplayBoard(step.board);
        setFlashCells(step.flash);
        setFrameTick((tick) => tick + 1);
        await waitForFrame(delayMs);
      }
    },
    [waitForFrame]
  );

  const runMove = useCallback(
    async (row: number, col: number, isAutoMove: boolean) => {
      if (!game || game.status !== "playing" || isResolving) return;

      const actingPlayer = game.players[game.currentPlayerIndex];
      const move = { playerId: actingPlayer.id, row, col };
      if (!isLegalMove(game, move)) return;

      const result = applyMove(game, move, { recordFrames: true });

      setIsResolving(true);
      setStatusText(
        isAutoMove
          ? `${actingPlayer.name} ran out of time, so the arena auto-played the spread tile by tile.`
          : `${actingPlayer.name} triggered a chain reaction.`
      );

      await playFrames(
        result.frames.map((frame) => ({
          board: frame.board,
          flash: new Set([
            ...frame.exploded.map((cell) => cellKey(cell.row, cell.col)),
            ...frame.received.map((cell) => cellKey(cell.row, cell.col))
          ])
        })),
        FRAME_MS
      );

      setGame(result.state);
      setDisplayBoard(result.state.board);
      setFlashCells(EMPTY_FLASH);

      if (result.state.status === "finished" && result.state.winnerId) {
        const championName =
          result.state.players.find((player) => player.id === result.state.winnerId)?.name ?? "Someone";
        setStatusText(`${championName} is consuming the board.`);

        const sweep = buildVictorySweep(result.state.board, result.state.winnerId);
        if (sweep.length > 0) await playFrames(sweep, VICTORY_FRAME_MS);

        setPhase("finished");
        setShowWinnerModal(true);
        setIsResolving(false);
        setTimerRemainingMs(0);
        setStatusText(`${championName} detonated the deciding chain reaction.`);
        return;
      }

      setIsResolving(false);
      setStatusText(
        isAutoMove
          ? `${actingPlayer.name} ran out of time, so the arena auto-played a valid move.`
          : `${actingPlayer.name} made a move and shifted the board pressure.`
      );
    },
    [game, isResolving, playFrames]
  );

  // The turn timer reads the move handler through a ref rather than closing over
  // it. The interval is created once per turn, so capturing the handler directly
  // would pin it to that render's board and current player, and the auto-played
  // move would be computed from stale state.
  const autoMoveRef = useRef<() => void>(() => {});
  autoMoveRef.current = () => {
    if (!game || game.status !== "playing" || isResolving || autoMoveFiredRef.current) return;
    const move = pickAutoMove(game, Math.random);
    if (!move) return;
    autoMoveFiredRef.current = true;
    void runMove(move.row, move.col, true);
  };

  useEffect(() => {
    if (phase !== "playing" || isResolving) {
      if (intervalRef.current) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    turnStartedAtRef.current = Date.now();
    autoMoveFiredRef.current = false;
    setTimerRemainingMs(TURN_SECONDS * 1000);

    intervalRef.current = window.setInterval(() => {
      const remaining = Math.max(0, TURN_SECONDS * 1000 - (Date.now() - turnStartedAtRef.current));
      setTimerRemainingMs(remaining);
      if (remaining === 0) autoMoveRef.current();
    }, 100);

    return () => {
      if (intervalRef.current) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [phase, isResolving, game?.currentPlayerIndex]);

  function startGame() {
    clearPendingTimeouts();
    const nextConfig = configForPreset(presetId);
    const freshGame = createInitialState(nextConfig, buildPlayers(playerNames.slice(0, playerCount)));

    setGame(freshGame);
    setDisplayBoard(freshGame.board);
    setFlashCells(EMPTY_FLASH);
    setPhase("playing");
    setShowWinnerModal(false);
    setIsResolving(false);
    setTimerRemainingMs(TURN_SECONDS * 1000);
    setStatusText(`${freshGame.players[0].name} enters the arena first.`);
  }

  function resetSetup() {
    clearPendingTimeouts();
    setGame(null);
    setDisplayBoard(createEmptyBoard(configForPreset(presetId)));
    setFlashCells(EMPTY_FLASH);
    setPhase("setup");
    setShowWinnerModal(false);
    setIsResolving(false);
    setStatusText("Configure the arena and launch a local battle.");
    setTimerRemainingMs(TURN_SECONDS * 1000);
  }

  // Keep the idle board in step with the preset while still in setup.
  useEffect(() => {
    if (phase === "setup") setDisplayBoard(createEmptyBoard(configForPreset(presetId)));
  }, [presetId, phase]);

  const boardConfig = game?.config ?? config;

  return (
    <motion.main
      className="mode-shell"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: 0.35, ease: "easeOut" }}
    >
      <div className="ambient ambient-a" />
      <div className="ambient ambient-b" />
      <div className="background-grid" />

      <motion.section
        className="mode-header-card local-header-card border border-white/10 bg-white/5 shadow-[0_30px_80px_rgba(0,0,0,0.35)] backdrop-blur-xl"
        {...panelReveal}
      >
        <div>
          <div className="eyebrow">Local Mode</div>
          <h1 className="max-w-3xl">Local Arena</h1>
          <p className="hero-copy max-w-2xl">
            A board-first battle layout inspired by competitive neon game HUDs, now with staged reactions and a cinematic finish.
          </p>
        </div>

        <motion.div className="header-actions" variants={staggerList} initial="initial" animate="animate">
          <Link href="/" className="ghost-link">Back Home</Link>
          <button className="primary-link button-reset" onClick={startGame} type="button">Start Battle</button>
        </motion.div>
      </motion.section>

      <section className="arena-layout">
        <section className="board-stage">
          <motion.aside className="arena-sidecard border border-cyan-200/10 bg-slate-950/55" {...panelReveal} transition={{ ...panelReveal.transition, delay: 0.05 }}>
            <motion.article className="status-cluster" variants={staggerList} initial="initial" animate="animate">
              <div className="card-title-row compact-title-row">
                <h2>Battle Setup</h2>
                <span className="mode-badge">
                  {BOARD_PRESETS[presetId].label} {BOARD_PRESETS[presetId].size}x{BOARD_PRESETS[presetId].size}
                </span>
              </div>

              <div className="form-grid">
                <label className="field-label">
                  <span>Board Preset</span>
                  <select value={presetId} onChange={(event) => setPresetId(event.target.value as PresetId)} disabled={phase === "playing"}>
                    {Object.values(BOARD_PRESETS).map((preset) => (
                      <option key={preset.id} value={preset.id}>
                        {preset.label} ({preset.size})
                      </option>
                    ))}
                  </select>
                </label>

                <label className="field-label">
                  <span>Players</span>
                  <select value={playerCount} onChange={(event) => setPlayerCount(Number(event.target.value))} disabled={phase === "playing"}>
                    {Array.from({ length: 7 }, (_, index) => index + 2).map((count) => (
                      <option key={count} value={count}>
                        {count} Players
                      </option>
                    ))}
                  </select>
                </label>
              </div>

              <div className="form-grid names-grid">
                {playerNames.slice(0, playerCount).map((name, index) => (
                  <label key={`player-name-${index + 1}`} className="field-label">
                    <span>Player {index + 1} Name</span>
                    <input
                      value={name}
                      disabled={phase === "playing"}
                      onChange={(event) =>
                        setPlayerNames((previous) => previous.map((entry, entryIndex) => (entryIndex === index ? event.target.value : entry)))
                      }
                    />
                  </label>
                ))}
              </div>

              <div className="button-row">
                <motion.button whileHover={{ y: -2, scale: 1.01 }} whileTap={{ scale: 0.98 }} className="primary-link button-reset" type="button" onClick={startGame}>
                  Start Battle
                </motion.button>
                <motion.button whileHover={{ y: -2 }} whileTap={{ scale: 0.98 }} className="ghost-link button-reset" type="button" onClick={resetSetup}>
                  Reset
                </motion.button>
              </div>
            </motion.article>
          </motion.aside>

          <motion.section className="board-panel main-stage-panel" {...panelReveal} transition={{ ...panelReveal.transition, delay: 0.1 }}>
            <motion.div
              className="stage-status border border-white/8 bg-slate-950/60"
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.45, delay: 0.12 }}
            >
              <div className="stage-copy">
                <span className="stage-kicker">Live Match Feed</span>
                <h2>{phase === "playing" ? `${currentPlayer?.name ?? "Player"} controls the next move` : "Prepare the chain reaction"}</h2>
                <p>{statusText}</p>
              </div>

              <motion.div className="stage-metrics" variants={staggerList} initial="initial" animate="animate">
                <motion.div className="metric-chip" {...panelReveal} transition={{ duration: 0.32, delay: 0.16 }}>
                  <span>Preset</span>
                  <strong>{BOARD_PRESETS[presetId].label}</strong>
                </motion.div>
                <motion.div className="metric-chip" {...panelReveal} transition={{ duration: 0.32, delay: 0.2 }}>
                  <span>Players</span>
                  <strong>{playerCount}</strong>
                </motion.div>
                <motion.div className="metric-chip" {...panelReveal} transition={{ duration: 0.32, delay: 0.24 }}>
                  <span>Next</span>
                  <strong>{nextPlayer?.name ?? "Waiting"}</strong>
                </motion.div>
              </motion.div>
            </motion.div>

            <motion.div
              className="board-frame next-board-frame border border-cyan-200/10 bg-slate-950/45"
              initial={{ opacity: 0, scale: 0.98, y: 24 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              transition={{ duration: 0.55, delay: 0.18 }}
            >
              <motion.div
                className="board"
                animate={isResolving ? { scale: [1, 1.006, 1] } : { scale: 1 }}
                transition={isResolving ? { duration: 0.35, repeat: Number.POSITIVE_INFINITY, repeatType: "mirror" } : { duration: 0.2 }}
                style={{
                  gridTemplateColumns: `repeat(${boardConfig.cols}, minmax(0, 1fr))`,
                  ["--turn-color" as string]: currentPlayer?.color ?? "#8ef9ff"
                }}
              >
                {displayBoard.flat().map((cell) => {
                  const owner = players.find((player) => player.id === cell.ownerId) ?? null;
                  const playable =
                    phase === "playing" && currentPlayer && !isResolving
                      ? cell.ownerId === null || cell.ownerId === currentPlayer.id
                      : false;
                  const critical = cell.count > 0 && cell.count === criticalMass(cell.row, cell.col, boardConfig) - 1;
                  const isFlashing = flashCells.has(cellKey(cell.row, cell.col));

                  return (
                    <motion.button
                      // The flash key changes only for cells lit by the current
                      // step, remounting just those so the glow animation replays.
                      key={`${cell.row}-${cell.col}-${isFlashing ? frameTick : 0}`}
                      className={`cell ${playable ? "playable" : "blocked"} ${critical && owner ? "critical" : ""} ${isFlashing ? "flash energized" : ""}`}
                      whileHover={playable ? { scale: 1.03 } : undefined}
                      whileTap={playable ? { scale: 0.97 } : undefined}
                      style={owner ? ({ ["--player-color" as string]: owner.color } as CSSProperties) : undefined}
                      disabled={!playable}
                      onClick={() => void runMove(cell.row, cell.col, false)}
                      type="button"
                      aria-label={
                        owner
                          ? `Row ${cell.row + 1}, column ${cell.col + 1}: ${cell.count} ${cell.count === 1 ? "orb" : "orbs"} owned by ${owner.name}`
                          : `Row ${cell.row + 1}, column ${cell.col + 1}: empty`
                      }
                    >
                      {cell.count > 0 && owner ? <div className="orb-stack">{createOrbMarkup(cell.count, owner.color)}</div> : null}
                    </motion.button>
                  );
                })}
              </motion.div>
            </motion.div>
          </motion.section>

          <motion.aside className="arena-sidecard border border-cyan-200/10 bg-slate-950/55" {...panelReveal} transition={{ ...panelReveal.transition, delay: 0.15 }}>
            <motion.article className="status-cluster" variants={staggerList} initial="initial" animate="animate">
              <div className="card-title-row compact-title-row">
                <h2>Round Intel</h2>
                <span className="mode-badge">{phase.toUpperCase()}</span>
              </div>
              <div className="stats-grid">
                <div className="stat-box">
                  <span className="stat-label">Current</span>
                  <strong>{currentPlayer?.name ?? "Not started"}</strong>
                </div>
                <div className="stat-box">
                  <span className="stat-label">Next</span>
                  <strong>{nextPlayer?.name ?? "Waiting"}</strong>
                </div>
              </div>
              <div className="turn-progress">
                <motion.div
                  className="turn-progress-bar"
                  animate={{ width: `${(timerRemainingMs / (TURN_SECONDS * 1000)) * 100}%` }}
                  transition={{ ease: "linear", duration: 0.12 }}
                  style={{ ["--turn-color" as string]: currentPlayer?.color ?? "#8ef9ff" }}
                />
              </div>
              <p className="info-copy">{statusText}</p>
            </motion.article>

            <motion.article className="status-cluster" variants={staggerList} initial="initial" animate="animate">
              <div className="card-title-row compact-title-row">
                <h2>Lineup</h2>
                <span className="mode-badge">{activePlayers.length} Active</span>
              </div>
              <motion.div className="player-list" layout>
                {players.map((player) => (
                  <motion.article
                    key={player.id}
                    layout
                    initial={{ opacity: 0, x: 16 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.3 }}
                    className={`player-line ${currentPlayer?.id === player.id && phase === "playing" ? "current" : ""}`}
                    style={{ ["--player-color" as string]: player.color }}
                  >
                    <div className="player-line-main">
                      <span className="player-dot" />
                      <div>
                        <strong>{player.name}</strong>
                        <p>{countPlayerOrbsOnBoard(displayBoard, player.id)} orbs on board</p>
                      </div>
                    </div>
                    <span className={`player-tag ${player.isEliminated ? "eliminated" : ""}`}>
                      {player.isEliminated ? "Spectating" : currentPlayer?.id === player.id && phase === "playing" ? "Turn" : "Live"}
                    </span>
                  </motion.article>
                ))}
              </motion.div>
            </motion.article>
          </motion.aside>
        </section>
      </section>

      <AnimatePresence>
        {showWinnerModal && winner ? (
          <motion.div className="modal-shell" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <motion.div className="modal-backdrop" onClick={() => setShowWinnerModal(false)} />
            <motion.div
              className="modal-card victory-card border border-cyan-200/20 bg-slate-950/78"
              initial={{ opacity: 0, y: 28, scale: 0.94 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 20, scale: 0.96 }}
              transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
            >
              <div className="eyebrow">Victory Sequence</div>
              <h2>{winner.name} Wins</h2>
              <p className="modal-copy">{winner.name} controlled the final chain reaction and cleared the board pressure.</p>
              <div className="victory-stats">
                <div className="victory-chip">
                  <span>Winner</span>
                  <strong>{winner.name}</strong>
                </div>
                <div className="victory-chip">
                  <span>Still Active</span>
                  <strong>{activePlayers.length}</strong>
                </div>
                <div className="victory-chip">
                  <span>Preset</span>
                  <strong>{BOARD_PRESETS[presetId].label}</strong>
                </div>
              </div>
              <div className="modal-actions">
                <motion.button whileHover={{ y: -2, scale: 1.01 }} whileTap={{ scale: 0.98 }} className="primary-link button-reset" type="button" onClick={startGame}>
                  Rematch
                </motion.button>
                <motion.button whileHover={{ y: -2 }} whileTap={{ scale: 0.98 }} className="ghost-link button-reset" type="button" onClick={() => setShowWinnerModal(false)}>
                  Close
                </motion.button>
              </div>
            </motion.div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </motion.main>
  );
}
