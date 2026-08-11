/**
 * Authoritative Chain Reaction room.
 *
 * One instance per room code, running on PartyKit. The client never owns game
 * state: it sends move *intents* and renders what comes back. `docs/ARCHITECTURE.md`
 * calls for a server-authoritative design and this is it.
 *
 * ## Why this can import the game engine directly
 *
 * `lib/engine/` is pure — no React, no DOM, no `Date.now()`, no `Math.random()`,
 * enforced in `eslint.config.mjs`. That rule exists precisely so this file can
 * exist: the rules run here and in the browser from one copy, so a server and a
 * client cannot disagree about what a move does. The architecture doc's
 * suggested `packages/game-engine` split was aiming at the same thing; a pure
 * module inside the app achieves it without a monorepo.
 *
 * Both sources of non-determinism the engine refuses to touch are injected right
 * here, on the server, which is where the doc says they belong: `Math.random`
 * for auto-play selection, and the wall clock for turn deadlines.
 *
 * ## Why the client is not sent cascade frames
 *
 * A resolved move can produce hundreds of animation frames, each a full board
 * clone — megabytes on a 14x14 board. It is never sent. The client is sent the
 * move and the resulting state, replays the move through its own copy of the
 * engine to generate identical frames, and reconciles against the authoritative
 * state afterwards. Determinism is what makes that safe.
 */

import type * as Party from "partykit/server";
import {
  applyMove,
  BOARD_PRESETS,
  createInitialState,
  isLegalMove,
  PLAYER_COLORS,
  pickAutoMove,
  TURN_SECONDS,
  type GameState,
  type Move,
  type Player,
  type PresetId
} from "../lib/engine";
import {
  decode,
  encode,
  normalizeDisplayName,
  PROTOCOL_VERSION,
  type ClientMessage,
  type MatchSnapshot,
  type PlayedMove,
  type RoomErrorCode,
  type RoomPlayer,
  type RoomSettings,
  type RoomSnapshot,
  type RoomStatus,
  type ServerMessage
} from "../lib/multiplayer/protocol";

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 8;

/**
 * Grace period before a disconnected player loses their lobby seat.
 *
 * A page refresh drops the socket and opens a new one, and taking the seat away
 * in between would make refreshing feel like being kicked. In a running match
 * the seat is never freed at all — the match keeps going and auto-plays for them
 * until they return.
 */
const LOBBY_DISCONNECT_GRACE_MS = 10_000;

type SeatedPlayer = {
  playerId: string;
  displayName: string;
  seatIndex: number;
  isReady: boolean;
  /** A player may briefly hold two sockets while a refresh hands over. */
  connections: Set<string>;
  dropTimer: ReturnType<typeof setTimeout> | null;
};

function defaultSettings(): RoomSettings {
  const preset = BOARD_PRESETS.classic;
  return {
    boardPreset: "classic",
    rows: preset.size,
    cols: preset.size,
    maxPlayers: 2,
    turnTimeSeconds: TURN_SECONDS
  };
}

function clampCapacity(value: number, floor: number): number {
  if (!Number.isFinite(value)) return floor;
  return Math.min(MAX_PLAYERS, Math.max(Math.max(MIN_PLAYERS, floor), Math.round(value)));
}

export default class ChainReactionRoom implements Party.Server {
  /** Hibernate between turns: a lobby waiting for a fourth player should cost nothing. */
  static options = { hibernate: true };

  private players = new Map<string, SeatedPlayer>();
  /** Session token -> playerId. The token is never broadcast; the id is. */
  private tokens = new Map<string, string>();
  private connections = new Map<string, string>();

  private hostPlayerId: string | null = null;
  private status: RoomStatus = "lobby";
  private settings: RoomSettings = defaultSettings();

