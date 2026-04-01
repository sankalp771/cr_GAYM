"use client";

import type { CSSProperties } from "react";
import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  applyMove,
  BOARD_PRESETS,
  countPlayerOrbs,
  createEmptyBoard,
  getCriticalMass,
  getValidMoves,
  isCellPlayable,
  PLAYER_COLORS,
  type Cell,
  type Player,
  type PresetId,
  TURN_SECONDS
} from "@/lib/local-game";

type GamePhase = "setup" | "playing" | "finished";

function buildPlayers(playerNames: string[]): Player[] {
  return playerNames.map((name, index) => ({
    id: `player-${index + 1}`,
    name: name.trim() || `Player ${index + 1}`,
    color: PLAYER_COLORS[index],
    hasEnteredPlay: false,
    isEliminated: false
  }));
}

function nextLivingPlayer(players: Player[], currentIndex: number) {
  for (let step = 1; step <= players.length; step += 1) {
    const candidateIndex = (currentIndex + step) % players.length;
    if (!players[candidateIndex].isEliminated) {
      return candidateIndex;
    }
  }
  return currentIndex;
}

function createOrbMarkup(count: number, color: string) {
  return Array.from({ length: count }, (_, index) => (
    <span key={`${color}-${count}-${index}`} className={`orb count-${Math.min(count, 4)}`} style={{ ["--player-color" as string]: color }} />
  ));
}

