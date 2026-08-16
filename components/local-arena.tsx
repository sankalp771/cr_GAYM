"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  applyMove,
  BOARD_PRESETS,
  chooseAiMove,
  createEmptyBoard,
  createInitialState,
  isLegalMove,
  PLAYER_COLORS,
  pickAutoMove,
  TURN_SECONDS,
  type AiDifficulty,
  type Board,
  type GameState,
  type GridConfig,
  type Player,
  type PresetId
} from "@/lib/engine";
import {
  EMPTY_FLASH,
  framesToSteps,
  MIN_STEP_MS,
  stepDurations,
  type AnimationStep,
  type FlashSet
} from "@/lib/cascade-animation";
import { buildVictoryFinale } from "@/lib/victory-finale";
import { buildRecord, type MatchRecord, type RecordedMove } from "@/lib/replay";
import { loadMutePreference, playSound, primeAudio, setMuted, vibrate } from "@/lib/sound";
import { DEFAULT_DIFFICULTY, loadDifficulty, saveDifficulty } from "@/lib/preferences";
import { SetupScreen, type SeatKind } from "@/components/local/setup-screen";
import { MatchScreen } from "@/components/local/match-screen";
import { ReplayActions, ReplayActionsCard } from "@/components/replay/replay-actions";
import { ReplayScreen } from "@/components/replay/replay-screen";

type GamePhase = "setup" | "playing" | "finished";

/** Where a move came from. Only the status line cares — all three take the same path. */
type MoveSource = "human" | "timeout" | "computer";

/**
 * Beat between a computer seat's turn starting and its move landing. Without it
 * the bot's move arrives in the same frame as the human's and the board reads as
 * if it glitched rather than as if somebody replied.
 */
const AI_MOVE_DELAY_MS = 600;

/** Seat 1 is the human; every other seat defaults to a computer opponent. */
function defaultSeatKinds(count: number, previous: SeatKind[] = []): SeatKind[] {
  return Array.from({ length: count }, (_, index) => previous[index] ?? (index === 0 ? "human" : "computer"));
}

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

/**
 * Holds the match state and drives the engine; renders one of two screens.
 *
 * Setup and the match are separate screens rather than columns of one layout.
 * Sharing a screen meant eight seats of name fields competed with the board for
 * height, and the board lost.
 */