  private game: GameState | null = null;
  private matchId: string | null = null;
  private turnDeadline = 0;
  private turnTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly room: Party.Room) {}

  /**
   * Plain HTTP view of a room.
   *
   * Enough for a load balancer or an uptime check to see the server is alive,
   * and it is what the Playwright suite polls before it starts driving browsers.
   * Deliberately says nothing about the board — it is unauthenticated.
   */
  onRequest() {
    return new Response(
      JSON.stringify({
        ok: true,
        protocolVersion: PROTOCOL_VERSION,
        room: this.room.id,
        status: this.status,
        players: this.players.size,
        capacity: this.settings.maxPlayers
      }),
      { headers: { "content-type": "application/json" } }
    );
  }

  /* ---------------- connection lifecycle ---------------- */

  onConnect(connection: Party.Connection, context: Party.ConnectionContext) {
    const token = new URL(context.request.url).searchParams.get("token");
    if (!token) {
      this.sendError(connection, "bad_request", "Missing session token.");
      connection.close();
      return;
    }

    const existingId = this.tokens.get(token);
    const playerId = existingId ?? crypto.randomUUID();
    if (!existingId) this.tokens.set(token, playerId);
    this.connections.set(connection.id, playerId);

    // A returning player keeps their seat, their colour and their orbs.
    const seated = this.players.get(playerId);
    if (seated) {
      seated.connections.add(connection.id);
      if (seated.dropTimer) {
        clearTimeout(seated.dropTimer);
        seated.dropTimer = null;
      }
    }

    this.send(connection, {
      type: "session.ready",
      payload: { playerId, protocolVersion: PROTOCOL_VERSION }
    });

    // An unseated connection still gets the snapshot, so the join screen can show
    // who is already waiting before committing to a seat.
    this.send(connection, { type: "room.snapshot", payload: { room: this.roomSnapshot() } });
    if (seated && this.game) this.send(connection, this.matchMessage("match.started"));
    if (seated) this.broadcastRoom();
  }

  onClose(connection: Party.Connection) {
    this.dropConnection(connection.id);
  }

  onError(connection: Party.Connection) {
    this.dropConnection(connection.id);
  }

  private dropConnection(connectionId: string) {
    const playerId = this.connections.get(connectionId);
    this.connections.delete(connectionId);
    if (!playerId) return;

    const seated = this.players.get(playerId);
    if (!seated) return;

    seated.connections.delete(connectionId);
    if (seated.connections.size > 0) return;

    // In a match the seat is held indefinitely — the turn timer auto-plays for
    // them, so the match never stalls on somebody's flaky wifi.
    if (this.status === "in_match") {
      this.broadcastRoom();
      return;
    }

    seated.dropTimer = setTimeout(() => {
      const current = this.players.get(playerId);
      if (!current || current.connections.size > 0) return;
      this.removePlayer(playerId);
      this.broadcastRoom();
    }, LOBBY_DISCONNECT_GRACE_MS);

    this.broadcastRoom();
  }

  private removePlayer(playerId: string) {
    const seated = this.players.get(playerId);
    if (seated?.dropTimer) clearTimeout(seated.dropTimer);
    this.players.delete(playerId);

    if (this.hostPlayerId === playerId) {
      // The longest-seated survivor takes over rather than the room dying with them.
      const next = [...this.players.values()].sort((a, b) => a.seatIndex - b.seatIndex)[0];
      this.hostPlayerId = next?.playerId ?? null;
      if (next) next.isReady = false;
    }

    if (this.players.size === 0) this.resetRoom();
  }

  private resetRoom() {
    this.clearTurnTimer();
    this.status = "lobby";
    this.game = null;
    this.matchId = null;
    this.hostPlayerId = null;
    this.settings = defaultSettings();
  }

  /* ---------------- messages ---------------- */

  onMessage(raw: string, sender: Party.Connection) {
    const message = decode<ClientMessage>(raw);
    if (!message) {
      this.sendError(sender, "bad_request", "Unreadable message.");
      return;
    }

    const playerId = this.connections.get(sender.id);
    if (!playerId) {
      this.sendError(sender, "bad_request", "Unknown session.");
      return;
    }

    switch (message.type) {
      case "room.create":
        return this.handleSeat(sender, playerId, message.payload.displayName, message.payload.settings, true);
      case "room.join":
        return this.handleSeat(sender, playerId, message.payload.displayName, undefined, false);
      case "room.leave":
        this.removePlayer(playerId);
        return this.broadcastRoom();
      case "room.settings":
        return this.handleSettings(sender, playerId, message.payload.settings);
      case "room.ready":
        return this.handleReady(sender, playerId, message.payload.isReady);
      case "room.start":
        return this.handleStart(sender, playerId);
      case "room.rematch":
        return this.handleRematch(sender, playerId);
      case "match.move":
        return this.handleMove(sender, playerId, message.payload);
      default:
        return this.sendError(sender, "bad_request", "Unsupported message.");
    }
  }

  private handleSeat(
    sender: Party.Connection,
    playerId: string,
    displayName: string,
    settings: Partial<RoomSettings> | undefined,
    isCreate: boolean
  ) {
    const existing = this.players.get(playerId);
    if (existing) {
      // Re-sending a name after a reconnect is a rename, not a second seat.
      existing.displayName = normalizeDisplayName(displayName, existing.seatIndex);
      return this.broadcastRoom();
    }

    if (isCreate && this.players.size > 0) {
      return this.sendError(sender, "bad_request", "That room code is already in use.");
    }
    // Joining an empty room would silently create one, so a mistyped code would
    // strand the player in a lobby nobody else is ever coming to.
    if (!isCreate && this.players.size === 0) {
      return this.sendError(sender, "room_not_found", "No room with that code.");
    }
    if (this.status !== "lobby") {
      return this.sendError(sender, "match_in_progress", "That match has already started.");
    }
    if (this.players.size >= this.settings.maxPlayers) {
      return this.sendError(sender, "room_full", "That room is full.");
    }

    const seatIndex = this.lowestFreeSeat();
    const seated: SeatedPlayer = {
      playerId,
      displayName: normalizeDisplayName(displayName, seatIndex),
      seatIndex,
      isReady: false,
      connections: new Set([sender.id]),
      dropTimer: null
    };
    this.players.set(playerId, seated);

    if (this.hostPlayerId === null) this.hostPlayerId = playerId;
    if (isCreate && settings) this.applySettings(settings);

    this.broadcastRoom();
  }

  private lowestFreeSeat(): number {
    const taken = new Set([...this.players.values()].map((player) => player.seatIndex));
    for (let seat = 0; seat < MAX_PLAYERS; seat += 1) if (!taken.has(seat)) return seat;
    return this.players.size;
  }

  private applySettings(settings: Partial<RoomSettings>) {
    if (settings.boardPreset && settings.boardPreset in BOARD_PRESETS) {
      const preset = BOARD_PRESETS[settings.boardPreset as PresetId];
      this.settings.boardPreset = preset.id;
      this.settings.rows = preset.size;
      this.settings.cols = preset.size;
    }
    if (settings.maxPlayers !== undefined) {
      // Never below the number of people already sitting down.
      this.settings.maxPlayers = clampCapacity(settings.maxPlayers, this.players.size);
    }
  }

  private handleSettings(sender: Party.Connection, playerId: string, settings: Partial<RoomSettings>) {
    if (playerId !== this.hostPlayerId) return this.sendError(sender, "not_host", "Only the host can change setup.");
    if (this.status !== "lobby") return this.sendError(sender, "match_in_progress", "The match has started.");

    this.applySettings(settings);
    // Capacity changes move the goalposts for starting, so stale ready flags
    // would let a match begin that nobody re-confirmed.
    for (const player of this.players.values()) player.isReady = false;
    this.broadcastRoom();
  }

  private handleReady(sender: Party.Connection, playerId: string, isReady: boolean) {
    const seated = this.players.get(playerId);
    if (!seated) return this.sendError(sender, "not_seated", "You are not in this room.");
    if (playerId === this.hostPlayerId) return; // the host has no ready state
    seated.isReady = isReady;
    this.broadcastRoom();
  }

  private canStart(): boolean {
    if (this.status !== "lobby") return false;
    // The architecture doc is explicit: the room must be exactly at capacity.
    if (this.players.size !== this.settings.maxPlayers) return false;
    if (this.players.size < MIN_PLAYERS) return false;
    return [...this.players.values()].every((player) => player.playerId === this.hostPlayerId || player.isReady);
  }

  private handleStart(sender: Party.Connection, playerId: string) {
    if (playerId !== this.hostPlayerId) return this.sendError(sender, "not_host", "Only the host can start.");
    if (!this.canStart()) {
      return this.sendError(sender, "not_ready", "Everyone needs to be seated and ready.");
    }
    this.startMatch();
  }

  private handleRematch(sender: Party.Connection, playerId: string) {
    if (playerId !== this.hostPlayerId) return this.sendError(sender, "not_host", "Only the host can restart.");
    if (this.status !== "finished") return this.sendError(sender, "bad_request", "The match is still running.");

    this.clearTurnTimer();
    this.status = "lobby";
    this.game = null;
    this.matchId = null;
    for (const player of this.players.values()) player.isReady = false;
    this.broadcastRoom();
  }

  private startMatch() {
    const seats = this.seatedInOrder();
    const players: Player[] = seats.map((seat, index) => ({
      id: seat.playerId,
      name: seat.displayName,
      color: PLAYER_COLORS[index % PLAYER_COLORS.length],
      hasEnteredPlay: false,
      isEliminated: false
    }));

    this.game = createInitialState({ rows: this.settings.rows, cols: this.settings.cols }, players);
    this.matchId = crypto.randomUUID();
    this.status = "in_match";
    this.armTurnTimer();

    this.room.broadcast(encode(this.matchMessage("match.started")));
  }

  private handleMove(
    sender: Party.Connection,
    playerId: string,
    payload: { row: number; col: number; moveCount: number }
  ) {
    if (this.status !== "in_match" || !this.game) {
      return this.sendError(sender, "bad_request", "No match is running.");
    }

    const current = this.game.players[this.game.currentPlayerIndex];
    if (!current || current.id !== playerId) {
      return this.sendError(sender, "not_your_turn", "It is not your turn.");
    }
    // A double tap, or a move sent just as the timer auto-played, arrives with a
    // stale count and is dropped rather than played twice.
    if (payload.moveCount !== this.game.moveCount) return;

    const move: Move = { playerId, row: payload.row, col: payload.col };
    if (!isLegalMove(this.game, move)) {
      return this.sendError(sender, "illegal_move", "You cannot play there.");
    }

    this.commitMove(move, false);
  }

  /* ---------------- turn clock ---------------- */

  private clearTurnTimer() {
    if (this.turnTimer) clearTimeout(this.turnTimer);
    this.turnTimer = null;
  }

  private armTurnTimer() {
    this.clearTurnTimer();
    this.turnDeadline = Date.now() + this.settings.turnTimeSeconds * 1000;
    this.turnTimer = setTimeout(() => this.autoPlay(), this.settings.turnTimeSeconds * 1000);
  }

  /**
   * Play for whoever ran out of time — or never showed up after a disconnect.
   *
   * The randomness lives here rather than in the engine, which is the whole point
   * of `pickAutoMove` taking its rng as an argument.
   */
  private autoPlay() {
    if (this.status !== "in_match" || !this.game) return;
    const move = pickAutoMove(this.game, Math.random);
    if (!move) return;
    this.commitMove(move, true);
  }

  private commitMove(move: Move, autoPlayed: boolean) {
    if (!this.game) return;

    // Frames are for the client to animate; the server only needs the outcome.
    this.game = applyMove(this.game, move).state;

    const played: PlayedMove = { playerId: move.playerId, row: move.row, col: move.col, autoPlayed };

    if (this.game.status === "finished") {
      this.clearTurnTimer();
      this.status = "finished";
      this.room.broadcast(
        encode({
          type: "match.finished",
          payload: {
            room: this.roomSnapshot(),
            match: this.matchSnapshot(),
            move: played,
            winnerPlayerId: this.game.winnerId
          }
        })
      );
      return;
    }

    this.armTurnTimer();
    this.room.broadcast(
      encode({
        type: "match.updated",
        payload: { room: this.roomSnapshot(), match: this.matchSnapshot(), move: played }
      })
    );
  }

  /* ---------------- snapshots ---------------- */

  private seatedInOrder(): SeatedPlayer[] {
    return [...this.players.values()].sort((a, b) => a.seatIndex - b.seatIndex);
  }

  private roomSnapshot(): RoomSnapshot {
    const seats = this.seatedInOrder();
    const players: RoomPlayer[] = seats.map((seat, index) => ({
      playerId: seat.playerId,
      displayName: seat.displayName,
      color: PLAYER_COLORS[index % PLAYER_COLORS.length],
      seatIndex: seat.seatIndex,
      isHost: seat.playerId === this.hostPlayerId,
      isReady: seat.playerId === this.hostPlayerId ? true : seat.isReady,
      connectionStatus: seat.connections.size > 0 ? "online" : "offline",
      joinedAs: "player"
    }));

    return {
      roomCode: this.room.id,
      status: this.status,
      hostPlayerId: this.hostPlayerId,
      settings: { ...this.settings },
      players
    };
  }

  private matchSnapshot(): MatchSnapshot {
    return {
      matchId: this.matchId ?? "",
      state: this.game as GameState,
      turnDeadline: this.turnDeadline,
      // Paired with the deadline so a client whose clock is wrong still counts
      // down the right number of seconds.
      serverNow: Date.now()
    };
  }

  private matchMessage(type: "match.started"): ServerMessage {
    return { type, payload: { room: this.roomSnapshot(), match: this.matchSnapshot() } };
  }

  /* ---------------- plumbing ---------------- */

  private send(connection: Party.Connection, message: ServerMessage) {
    connection.send(encode(message));
  }

  private sendError(connection: Party.Connection, code: RoomErrorCode, message: string) {
    this.send(connection, { type: "room.error", payload: { code, message } });
  }

  private broadcastRoom() {
    this.room.broadcast(encode({ type: "room.snapshot", payload: { room: this.roomSnapshot() } }));
  }
}