export function LocalArena() {
  const [presetId, setPresetId] = useState<PresetId>("classic");
  const [playerCount, setPlayerCount] = useState(2);
  const [playerNames, setPlayerNames] = useState<string[]>(["Player 1", "Player 2"]);
  const [players, setPlayers] = useState<Player[]>([]);
  const [board, setBoard] = useState<Cell[][]>(() => createEmptyBoard(BOARD_PRESETS.classic.size));
  const [phase, setPhase] = useState<GamePhase>("setup");
  const [currentPlayerIndex, setCurrentPlayerIndex] = useState(0);
  const [moveCount, setMoveCount] = useState(0);
  const [winnerId, setWinnerId] = useState<string | null>(null);
  const [statusText, setStatusText] = useState("Configure the arena and launch a local battle.");
  const [timerRemainingMs, setTimerRemainingMs] = useState(TURN_SECONDS * 1000);
  const [showWinnerModal, setShowWinnerModal] = useState(false);
  const turnStartedAtRef = useRef<number>(0);
  const intervalRef = useRef<number | null>(null);

  const currentPlayer = players[currentPlayerIndex] ?? null;
  const winner = players.find((player) => player.id === winnerId) ?? null;
  const activePlayers = useMemo(() => players.filter((player) => !player.isEliminated), [players]);
  const nextPlayer = useMemo(() => {
    if (players.length < 2) return null;
    return players[nextLivingPlayer(players, currentPlayerIndex)] ?? null;
  }, [players, currentPlayerIndex]);

  useEffect(() => {
    setPlayerNames((previous) => Array.from({ length: playerCount }, (_, index) => previous[index] ?? `Player ${index + 1}`));
  }, [playerCount]);

  useEffect(() => {
    if (phase !== "playing") {
      if (intervalRef.current) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      return;
    }

    turnStartedAtRef.current = Date.now();
    setTimerRemainingMs(TURN_SECONDS * 1000);

    intervalRef.current = window.setInterval(() => {
      const remaining = Math.max(0, TURN_SECONDS * 1000 - (Date.now() - turnStartedAtRef.current));
      setTimerRemainingMs(remaining);

      if (remaining === 0) {
        handleAutoMove();
      }
    }, 100);

    return () => {
      if (intervalRef.current) {
        window.clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };
  }, [phase, currentPlayerIndex]);

  function evaluateEliminations(nextBoard: Cell[][], nextPlayers: Player[], nextMoveCount: number) {
    if (nextMoveCount < nextPlayers.length) {
      return nextPlayers;
    }

    return nextPlayers.map((player) => {
      const owned = countPlayerOrbs(nextBoard, player.id);
      if (player.hasEnteredPlay && owned === 0) {
        return { ...player, isEliminated: true };
      }
      return player;
    });
  }

  function finishGame(nextPlayers: Player[], nextWinnerId: string) {
    setPlayers(nextPlayers);
    setWinnerId(nextWinnerId);
    setPhase("finished");
    setShowWinnerModal(true);
    const winnerPlayer = nextPlayers.find((player) => player.id === nextWinnerId);
    setStatusText(winnerPlayer ? `${winnerPlayer.name} detonated the deciding chain reaction.` : "Match finished.");
    setTimerRemainingMs(0);
  }

  function handleMove(row: number, col: number, isAutoMove: boolean) {
    if (phase !== "playing" || !currentPlayer) {
      return;
    }

    const cell = board[row][col];
    if (!isCellPlayable(cell, currentPlayer.id)) {
      return;
    }

    const nextBoard = applyMove(board, currentPlayer.id, row, col);
    const nextMoveCount = moveCount + 1;
    const nextPlayers = evaluateEliminations(
      nextBoard,
      players.map((player) => (player.id === currentPlayer.id ? { ...player, hasEnteredPlay: true } : { ...player })),
      nextMoveCount
    );

    setBoard(nextBoard);
    setMoveCount(nextMoveCount);

    const alivePlayers = nextPlayers.filter((player) => !player.isEliminated);
    if (nextMoveCount >= nextPlayers.length && alivePlayers.length === 1) {
      finishGame(nextPlayers, alivePlayers[0].id);
      return;
    }

    setPlayers(nextPlayers);
    setCurrentPlayerIndex((previous) => nextLivingPlayer(nextPlayers, previous));
    setStatusText(
      isAutoMove
        ? `${currentPlayer.name} ran out of time, so the arena auto-played a valid move.`
        : `${currentPlayer.name} made a move and shifted the board pressure.`
    );
  }

  function handleAutoMove() {
    if (!currentPlayer) return;
    const validMoves = getValidMoves(board, currentPlayer.id);
    if (validMoves.length === 0) return;
    const move = validMoves[Math.floor(Math.random() * validMoves.length)];
    handleMove(move.row, move.col, true);
  }

  function startGame() {
    const freshPlayers = buildPlayers(playerNames.slice(0, playerCount));
    setPlayers(freshPlayers);
    setBoard(createEmptyBoard(BOARD_PRESETS[presetId].size));
    setPhase("playing");
    setCurrentPlayerIndex(0);
    setMoveCount(0);
    setWinnerId(null);
    setShowWinnerModal(false);
    setTimerRemainingMs(TURN_SECONDS * 1000);
    setStatusText(`${freshPlayers[0].name} enters the arena first.`);
  }

  function resetSetup() {
    setPlayers([]);
    setBoard(createEmptyBoard(BOARD_PRESETS[presetId].size));
    setPhase("setup");
    setCurrentPlayerIndex(0);
    setMoveCount(0);
    setWinnerId(null);
    setShowWinnerModal(false);
    setStatusText("Configure the arena and launch a local battle.");
    setTimerRemainingMs(TURN_SECONDS * 1000);
  }

  return (
    <main className="mode-shell">
      <div className="ambient ambient-a" />
      <div className="ambient ambient-b" />
      <div className="background-grid" />

      <section className="mode-header-card local-header-card">
        <div>
          <div className="eyebrow">Local Mode</div>
          <h1>Local Arena</h1>
          <p className="hero-copy">A board-first battle layout inspired by competitive neon game HUDs, while keeping the gameplay intact.</p>
        </div>

        <div className="header-actions">
          <Link href="/" className="ghost-link">Back Home</Link>
          <button className="primary-link button-reset" onClick={startGame} type="button">Start Battle</button>
        </div>
      </section>

      <section className="arena-layout">
        <section className="board-stage">
          <aside className="arena-sidecard">
            <article className="status-cluster">
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
                <button className="primary-link button-reset" type="button" onClick={startGame}>
                  Start Battle
                </button>
                <button className="ghost-link button-reset" type="button" onClick={resetSetup}>
                  Reset
                </button>
              </div>
            </article>
          </aside>

          <section className="board-panel main-stage-panel">
            <div className="stage-status">
              <div className="stage-copy">
                <span className="stage-kicker">Live Match Feed</span>
                <h2>{phase === "playing" ? `${currentPlayer?.name ?? "Player"} controls the next move` : "Prepare the chain reaction"}</h2>
                <p>{statusText}</p>
              </div>

              <div className="stage-metrics">
                <div className="metric-chip">
                  <span>Preset</span>
                  <strong>{BOARD_PRESETS[presetId].label}</strong>
                </div>
                <div className="metric-chip">
                  <span>Players</span>
                  <strong>{playerCount}</strong>
                </div>
                <div className="metric-chip">
                  <span>Next</span>
                  <strong>{nextPlayer?.name ?? "Waiting"}</strong>
                </div>
              </div>
            </div>

            <div className="board-frame next-board-frame">
              <div className="board" style={{ gridTemplateColumns: `repeat(${board.length}, minmax(0, 1fr))`, ["--turn-color" as string]: currentPlayer?.color ?? "#8ef9ff" }}>
                {board.flat().map((cell) => {
                  const owner = players.find((player) => player.id === cell.ownerId) ?? null;
                  const playable = phase === "playing" && currentPlayer ? isCellPlayable(cell, currentPlayer.id) : false;
                  const critical = cell.count > 0 && cell.count === getCriticalMass(board, cell.row, cell.col) - 1;

                  return (
                    <button
                      key={`${cell.row}-${cell.col}-${cell.flashTick}-${cell.count}-${cell.ownerId ?? "empty"}`}
                      className={`cell ${playable ? "playable" : "blocked"} ${critical && owner ? "critical" : ""} ${Date.now() - cell.flashTick < 380 ? "flash energized" : ""}`}
                      style={owner ? ({ ["--player-color" as string]: owner.color } as CSSProperties) : undefined}
                      onClick={() => handleMove(cell.row, cell.col, false)}
                      type="button"
                    >
                      {cell.count > 0 && owner ? <div className="orb-stack">{createOrbMarkup(cell.count, owner.color)}</div> : null}
                    </button>
                  );
                })}
              </div>
            </div>
          </section>

          <aside className="arena-sidecard">
            <article className="status-cluster">
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
                <div className="turn-progress-bar" style={{ width: `${(timerRemainingMs / (TURN_SECONDS * 1000)) * 100}%`, ["--turn-color" as string]: currentPlayer?.color ?? "#8ef9ff" }} />
              </div>
              <p className="info-copy">{statusText}</p>
            </article>

            <article className="status-cluster">
              <div className="card-title-row compact-title-row">
                <h2>Lineup</h2>
                <span className="mode-badge">{activePlayers.length} Active</span>
              </div>
              <div className="player-list">
                {players.map((player) => (
                  <article key={player.id} className={`player-line ${currentPlayer?.id === player.id && phase === "playing" ? "current" : ""}`} style={{ ["--player-color" as string]: player.color }}>
                    <div className="player-line-main">
                      <span className="player-dot" />
                      <div>
                        <strong>{player.name}</strong>
                        <p>{countPlayerOrbs(board, player.id)} orbs on board</p>
                      </div>
                    </div>
                    <span className={`player-tag ${player.isEliminated ? "eliminated" : ""}`}>
                      {player.isEliminated ? "Spectating" : currentPlayer?.id === player.id && phase === "playing" ? "Turn" : "Live"}
                    </span>
                  </article>
                ))}
              </div>
            </article>
          </aside>
        </section>
      </section>

      {showWinnerModal && winner ? (
        <div className="modal-shell">
          <div className="modal-backdrop" onClick={() => setShowWinnerModal(false)} />
          <div className="modal-card victory-card">
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
              <button className="primary-link button-reset" type="button" onClick={startGame}>
                Rematch
              </button>
              <button className="ghost-link button-reset" type="button" onClick={() => setShowWinnerModal(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
