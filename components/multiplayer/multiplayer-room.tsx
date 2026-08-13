"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { BOARD_PRESETS, PLAYER_COLORS, type PresetId } from "@/lib/engine";
import { createRoomCode, isRoomCode, normalizeRoomCode, MAX_DISPLAY_NAME } from "@/lib/multiplayer/protocol";
import { isRoomServerMisconfigured, partyHost, useRoom } from "@/lib/multiplayer/use-room";
import { primeAudio } from "@/lib/sound";
import { MatchScreen } from "@/components/local/match-screen";
import styles from "./multiplayer-room.module.css";

const NAME_KEY = "cr-gaym:display-name";

/**
 * Online play: join screen, lobby, then the match.
 *
 * The client is a view. Every rule — who may sit, who may start, whose turn it
 * is, whether a move is legal — is decided by the room server in `worker/room.ts`.
 * This file decides only what to draw.
 */
export function MultiplayerRoom() {
  const [roomCode, setRoomCode] = useState<string | null>(null);
  const [displayName, setDisplayName] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const [preset, setPreset] = useState<PresetId>("classic");
  const [capacity, setCapacity] = useState(2);
  const [intent, setIntent] = useState<"create" | "join" | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);

  const {
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
    error,
    clearError,
    send
  } = useRoom(roomCode);

  // Names persist so a returning player is not retyping theirs every match.
  // Read after mount: reading storage during render is a hydration mismatch.
  useEffect(() => {
    try {
      setDisplayName(window.localStorage.getItem(NAME_KEY) ?? "");
    } catch {
      /* private browsing — the field just starts empty */
    }
  }, []);

  /**
   * The room code lives in the URL.
   *
   * That makes the room a link you can send someone, and it means a refresh
   * rejoins instead of dumping you back on the join screen — the server holds
   * the seat for a few seconds precisely so that round trip works.
   */
  useEffect(() => {
    const fromUrl = normalizeRoomCode(new URLSearchParams(window.location.search).get("room") ?? "");
    if (!isRoomCode(fromUrl)) return;
    setRoomCode(fromUrl);
    setIntent("join");
  }, []);

  const enterRoom = useCallback((code: string, mode: "create" | "join") => {
    window.history.replaceState({}, "", `/multiplayer?room=${code}`);
    setRoomCode(code);
    setIntent(mode);
  }, []);

  const rememberName = useCallback((name: string) => {
    setDisplayName(name);
    try {
      window.localStorage.setItem(NAME_KEY, name);
    } catch {
      /* not worth failing a keystroke over */
    }
  }, []);

  // Seat only once the socket is up, and again after a reconnect: the server
  // treats a repeat as a rename, so this is safe to fire more than once.
  useEffect(() => {
    if (connection !== "online" || !intent || !roomCode) return;
    if (intent === "create") {
      send({
        type: "room.create",
        payload: { displayName, settings: { boardPreset: preset, maxPlayers: capacity } }
      });
    } else {
      send({ type: "room.join", payload: { displayName } });
    }
  }, [connection, intent, roomCode, send, displayName, preset, capacity]);

  const me = useMemo(
    () => room?.players.find((player) => player.playerId === playerId) ?? null,
    [room, playerId]
  );
  const isHost = me?.isHost ?? false;

  /**
   * A local clock for the turn countdown.
   *
   * The deadline is translated into this device's clock once per snapshot, using
   * the `serverNow` the server sends alongside it, so a phone whose clock is
   * minutes out still counts down the right number of seconds. Rendering
   * `turnDeadline - serverNow` directly was a frozen number: both come from the
   * same message and never change until the next one arrives.
   */
  const [nowMs, setNowMs] = useState(() => Date.now());
  const deadlineAt = useMemo(
    () => (match ? Date.now() + (match.turnDeadline - match.serverNow) : 0),
    // Recomputed per snapshot: `match` is a new object each broadcast.
    [match]
  );

  useEffect(() => {
    if (!match) return;
    const id = window.setInterval(() => setNowMs(Date.now()), 250);
    return () => window.clearInterval(id);
  }, [match]);

  const leave = useCallback(() => {
    send({ type: "room.leave", payload: {} });
    window.history.replaceState({}, "", "/multiplayer");
    setRoomCode(null);
    setIntent(null);
    clearError();
  }, [send, clearError]);

  /* ---------------- join screen ---------------- */

  if (!roomCode) {
    const startRoom = (mode: "create" | "join") => {
      setJoinError(null);
      const code = mode === "join" ? normalizeRoomCode(codeInput) : createRoomCode();
      if (mode === "join" && !isRoomCode(code)) {
        setJoinError("Room codes are 6 letters and numbers.");
        return;
      }
      // An AudioContext is only allowed to start inside a user gesture, and this
      // click is the last one guaranteed before the first explosion.
      primeAudio();
      enterRoom(code, mode);
    };

    return (
      <main className={styles.screen}>
        <section className={styles.card}>
          <div>
            <h1 className={styles.title}>Play Online</h1>
            <p className={styles.subtitle}>
              Create a room and share the code, or enter a friend&apos;s code to join theirs.
            </p>
          </div>

          <label className={styles.field}>
            <span className={styles.fieldLabel}>Your name</span>
            <input
              className={styles.control}
              value={displayName}
              maxLength={MAX_DISPLAY_NAME}
              placeholder="Player"
              onChange={(event) => rememberName(event.target.value)}
            />
          </label>

          <div className={styles.grid}>
            <label className={styles.field}>
              <span className={styles.fieldLabel}>Board Preset</span>
              <select
                className={styles.control}
                value={preset}
                onChange={(event) => setPreset(event.target.value as PresetId)}
              >
                {Object.values(BOARD_PRESETS).map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label} ({option.size})
                  </option>
                ))}
              </select>
            </label>

            <label className={styles.field}>
              <span className={styles.fieldLabel}>Players</span>
              <select
                className={styles.control}
                value={capacity}
                onChange={(event) => setCapacity(Number(event.target.value))}
              >
                {[2, 3, 4, 5, 6, 7, 8].map((count) => (
                  <option key={count} value={count}>
                    {count}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className={styles.row}>
            <button className="primary-link button-reset" type="button" onClick={() => startRoom("create")}>
              Create Room
            </button>
            <Link className="ghost-link" href="/">
              Back Home
            </Link>
          </div>

          <hr style={{ border: 0, borderTop: "1px solid rgba(255,255,255,0.08)" }} />

          <label className={styles.field}>
            <span className={styles.fieldLabel}>Join with a code</span>
            <input
              className={`${styles.control} ${styles.codeInput}`}
              value={codeInput}
              maxLength={7}
              placeholder="ABC123"
              aria-label="Room code"
              onChange={(event) => setCodeInput(normalizeRoomCode(event.target.value))}
              onKeyDown={(event) => {
                if (event.key === "Enter") startRoom("join");
              }}
            />
          </label>

          {joinError ? <p className={styles.error}>{joinError}</p> : null}

          <div className={styles.row}>
            <button className="ghost-link button-reset" type="button" onClick={() => startRoom("join")}>
              Join Room
            </button>
          </div>
        </section>
      </main>
    );
  }

  /* ---------------- match ---------------- */

  const inMatch = room?.status !== "lobby" && displayGame !== null;

  if (inMatch && displayGame) {
    const current = displayGame.players[displayGame.currentPlayerIndex] ?? null;
    const isMyTurn = current?.id === playerId && displayGame.status === "playing";
    const remainingMs = Math.max(0, deadlineAt - nowMs);

    return (
      <MatchScreen
        game={displayGame}
        displayBoard={displayBoard}
        flashCells={flashCells}
        burstCells={burstCells}
        frameTick={frameTick}
        currentPlayer={current}
        turnLabel={
          displayGame.status === "finished"
            ? "Match over"
            : isMyTurn
              ? "Your turn"
              : `${current?.name ?? "Player"} to move`
        }
        statusText={
          connection === "offline"
            ? "Reconnecting…"
            : isMyTurn
              ? "Your move."
              : `Waiting for ${current?.name ?? "the next player"}.`
        }
        timerRemainingMs={remainingMs}
        isResolving={isResolving}
        canAct={isMyTurn && !isResolving}
        seatBadge={(id) => {
          const seat = room?.players.find((player) => player.playerId === id);
          if (!seat) return null;
          if (seat.connectionStatus === "offline") return "OFF";
          return seat.isHost ? "HOST" : null;
        }}
        onCellClick={(row, col) =>
          send({ type: "match.move", payload: { row, col, moveCount: displayGame.moveCount } })
        }
        onLeave={leave}
        leaveLabel="Leave room"
        showWinnerModal={displayGame.status === "finished"}
        onDismissWinner={() => undefined}
        onRematch={() => send({ type: "room.rematch", payload: {} })}
        rematchLabel="Back to lobby"
        canRematch={isHost}
      />
    );
  }

  /* ---------------- lobby ---------------- */

  const seats = Array.from({ length: room?.settings.maxPlayers ?? capacity }, (_, index) => {
    return room?.players[index] ?? null;
  });
  const seated = room?.players.length ?? 0;
  const target = room?.settings.maxPlayers ?? capacity;
  const everyoneReady = (room?.players ?? []).every((player) => player.isHost || player.isReady);
  const canStart = isHost && seated === target && seated >= 2 && everyoneReady;

  return (
    <main className={styles.screen}>
      <section className={styles.card}>
        <div className={styles.codeBanner}>
          <div>
            <div className={styles.fieldLabel}>Room code</div>
            <div className={styles.codeValue} data-testid="room-code">
              {roomCode}
            </div>
          </div>
          <button
            className="ghost-link button-reset"
            type="button"
            onClick={() => void navigator.clipboard?.writeText(roomCode)}
          >
            Copy code
          </button>
        </div>

        {unreachable ? (
          <p className={styles.error} role="alert" data-testid="room-unreachable">
            {isRoomServerMisconfigured()
              ? "Online play is not configured for this deployment — the room server address is missing, so this page is trying to reach one on your own device."
              : `Cannot reach the room server at ${partyHost()}. It may be down, or blocked by your network.`}
          </p>
        ) : null}

        <p className={styles.status} data-testid="lobby-status">
          {connection !== "online"
            ? "Connecting to the room…"
            : seated < target
              ? `Waiting for players — ${seated} of ${target} seated.`
              : everyoneReady
                ? isHost
                  ? "Everyone is ready. Start when you like."
                  : "Everyone is ready. Waiting for the host to start."
                : "Waiting for everyone to ready up."}
        </p>

        {error ? (
          <p className={styles.error} role="alert" data-testid="room-error">
            {error.message}
          </p>
        ) : null}

        <div className={styles.seats}>
          {seats.map((seat, index) => (
            <div
              key={seat?.playerId ?? `empty-${index}`}
              className={`${styles.seat} ${seat ? "" : styles.seatEmpty}`}
              style={{ ["--player-color" as string]: seat?.color ?? PLAYER_COLORS[index] }}
              data-testid="lobby-seat"
            >
              <span className={styles.seatDot} />
              <span className={styles.seatName}>{seat ? seat.displayName : "Empty seat"}</span>
              {seat?.isHost ? <span className={styles.tag}>Host</span> : null}
              {seat && !seat.isHost ? (
                <span className={`${styles.tag} ${seat.isReady ? styles.tagReady : ""}`}>
                  {seat.isReady ? "Ready" : "Not ready"}
                </span>
              ) : null}
              {seat?.connectionStatus === "offline" ? (
                <span className={`${styles.tag} ${styles.tagOffline}`}>Offline</span>
              ) : null}
            </div>
          ))}
        </div>

        <div className={styles.row}>
          {isHost ? (
            <button
              className="primary-link button-reset"
              type="button"
              disabled={!canStart}
              style={canStart ? undefined : { opacity: 0.5, cursor: "not-allowed" }}
              onClick={() => send({ type: "room.start", payload: {} })}
            >
              Start Match
            </button>
          ) : (
            <button
              className="primary-link button-reset"
              type="button"
              onClick={() => send({ type: "room.ready", payload: { isReady: !me?.isReady } })}
            >
              {me?.isReady ? "Not ready" : "I'm ready"}
            </button>
          )}
          <button className="ghost-link button-reset" type="button" onClick={leave}>
            Leave room
          </button>
        </div>

        <p className={styles.hint}>
          {room?.settings
            ? `${BOARD_PRESETS[room.settings.boardPreset].label} board, ${target} players, ${room.settings.turnTimeSeconds}s per turn.`
            : ""}
        </p>
      </section>
    </main>
  );
}
