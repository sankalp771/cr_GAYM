"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import PartySocket from "partysocket";
import { applyMove, type Board, type GameState } from "@/lib/engine";
import {
  EMPTY_FLASH,
  framesToSteps,
  stepDurations,
  type AnimationStep,
  type FlashSet
} from "@/lib/cascade-animation";
import { playSound, vibrate } from "@/lib/sound";
import { partyHost } from "./host";
import {
  decode,
  encode,
  type ClientMessage,
  type MatchSnapshot,
  type PlayedMove,
  type RoomSnapshot,
  type ServerMessage
} from "./protocol";

const SESSION_KEY = "cr-gaym:session";

/**
 * Identity that survives a refresh.
 *
 * The server keys seats on this, never on the socket, so reloading the page or
 * losing wifi puts you back in the same seat with the same orbs. It is generated
 * once in the browser and never leaves it except as a connection parameter.
 */
function sessionToken(): string {
  try {
    const existing = window.localStorage.getItem(SESSION_KEY);
    if (existing) return existing;
    const created = crypto.randomUUID();
    window.localStorage.setItem(SESSION_KEY, created);
    return created;
  } catch {
    // Private browsing: a per-tab identity still plays, it just cannot survive a reload.
    return crypto.randomUUID();
  }
}

// Re-exported so the page that already imports them from here does not have to
// learn a new module for a hostname.
export { isRoomServerMisconfigured, partyHost } from "./host";

/** How long to dial before telling the player it is not working. */
const CONNECT_TIMEOUT_MS = 8_000;

export type ConnectionState = "connecting" | "online" | "offline";

export type RoomError = { code: string; message: string } | null;

export type UseRoom = {
  connection: ConnectionState;
  /** The room server did not answer in time — almost always configuration, not network. */
  unreachable: boolean;
  playerId: string | null;
  room: RoomSnapshot | null;
  /** Authoritative match state. Null in the lobby. */
  match: MatchSnapshot | null;
  /** What to draw — mid-cascade this lags `match.state` on purpose. */
  displayBoard: Board;
  displayGame: GameState | null;
  flashCells: FlashSet;
  burstCells: FlashSet;
  frameTick: number;
  isResolving: boolean;
  lastMove: PlayedMove | null;
  /**
   * Every move of the current match, in order — the record a replay is built
   * from. Null once it cannot be trusted: joining mid-match, or a broadcast that
   * did not follow the one before it. A partial log would replay a game that
   * never happened, so it is thrown away rather than patched up.
   */
  moveLog: PlayedMove[] | null;
  error: RoomError;
  clearError: () => void;
  send: (message: ClientMessage) => void;
};

/**
 * Connect to a room and keep a renderable view of it.
 *
 * The client holds no authority. It sends intents, and everything it draws comes
 * from the server — with one deliberate exception: the cascade animation is
 * generated locally by replaying the broadcast move through the engine, because
 * shipping frames over the wire would cost megabytes per move. If the replay does
 * not line up with the authoritative state, the board simply snaps to the truth.
 */
/**
 * Who this browser claims to be when it dials.
 *
 * Both travel as connect parameters rather than as a message, because the room
 * server resolves them against the account server *before* it accepts the
 * socket — by the time the first `room.join` lands it already knows whether the
 * name is yours. Read through a ref inside the connect effect, so typing in the
 * name field cannot drop and redial the socket.
 */
export type RoomIdentity = {
  /** Session token from `useAccount`, or null to play as a guest. */
  authToken?: string | null;
  displayName?: string;
};

