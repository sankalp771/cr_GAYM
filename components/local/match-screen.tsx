"use client";

import type { CSSProperties } from "react";
import { criticalMass, TURN_SECONDS, type Board, type GameState, type Player } from "@/lib/engine";
import { SettingsMenu, type SettingsMenuProps } from "@/components/local/settings-menu";
import styles from "./match-screen.module.css";

/** Particles per exploding cell — one per neighbour the orbs travel to. */
const BURST_DIRECTIONS = [0, 1, 2, 3];

type MatchScreenProps = SettingsMenuProps & {
  game: GameState;
  displayBoard: Board;
  flashCells: ReadonlySet<string>;
  burstCells: ReadonlySet<string>;
  frameTick: number;
  currentPlayer: Player | null;
  statusText: string;
  timerRemainingMs: number;
  isResolving: boolean;
  isComputerSeat: (playerId: string) => boolean;
  onCellClick: (row: number, col: number) => void;
  onLeave: () => void;
  showWinnerModal: boolean;
  onDismissWinner: () => void;
  onRematch: () => void;
};

const cellKey = (row: number, col: number) => `${row},${col}`;

function countOrbs(board: Board, playerId: string) {
  let total = 0;
  for (const row of board) {
    for (const cell of row) if (cell.ownerId === playerId) total += cell.count;
  }
  return total;
}

/**
 * The match itself, on a screen of its own.
 *
 * Nothing here competes with the board for height: a slim bar, the grid, and a
 * narrow panel. The background is pitch black so the orbs are the only light on
 * the page.
 */