export function LocalArena() {
  const [presetId, setPresetId] = useState<PresetId>("classic");
  const [playerCount, setPlayerCount] = useState(2);
  const [playerNames, setPlayerNames] = useState<string[]>(["Player 1", "Player 2"]);
  const [seatKinds, setSeatKinds] = useState<SeatKind[]>(() => defaultSeatKinds(2));

  // Snapshot of the seat choices taken when the match started, so editing setup
  // afterwards cannot change who is driving a seat mid-match.
  const [computerSeatIds, setComputerSeatIds] = useState<ReadonlySet<string>>(() => new Set<string>());

  const [game, setGame] = useState<GameState | null>(null);
  const [displayBoard, setDisplayBoard] = useState<Board>(() => createEmptyBoard(configForPreset("classic")));
  const [flashCells, setFlashCells] = useState<FlashSet>(EMPTY_FLASH);
  const [burstCells, setBurstCells] = useState<FlashSet>(EMPTY_FLASH);
  const [frameTick, setFrameTick] = useState(0);

  const [phase, setPhase] = useState<GamePhase>("setup");
  const [statusText, setStatusText] = useState("Waiting for the first move.");
  const [timerRemainingMs, setTimerRemainingMs] = useState(TURN_SECONDS * 1000);
  const [showWinnerModal, setShowWinnerModal] = useState(false);
  const [isResolving, setIsResolving] = useState(false);

  /**
   * The match as it is played, for the replay.
   *
   * Only the moves are kept — every board state a replay shows is re-derived by
   * running them back through the engine, which is the same thing online play
   * does to animate a broadcast move. A ref rather than state because nothing
   * renders from it until the match ends, and `runMove` is already async.
   */
  const recordedMovesRef = useRef<RecordedMove[]>([]);
  const [record, setRecord] = useState<MatchRecord | null>(null);
  const [isWatchingReplay, setIsWatchingReplay] = useState(false);

  // Preferences default identically on server and client, then sync from storage
  // after mount — reading localStorage during render is a hydration mismatch.
  const [isMuted, setIsMuted] = useState(false);
  const [difficulty, setDifficulty] = useState<AiDifficulty>(DEFAULT_DIFFICULTY);

  useEffect(() => {
    setIsMuted(loadMutePreference());
    setDifficulty(loadDifficulty());
  }, []);

  /**
   * The bot's move is dispatched from a timeout, so it reads difficulty through
   * a ref for the same reason it reads game state through one: a value closed
   * over when the turn started would be stale when the timeout fires.
   */
  const difficultyRef = useRef<AiDifficulty>(DEFAULT_DIFFICULTY);
  difficultyRef.current = difficulty;

  function changeDifficulty(next: AiDifficulty) {
    setDifficulty(next);
    saveDifficulty(next);
  }

  function toggleMute() {
    const next = !isMuted;
    setIsMuted(next);
    setMuted(next);
    // Unmuting is a user gesture, the only moment a browser will start an
    // AudioContext.
    if (!next) {
      primeAudio();
      playSound("place");
    }
  }

  const turnStartedAtRef = useRef<number>(0);
  const intervalRef = useRef<number | null>(null);
  const timeoutRef = useRef<number[]>([]);
  const autoMoveFiredRef = useRef(false);

  const players = game?.players ?? [];
  const currentPlayer =
    game && game.status === "playing" ? players[game.currentPlayerIndex] ?? null : null;

  useEffect(() => {
    setPlayerNames((previous) =>
      Array.from({ length: playerCount }, (_, index) => previous[index] ?? `Player ${index + 1}`)
    );
    setSeatKinds((previous) => defaultSeatKinds(playerCount, previous));
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
    async (steps: AnimationStep[], durations: number[]) => {
      for (const [index, step] of steps.entries()) {
        setDisplayBoard(step.board);
        setFlashCells(step.flash);
        setBurstCells(step.burst);
        setFrameTick((tick) => tick + 1);

        if (step.exploded) {
          const depth = steps.length <= 1 ? 0 : index / (steps.length - 1);
          playSound("explode", depth);
          // One pulse at the head of the chain — a long cascade would otherwise
          // buzz continuously.
          if (index === 0 || (index === 1 && !steps[0].exploded)) vibrate(18);
        }

        await waitForFrame(durations[index] ?? MIN_STEP_MS);
      }
    },
    [waitForFrame]
  );

  const runMove = useCallback(
    async (row: number, col: number, source: MoveSource) => {
      if (!game || game.status !== "playing" || isResolving) return;

      const actingPlayer = game.players[game.currentPlayerIndex];
      const move = { playerId: actingPlayer.id, row, col };
      if (!isLegalMove(game, move)) return;

      const result = applyMove(game, move, { recordFrames: true });
      recordedMovesRef.current.push({ playerId: actingPlayer.id, row, col, auto: source === "timeout" });

      setIsResolving(true);
      setStatusText(
        source === "timeout"
          ? `${actingPlayer.name} ran out of time and the arena auto-played.`
          : source === "computer"
            ? `${actingPlayer.name} calculated a strike.`
            : `${actingPlayer.name} triggered a chain reaction.`
      );

      playSound("place");
      vibrate(8);

      const steps = framesToSteps(result.frames);
      await playFrames(steps, stepDurations(steps.length));

      setGame(result.state);
      setDisplayBoard(result.state.board);
      setFlashCells(EMPTY_FLASH);
      setBurstCells(EMPTY_FLASH);

      if (result.state.status === "finished" && result.state.winnerId) {
        const championName =
          result.state.players.find((player) => player.id === result.state.winnerId)?.name ?? "Someone";
        setStatusText(`${championName} is consuming the board.`);

        const finale = buildVictoryFinale(result.state.board, result.state.winnerId, { row, col });
        if (finale.steps.length > 0) {
          await playFrames(finale.steps, finale.durations);
          setBurstCells(EMPTY_FLASH);
        }

        playSound("victory");
        vibrate([30, 60, 30]);

        setRecord(
          buildRecord({
            mode: "local",
            config: result.state.config,
            players: result.state.players.map((player) => ({
              id: player.id,
              name: player.name,
              color: player.color,
              ...(computerSeatIds.has(player.id) ? { badge: "CPU" } : {})
            })),
            moves: recordedMovesRef.current,
            winnerId: result.state.winnerId,
            recordedAt: Date.now()
          })
        );

        setPhase("finished");
        setShowWinnerModal(true);
        setIsResolving(false);
        setTimerRemainingMs(0);
        setStatusText(`${championName} detonated the deciding chain reaction.`);
        return;
      }

      setIsResolving(false);
      setStatusText(
        source === "timeout"
          ? `${actingPlayer.name} ran out of time and the arena auto-played.`
          : source === "computer"
            ? `${actingPlayer.name} answered and shifted the board pressure.`
            : `${actingPlayer.name} shifted the board pressure.`
      );
    },
    [computerSeatIds, game, isResolving, playFrames]
  );

  // The turn timer reads the handler through a ref: the interval is created once
  // per turn, so capturing the handler directly would pin it to that render's
  // board and current player.
  const autoMoveRef = useRef<() => void>(() => {});
  autoMoveRef.current = () => {
    if (!game || game.status !== "playing" || isResolving || autoMoveFiredRef.current) return;
    const move = pickAutoMove(game, Math.random);
    if (!move) return;
    autoMoveFiredRef.current = true;
    void runMove(move.row, move.col, "timeout");
  };

  const isComputerSeat = useCallback(
    (playerId: string) => computerSeatIds.has(playerId),
    [computerSeatIds]
  );

  /**
   * The turn a computer seat has already been dispatched for. `moveCount` is
   * monotonic within a match, so comparing against it is a fired-once latch —
   * the effect below re-runs on any state change and would otherwise hand a bot
   * a second turn.
   */
  const aiDispatchedForMoveRef = useRef(-1);

  const aiMoveRef = useRef<() => void>(() => {});
  aiMoveRef.current = () => {
    if (!game || game.status !== "playing" || isResolving) return;

    const actingPlayer = game.players[game.currentPlayerIndex];
    if (!actingPlayer || !isComputerSeat(actingPlayer.id)) return;
    if (aiDispatchedForMoveRef.current === game.moveCount) return;

    const move = chooseAiMove(game, difficultyRef.current, Math.random);
    if (!move) return;

    aiDispatchedForMoveRef.current = game.moveCount;
    // The same entry point a click uses — one move path, one animation path.
    void runMove(move.row, move.col, "computer");
  };

  useEffect(() => {
    if (phase !== "playing" || isResolving) return;
    if (!game || game.status !== "playing") return;

    const actingPlayer = game.players[game.currentPlayerIndex];
    if (!actingPlayer || !isComputerSeat(actingPlayer.id)) return;
    if (aiDispatchedForMoveRef.current === game.moveCount) return;

    const timeoutId = window.setTimeout(() => {
      timeoutRef.current = timeoutRef.current.filter((entry) => entry !== timeoutId);
      aiMoveRef.current();
    }, AI_MOVE_DELAY_MS);

    timeoutRef.current.push(timeoutId);

    return () => {
      window.clearTimeout(timeoutId);
      timeoutRef.current = timeoutRef.current.filter((entry) => entry !== timeoutId);
    };
  }, [phase, isResolving, game, isComputerSeat]);

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
    // Started from a click, the one reliable chance to open the AudioContext.
    primeAudio();
    const freshGame = createInitialState(
      configForPreset(presetId),
      buildPlayers(playerNames.slice(0, playerCount))
    );
    const kinds = defaultSeatKinds(playerCount, seatKinds);

    aiDispatchedForMoveRef.current = -1;
    recordedMovesRef.current = [];
    setRecord(null);
    setIsWatchingReplay(false);
    setComputerSeatIds(
      new Set(freshGame.players.filter((_, index) => kinds[index] === "computer").map((player) => player.id))
    );
    setGame(freshGame);
    setDisplayBoard(freshGame.board);
    setFlashCells(EMPTY_FLASH);
    setBurstCells(EMPTY_FLASH);
    setPhase("playing");
    setShowWinnerModal(false);
    setIsResolving(false);
    setTimerRemainingMs(TURN_SECONDS * 1000);
    setStatusText(`${freshGame.players[0].name} enters the arena first.`);
  }

  function backToSetup() {
    clearPendingTimeouts();
    aiDispatchedForMoveRef.current = -1;
    recordedMovesRef.current = [];
    setRecord(null);
    setIsWatchingReplay(false);
    setComputerSeatIds(new Set<string>());
    setGame(null);
    setDisplayBoard(createEmptyBoard(configForPreset(presetId)));
    setFlashCells(EMPTY_FLASH);
    setBurstCells(EMPTY_FLASH);
    setPhase("setup");
    setShowWinnerModal(false);
    setIsResolving(false);
    setStatusText("Waiting for the first move.");
    setTimerRemainingMs(TURN_SECONDS * 1000);
  }

  function watchReplay() {
    clearPendingTimeouts();
    setShowWinnerModal(false);
    setIsWatchingReplay(true);
  }

  function resetSetup() {
    setPresetId("classic");
    setPlayerCount(2);
    setPlayerNames(["Player 1", "Player 2"]);
    setSeatKinds(defaultSeatKinds(2));
  }

  const settings = {
    isMuted,
    onToggleMute: toggleMute,
    difficulty,
    onDifficultyChange: changeDifficulty
  };

  // Watching the match back takes over the screen, the way it does on Showdown.
  // Closing it drops back onto the finished board with the result still up.
  if (isWatchingReplay && record) {
    return (
      <ReplayScreen
        record={record}
        onExit={() => {
          setIsWatchingReplay(false);
          setShowWinnerModal(true);
        }}
      />
    );
  }

  if (phase === "setup" || !game) {
    return (
      <SetupScreen
        presetId={presetId}
        onPresetChange={setPresetId}
        playerCount={playerCount}
        onPlayerCountChange={setPlayerCount}
        playerNames={playerNames}
        onPlayerNameChange={(index, name) =>
          setPlayerNames((previous) =>
            previous.map((entry, entryIndex) => (entryIndex === index ? name : entry))
          )
        }
        seatKinds={seatKinds}
        onSeatKindChange={(index, kind) =>
          setSeatKinds((previous) =>
            previous.map((entry, entryIndex) => (entryIndex === index ? kind : entry))
          )
        }
        onStart={startGame}
        onReset={resetSetup}
        {...settings}
      />
    );
  }

  return (
    <MatchScreen
      game={game}
      displayBoard={displayBoard}
      flashCells={flashCells}
      burstCells={burstCells}
      frameTick={frameTick}
      currentPlayer={currentPlayer}
      statusText={statusText}
      timerRemainingMs={timerRemainingMs}
      isResolving={isResolving}
      seatBadge={(playerId) => (isComputerSeat(playerId) ? "CPU" : null)}
      onCellClick={(row, col) => void runMove(row, col, "human")}
      onLeave={backToSetup}
      showWinnerModal={showWinnerModal}
      onDismissWinner={() => setShowWinnerModal(false)}
      onRematch={startGame}
      sideExtra={<ReplayActionsCard record={record} onWatch={watchReplay} />}
      modalExtraActions={<ReplayActions record={record} onWatch={watchReplay} />}
      settings={settings}
    />
  );
}