export function useRoom(roomCode: string | null, identity: RoomIdentity = {}): UseRoom {
  const [connection, setConnection] = useState<ConnectionState>("connecting");
  const [unreachable, setUnreachable] = useState(false);
  const [playerId, setPlayerId] = useState<string | null>(null);
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [match, setMatch] = useState<MatchSnapshot | null>(null);
  const [error, setError] = useState<RoomError>(null);
  const [lastMove, setLastMove] = useState<PlayedMove | null>(null);
  const [moveLog, setMoveLog] = useState<PlayedMove[] | null>([]);

  const [displayGame, setDisplayGame] = useState<GameState | null>(null);
  const [displayBoard, setDisplayBoard] = useState<Board>([]);
  const [flashCells, setFlashCells] = useState<FlashSet>(EMPTY_FLASH);
  const [burstCells, setBurstCells] = useState<FlashSet>(EMPTY_FLASH);
  const [frameTick, setFrameTick] = useState(0);
  const [isResolving, setIsResolving] = useState(false);

  const identityRef = useRef<RoomIdentity>(identity);
  identityRef.current = identity;

  const socketRef = useRef<PartySocket | null>(null);
  const timeoutsRef = useRef<number[]>([]);
  /** The state the animation is currently showing, read by the async player. */
  const shownRef = useRef<GameState | null>(null);
  /**
   * The newest authoritative state waiting to be drawn, and whether the drawer is
   * already running. Applying a snapshot takes as long as its cascade animation,
   * so two snapshots arriving close together used to overlap — and the slower one
   * finished last and wrote its now-stale board over the newer one. That is the
   * desync where both players see the *other* as the one to move and neither can
   * play, until the server's auto-play timer forces another broadcast and
   * accidentally repairs it.
   */
  const pendingRef = useRef<{ state: GameState; move: PlayedMove | null } | null>(null);
  const drawingRef = useRef(false);

  useEffect(() => {
    return () => {
      timeoutsRef.current.forEach((id) => window.clearTimeout(id));
      timeoutsRef.current = [];
    };
  }, []);

  const wait = useCallback((delayMs: number) => {
    return new Promise<void>((resolve) => {
      const id = window.setTimeout(() => {
        timeoutsRef.current = timeoutsRef.current.filter((entry) => entry !== id);
        resolve();
      }, delayMs);
      timeoutsRef.current.push(id);
    });
  }, []);

  const playSteps = useCallback(
    async (steps: AnimationStep[]) => {
      const durations = stepDurations(steps.length);
      for (const [index, step] of steps.entries()) {
        setDisplayBoard(step.board);
        setFlashCells(step.flash);
        setBurstCells(step.burst);
        setFrameTick((tick) => tick + 1);

        if (step.exploded) {
          const depth = steps.length <= 1 ? 0 : index / (steps.length - 1);
          playSound("explode", depth);
          if (index === 0 || (index === 1 && !steps[0].exploded)) vibrate(18);
        }

        await wait(durations[index] ?? 45);
      }
    },
    [wait]
  );

  /**
   * Bring the board up to `next`, animating if we can and snapping if we cannot.
   *
   * The replay is only valid when the state we are showing is exactly one move
   * behind — otherwise we missed a broadcast, and inventing frames from a stale
   * board would show a cascade that never happened.
   */
  const advanceTo = useCallback(
    async (next: GameState, move: PlayedMove | null): Promise<void> => {
      const shown = shownRef.current;
      const canReplay =
        move !== null && shown !== null && shown.status === "playing" && shown.moveCount === next.moveCount - 1;

      if (!canReplay) {
        shownRef.current = next;
        setDisplayGame(next);
        setDisplayBoard(next.board);
        setFlashCells(EMPTY_FLASH);
        setBurstCells(EMPTY_FLASH);
        setIsResolving(false);
        return;
      }

      setIsResolving(true);
      playSound("place");
      try {
        const result = applyMove(shown, { playerId: move.playerId, row: move.row, col: move.col }, {
          recordFrames: true
        });
        await playSteps(framesToSteps(result.frames));
      } catch {
        // A rules disagreement should never happen — same engine, same state —
        // but if it does, the authoritative board still wins.
      }

      shownRef.current = next;
      setDisplayGame(next);
      setDisplayBoard(next.board);
      setFlashCells(EMPTY_FLASH);
      setBurstCells(EMPTY_FLASH);
      setIsResolving(false);
    },
    [playSteps]
  );

  /**
   * Accept an authoritative snapshot and draw it, one at a time.
   *
   * Two rules keep the client honest:
   *
   * - **Never go backwards.** A snapshot no newer than what is already on screen
   *   is dropped. Reconnecting replays `match.started`, and out-of-order or
   *   duplicate frames are ordinary on a flaky phone connection.
   * - **Only the newest pending snapshot is drawn.** If three arrive while a
   *   cascade is playing, the intermediate ones are skipped rather than queued:
   *   the goal is to end up showing the truth, not to replay history.
   */
  const applySnapshot = useCallback(
    (next: GameState, move: PlayedMove | null) => {
      const shown = shownRef.current;
      const pending = pendingRef.current;
      if (shown && next.moveCount < shown.moveCount) return;
      if (pending && next.moveCount < pending.state.moveCount) return;

      pendingRef.current = { state: next, move };
      if (drawingRef.current) return;

      drawingRef.current = true;
      void (async () => {
        try {
          while (pendingRef.current) {
            const job = pendingRef.current;
            pendingRef.current = null;
            await advanceTo(job.state, job.move);
          }
        } finally {
          drawingRef.current = false;
        }
      })();
    },
    [advanceTo]
  );

  useEffect(() => {
    if (!roomCode) return;

    const socket = new PartySocket({
      host: partyHost(),
      room: roomCode,
      // A function, so a reconnect re-reads these rather than replaying whatever
      // they were when the room was first entered.
      query: () => ({
        token: sessionToken(),
        auth: identityRef.current.authToken ?? "",
        name: identityRef.current.displayName ?? ""
      })
    });
    socketRef.current = socket;
    setConnection("connecting");
    setUnreachable(false);

    // partysocket retries quietly forever, which is the right behaviour for a
    // blip and the wrong one for a server that is not there at all. Without this
    // the lobby says "Connecting…" indefinitely and never admits defeat.
    const giveUp = window.setTimeout(() => setUnreachable(true), CONNECT_TIMEOUT_MS);

    const onOpen = () => {
      window.clearTimeout(giveUp);
      setUnreachable(false);
      setConnection("online");
    };
    const onClose = () => setConnection("offline");

    const onMessage = (event: MessageEvent<string>) => {
      const message = decode<ServerMessage>(event.data);
      if (!message) return;

      switch (message.type) {
        case "session.ready":
          setPlayerId(message.payload.playerId);
          break;
        case "room.snapshot":
          setRoom(message.payload.room);
          // Leaving a match resets the room; drop the stale board with it.
          if (message.payload.room.status === "lobby") {
            setMatch(null);
            setDisplayGame(null);
            setMoveLog([]);
            shownRef.current = null;
            pendingRef.current = null;
          }
          break;
        case "room.error":
          setError(message.payload);
          break;
        case "match.started":
          setRoom(message.payload.room);
          setMatch(message.payload.match);
          setLastMove(null);
          // A reconnect replays this message with the match already under way.
          // There is no way to recover the moves already played, so the log
          // gives up rather than pretending the match began here.
          setMoveLog(message.payload.match.state.moveCount === 0 ? [] : null);
          applySnapshot(message.payload.match.state, null);
          break;
        case "match.updated":
        case "match.finished": {
          setRoom(message.payload.room);
          setMatch(message.payload.match);
          setLastMove(message.payload.move);
          setMoveLog((current) => {
            if (current === null) return null;
            // Duplicates and gaps are ordinary on a flaky connection, and either
            // one makes the record wrong rather than merely short.
            if (message.payload.match.state.moveCount !== current.length + 1) return null;
            return [...current, message.payload.move];
          });
          applySnapshot(message.payload.match.state, message.payload.move);
          break;
        }
      }
    };

    socket.addEventListener("open", onOpen);
    socket.addEventListener("close", onClose);
    socket.addEventListener("message", onMessage);

    return () => {
      socket.removeEventListener("open", onOpen);
      socket.removeEventListener("close", onClose);
      socket.removeEventListener("message", onMessage);
      window.clearTimeout(giveUp);
      socket.close();
      socketRef.current = null;
    };
    // `applySnapshot` is stable; re-running this effect would drop the socket.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomCode]);

  const send = useCallback((message: ClientMessage) => {
    socketRef.current?.send(encode(message));
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return {
    connection,
    unreachable,
    playerId,
    room,
    match,
    displayBoard,
    displayGame,
    flashCells,
    burstCells,
    frameTick,
    isResolving,
    lastMove,
    moveLog,
    error,
    clearError,
    send
  };
}