export function MatchScreen({
  game,
  displayBoard,
  flashCells,
  burstCells,
  frameTick,
  currentPlayer,
  statusText,
  timerRemainingMs,
  isResolving,
  isComputerSeat,
  onCellClick,
  onLeave,
  showWinnerModal,
  onDismissWinner,
  onRematch,
  ...settings
}: MatchScreenProps) {
  const turnColor = currentPlayer?.color ?? "#8ef9ff";
  const isFinished = game.status === "finished";
  const secondsLeft = Math.ceil(timerRemainingMs / 1000);
  const winner = game.players.find((player) => player.id === game.winnerId) ?? null;

  return (
    <main className={styles.screen} style={{ ["--turn-color" as string]: turnColor }}>
      <div className={styles.topBar}>
        <div className={styles.turn}>
          <span className={styles.turnDot} />
          <span className={styles.turnName}>
            {isFinished ? "Match over" : `${currentPlayer?.name ?? "Player"} to move`}
          </span>
          {!isFinished ? <span className={styles.turnClock}>{secondsLeft}s</span> : null}
        </div>

        <div className={styles.topActions}>
          <button
            className={`ghost-link button-reset ${styles.compactButton}`}
            type="button"
            onClick={onLeave}
          >
            Leave match
          </button>
          <SettingsMenu {...settings} compact />
        </div>
      </div>

      <div className={styles.body}>
        <div className={styles.boardArea}>
          <div
            className={styles.board}
            data-testid="board"
            style={{ gridTemplateColumns: `repeat(${game.config.cols}, minmax(0, 1fr))` }}
          >
            {displayBoard.flat().map((cell) => {
              const owner = game.players.find((player) => player.id === cell.ownerId) ?? null;
              const playable =
                !isFinished && !isResolving && currentPlayer
                  ? cell.ownerId === null || cell.ownerId === currentPlayer.id
                  : false;
              const isCritical =
                cell.count > 0 && cell.count === criticalMass(cell.row, cell.col, game.config) - 1;
              const isFlashing = flashCells.has(cellKey(cell.row, cell.col));
              const isBursting = burstCells.has(cellKey(cell.row, cell.col));

              const className = [
                styles.cell,
                playable ? styles.cellPlayable : styles.cellBlocked,
                isCritical && owner ? styles.cellCritical : "",
                isBursting ? styles.cellBursting : ""
              ]
                .filter(Boolean)
                .join(" ");

              return (
                <button
                  // Only cells lit by the current step change key, remounting just
                  // those so their animations replay.
                  key={`${cell.row}-${cell.col}-${isFlashing ? frameTick : 0}`}
                  className={className}
                  type="button"
                  disabled={!playable}
                  onClick={() => onCellClick(cell.row, cell.col)}
                  style={owner ? ({ ["--player-color" as string]: owner.color } as CSSProperties) : undefined}
                  aria-label={
                    owner
                      ? `Row ${cell.row + 1}, column ${cell.col + 1}: ${cell.count} ${
                          cell.count === 1 ? "orb" : "orbs"
                        } owned by ${owner.name}`
                      : `Row ${cell.row + 1}, column ${cell.col + 1}: empty`
                  }
                >
                  {isBursting ? (
                    <span className={styles.burst} aria-hidden="true">
                      {BURST_DIRECTIONS.map((direction) => (
                        <span
                          key={direction}
                          className={styles.burstParticle}
                          data-direction={direction}
                        />
                      ))}
                    </span>
                  ) : null}

                  {cell.count > 0 && owner ? (
                    <span
                      className={`${styles.orbStack} ${styles[`count${Math.min(cell.count, 4)}`] ?? ""}`}
                    >
                      {Array.from({ length: Math.min(cell.count, 4) }, (_, index) => (
                        <span key={index} className={styles.orb} data-testid="orb" />
                      ))}
                    </span>
                  ) : null}
                </button>
              );
            })}
          </div>
        </div>

        <aside className={styles.side}>
          <section className={styles.sideCard}>
            <h2 className={styles.sideTitle}>Turn</h2>
            <div className={styles.timerTrack}>
              <div
                className={styles.timerFill}
                style={{ width: `${(timerRemainingMs / (TURN_SECONDS * 1000)) * 100}%` }}
              />
            </div>
            <p className={styles.statusLine}>{statusText}</p>
          </section>

          <section className={styles.sideCard}>
            <h2 className={styles.sideTitle}>Round Intel</h2>
            <div className={styles.lineup}>
              {game.players.map((player) => {
                const isCurrent = !isFinished && currentPlayer?.id === player.id;
                const className = [
                  styles.player,
                  isCurrent ? styles.playerCurrent : "",
                  player.isEliminated ? styles.playerOut : ""
                ]
                  .filter(Boolean)
                  .join(" ");

                return (
                  <div
                    key={player.id}
                    data-testid="player-row"
                    className={className}
                    style={{ ["--player-color" as string]: player.color }}
                  >
                    <span className={styles.playerDot} data-testid="player-dot" />
                    <span className={styles.playerName}>{player.name}</span>
                    {isComputerSeat(player.id) ? (
                      <span className={styles.cpuTag} data-testid="cpu-tag">
                        CPU
                      </span>
                    ) : null}
                    <span className={styles.playerOrbs}>{countOrbs(displayBoard, player.id)}</span>
                  </div>
                );
              })}
            </div>
          </section>
        </aside>
      </div>

      {showWinnerModal && winner ? (
        <div className={styles.modalShell} role="dialog" aria-modal="true" aria-label="Match result">
          <div className={styles.modalBackdrop} onClick={onDismissWinner} />
          <div className={styles.modalCard} style={{ ["--player-color" as string]: winner.color }}>
            <h2 className={styles.modalWinner}>
              <span className={styles.playerDot} />
              {winner.name} wins
            </h2>
            <p className={styles.modalCopy}>They controlled the final chain reaction.</p>
            <div className={styles.modalActions}>
              <button className="primary-link button-reset" type="button" onClick={onRematch}>
                Rematch
              </button>
              <button className="ghost-link button-reset" type="button" onClick={onLeave}>
                Change setup
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </main>
  );
}
