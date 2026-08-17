/**
 * Authoritative Chain Reaction room, as a Cloudflare Durable Object.
 *
 * One instance per room code, guaranteed globally by the platform — which is the
 * whole reason a room can hold its state in memory and two players can be sure
 * they are talking to the same one.
 *
 * ## Why this is not PartyKit
 *
 * It was, briefly. PartyKit could not deploy: its shared `partykit.dev` zone has
 * hit Cloudflare's 10,000-custom-domains-per-zone ceiling, and deploying to a
 * private account fails too, because a free Cloudflare plan only permits
 * SQLite-backed Durable Objects (`new_sqlite_classes`) and no published PartyKit
 * build — latest or beta — emits that migration. The wrapper was one layer over
 * exactly this class, so it was removed rather than paid around.
 *
 * ## Why this can import the game engine directly
 *
 * `lib/engine/` is pure — no React, no DOM, no `Date.now()`, no `Math.random()`,
 * enforced in `eslint.config.mjs`. That rule exists precisely so this file can
 * exist: the rules run here and in the browser from one copy, so a server and a
 * client cannot disagree about what a move did. Both things the engine refuses to
 * touch are injected right here — `Math.random` for auto-play selection, and the
 * wall clock for turn deadlines.
 *
 * ## Why the client is not sent cascade frames
 *
 * A resolved move can produce hundreds of animation frames, each a full board
 * clone. The client is sent the move and the resulting state, replays the move
 * through its own engine to generate identical frames, and reconciles afterwards.
 * Determinism is what makes that safe.
 */

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
import { toUserId } from "../lib/auth/identity";
import type { ResolveRequest, ResolveResponse } from "../lib/auth/protocol";

export type Env = {
  ROOMS: DurableObjectNamespace;
  /** The account server. Rooms ask it who a connecting socket is; see `onConnect`. */
  ACCOUNTS: DurableObjectNamespace;
};

const MIN_PLAYERS = 2;
const MAX_PLAYERS = 8;

/**
 * Grace period before a disconnected player loses their lobby seat.
 *
 * A refresh drops the socket and opens a new one, and taking the seat away in
 * between would make refreshing feel like being kicked. In a running match the
 * seat is never freed at all — the match keeps going and auto-plays for them.
 */
const LOBBY_DISCONNECT_GRACE_MS = 10_000;

type SeatedPlayer = {
  playerId: string;
  displayName: string;
  seatIndex: number;
  isReady: boolean;
  /** Account id when the session token checked out, null for a guest. */
  accountId: string | null;
  /** A player may briefly hold two sockets while a refresh hands over. */
  connections: Set<string>;
  dropTimer: ReturnType<typeof setTimeout> | null;
};

type Client = { id: string; socket: WebSocket };

/** What the account server said about a socket, cached for the life of that socket. */
type Identity = {
  account: { id: string; name: string } | null;
  /** The name id this was resolved for, so a rename can tell it needs asking again. */
  resolvedFor: string;
  nameClaimed: boolean;
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

export class ChainReactionRoom {
  private clients = new Map<string, Client>();
  private players = new Map<string, SeatedPlayer>();
  /** Session token -> playerId. The token is never broadcast; the id is. */
  private tokens = new Map<string, string>();
  private connections = new Map<string, string>();
  /** connectionId -> what the account server said. Never trusted from the client. */
  private identities = new Map<string, Identity>();
  /** Seat requests already in flight, so a double-send cannot take two seats. */
  private seating = new Set<string>();

  private roomCode = "";
  private hostPlayerId: string | null = null;
  private status: RoomStatus = "lobby";
  private settings: RoomSettings = defaultSettings();

  private game: GameState | null = null;
  private matchId: string | null = null;
  private turnDeadline = 0;
  private turnTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    readonly state: DurableObjectState,
    readonly env: Env
  ) {}

  /**
   * Ask the account server who this is.
   *
   * The room never inspects a session token itself — it has no signing secret
   * and should not have one. Answering "who are you" is the account object's
   * job, and this is the one call per socket that asks it. A failure here is
   * treated as "guest, and the name is free": the account server being down must
   * not stop people playing, and the worst case is that a registered name is
   * briefly wearable by somebody else in one room.
   */
  private async resolveIdentity(token: string | null, name: string | null): Promise<Identity> {
    const resolvedFor = toUserId(name ?? "");
    const empty: Identity = { account: null, resolvedFor, nameClaimed: false };

    if (!this.env.ACCOUNTS) return empty;
    if (!token && resolvedFor.length === 0) return empty;

    try {
      const accounts = this.env.ACCOUNTS.get(this.env.ACCOUNTS.idFromName("accounts"));
      const response = await accounts.fetch("https://accounts.internal/auth/resolve", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token, name } satisfies ResolveRequest)
      });
      if (!response.ok) return empty;

      const body = (await response.json()) as ResolveResponse;
      if (!body?.ok) return empty;

      return {
        account: body.account ? { id: body.account.id, name: body.account.name } : null,
        resolvedFor,
        nameClaimed: body.nameClaimed
      };
    } catch {
      return empty;
    }
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    // The object is addressed by name, but does not otherwise learn what that
    // name was, so the router passes it along.
    this.roomCode = url.searchParams.get("room") ?? this.roomCode;

    if (request.headers.get("Upgrade") !== "websocket") {
      // Plain HTTP view: enough for an uptime check, and what the Playwright
      // suite polls before it drives browsers. Says nothing about the board.
      return Response.json({
        ok: true,
        protocolVersion: PROTOCOL_VERSION,
        room: this.roomCode,
        status: this.status,
        players: this.players.size,
        capacity: this.settings.maxPlayers
      });
    }

    const token = url.searchParams.get("token");
    if (!token) return new Response("Missing session token.", { status: 400 });

    // Resolved before the socket is accepted, so that by the time any message
    // arrives the server already knows who is on the other end. Doing it lazily
    // would make the very first `room.join` race the answer.
    const identity = await this.resolveIdentity(
      url.searchParams.get("auth"),
      url.searchParams.get("name")
    );

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();

    const connectionId = crypto.randomUUID();
    this.clients.set(connectionId, { id: connectionId, socket: server });
    this.identities.set(connectionId, identity);

    server.addEventListener("message", (event: MessageEvent) => {
      if (typeof event.data === "string") this.onMessage(event.data, connectionId);
    });
    const drop = () => this.dropConnection(connectionId);
    server.addEventListener("close", drop);
    server.addEventListener("error", drop);

    this.onConnect(connectionId, token);

    return new Response(null, { status: 101, webSocket: client });
  }

  /* ---------------- connection lifecycle ---------------- */

  private onConnect(connectionId: string, token: string) {
    const existingId = this.tokens.get(token);
    const playerId = existingId ?? crypto.randomUUID();
    if (!existingId) this.tokens.set(token, playerId);
    this.connections.set(connectionId, playerId);

    // A returning player keeps their seat, their colour and their orbs.
    const seated = this.players.get(playerId);
    if (seated) {
      seated.connections.add(connectionId);
      if (seated.dropTimer) {
        clearTimeout(seated.dropTimer);
        seated.dropTimer = null;
      }
    }

    this.sendTo(connectionId, {
      type: "session.ready",
      payload: { playerId, protocolVersion: PROTOCOL_VERSION }
    });

    // An unseated connection still gets the snapshot, so a join screen can show
    // who is already waiting before committing to a seat.
    this.sendTo(connectionId, { type: "room.snapshot", payload: { room: this.roomSnapshot() } });
    if (seated && this.game) {
      this.sendTo(connectionId, {
        type: "match.started",
        payload: { room: this.roomSnapshot(), match: this.matchSnapshot() }
      });
    }
    if (seated) this.broadcastRoom();
  }

  private dropConnection(connectionId: string) {
    this.clients.delete(connectionId);
    this.identities.delete(connectionId);
    const playerId = this.connections.get(connectionId);
    this.connections.delete(connectionId);
    if (!playerId) return;

    const seated = this.players.get(playerId);
    if (!seated) return;

    seated.connections.delete(connectionId);
    if (seated.connections.size > 0) return;

    // In a match the seat is held indefinitely — the turn timer auto-plays, so
    // the match never stalls on somebody's flaky wifi.
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
      // The longest-seated survivor takes over rather than the room dying.
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

  private onMessage(raw: string, connectionId: string) {
    const message = decode<ClientMessage>(raw);
    if (!message) return this.sendError(connectionId, "bad_request", "Unreadable message.");

    const playerId = this.connections.get(connectionId);
    if (!playerId) return this.sendError(connectionId, "bad_request", "Unknown session.");

    switch (message.type) {
      // Seating is the one handler that can need the account server, so it is
      // the one that is async. Nothing else depends on its result, and a second
      // seat message while the first is in flight is dropped rather than queued.
      case "room.create":
        void this.handleSeat(
          connectionId,
          playerId,
          message.payload.displayName,
          message.payload.settings,
          true
        );
        return;
      case "room.join":
        void this.handleSeat(connectionId, playerId, message.payload.displayName, undefined, false);
        return;
      case "room.leave":
        this.removePlayer(playerId);
        return this.broadcastRoom();
      case "room.settings":
        return this.handleSettings(connectionId, playerId, message.payload.settings);
      case "room.ready":
        return this.handleReady(connectionId, playerId, message.payload.isReady);
      case "room.start":
        return this.handleStart(connectionId, playerId);
      case "room.rematch":
        return this.handleRematch(connectionId, playerId);
      case "match.move":
        return this.handleMove(connectionId, playerId, message.payload);
      default:
        return this.sendError(connectionId, "bad_request", "Unsupported message.");
    }
  }

  /**
   * Who this connection may sit down as.
   *
   * A logged-in player always wears their registered name — the server's copy of
   * it, not one the client sent — so a session token cannot be used to sit under
   * a different spelling. A guest gets the name they asked for unless it is
   * registered to somebody else, which is the entire point of registering one.
   *
   * The account server is asked again only when the requested name is not the
   * one this socket was resolved for, so the ordinary path costs nothing.
   */
  private async nameFor(
    connectionId: string,
    requested: string,
    seatIndex: number
  ): Promise<{ ok: true; name: string; accountId: string | null } | { ok: false; message: string }> {
    let identity = this.identities.get(connectionId);

    // Only a guest can be asking for a different name than the one this socket
    // was resolved for — a signed-in player's name is not theirs to choose — so
    // the re-resolve needs no token.
    if (identity && !identity.account && toUserId(requested) !== identity.resolvedFor) {
      identity = await this.resolveIdentity(null, requested);
      this.identities.set(connectionId, identity);
    }

    if (identity?.account) {
      return { ok: true, name: identity.account.name, accountId: identity.account.id };
    }
    if (identity?.nameClaimed) {
      return {
        ok: false,
        message: "That name is registered. Log in to use it, or pick another."
      };
    }

    return { ok: true, name: normalizeDisplayName(requested, seatIndex), accountId: null };
  }

  private async handleSeat(
    connectionId: string,
    playerId: string,
    displayName: string,
    settings: Partial<RoomSettings> | undefined,
    isCreate: boolean
  ) {
    if (this.seating.has(playerId)) return;
    this.seating.add(playerId);
    try {
      await this.seat(connectionId, playerId, displayName, settings, isCreate);
    } finally {
      this.seating.delete(playerId);
    }
  }

  private async seat(
    connectionId: string,
    playerId: string,
    displayName: string,
    settings: Partial<RoomSettings> | undefined,
    isCreate: boolean
  ) {
    const existing = this.players.get(playerId);
    if (existing) {
      // Re-sending a name after a reconnect is a rename, not a second seat.
      const renamed = await this.nameFor(connectionId, displayName, existing.seatIndex);
      if (!renamed.ok) return this.sendError(connectionId, "name_claimed", renamed.message);
      existing.displayName = renamed.name;
      existing.accountId = renamed.accountId;
      return this.broadcastRoom();
    }

    if (isCreate && this.players.size > 0) {
      return this.sendError(connectionId, "bad_request", "That room code is already in use.");
    }
    // Joining an empty room would silently create one, so a mistyped code would
    // strand the player in a lobby nobody else is ever coming to.
    if (!isCreate && this.players.size === 0) {
      return this.sendError(connectionId, "room_not_found", "No room with that code.");
    }
    if (this.status !== "lobby") {
      return this.sendError(connectionId, "match_in_progress", "That match has already started.");
    }
    if (this.players.size >= this.settings.maxPlayers) {
      return this.sendError(connectionId, "room_full", "That room is full.");
    }

    const seatIndex = this.lowestFreeSeat();
    const claimed = await this.nameFor(connectionId, displayName, seatIndex);
    if (!claimed.ok) return this.sendError(connectionId, "name_claimed", claimed.message);

    // A registered player may hold only one seat in a room. Without this, one
    // account logged in twice could fill a lobby with copies of itself.
    if (claimed.accountId) {
      for (const seated of this.players.values()) {
        if (seated.accountId === claimed.accountId) {
          return this.sendError(connectionId, "bad_request", "That account is already in this room.");
        }
      }
    }

    this.players.set(playerId, {
      playerId,
      displayName: claimed.name,
      seatIndex,
      isReady: false,
      accountId: claimed.accountId,
      connections: new Set([connectionId]),
      dropTimer: null
    });

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

  private handleSettings(connectionId: string, playerId: string, settings: Partial<RoomSettings>) {
    if (playerId !== this.hostPlayerId) {
      return this.sendError(connectionId, "not_host", "Only the host can change setup.");
    }
    if (this.status !== "lobby") {
      return this.sendError(connectionId, "match_in_progress", "The match has started.");
    }

    this.applySettings(settings);
    // Capacity changes move the goalposts for starting, so stale ready flags
    // would let a match begin that nobody re-confirmed.
    for (const player of this.players.values()) player.isReady = false;
    this.broadcastRoom();
  }

  private handleReady(connectionId: string, playerId: string, isReady: boolean) {
    const seated = this.players.get(playerId);
    if (!seated) return this.sendError(connectionId, "not_seated", "You are not in this room.");
    if (playerId === this.hostPlayerId) return; // the host has no ready state
    seated.isReady = isReady;
    this.broadcastRoom();
  }

  private canStart(): boolean {
    if (this.status !== "lobby") return false;
    // The architecture doc is explicit: the room must be exactly at capacity.
    if (this.players.size !== this.settings.maxPlayers) return false;
    if (this.players.size < MIN_PLAYERS) return false;
    return [...this.players.values()].every(
      (player) => player.playerId === this.hostPlayerId || player.isReady
    );
  }

  private handleStart(connectionId: string, playerId: string) {
    if (playerId !== this.hostPlayerId) return this.sendError(connectionId, "not_host", "Only the host can start.");
    if (!this.canStart()) {
      return this.sendError(connectionId, "not_ready", "Everyone needs to be seated and ready.");
    }
    this.startMatch();
  }

  private handleRematch(connectionId: string, playerId: string) {
    if (playerId !== this.hostPlayerId) {
      return this.sendError(connectionId, "not_host", "Only the host can restart.");
    }
    if (this.status !== "finished") {
      return this.sendError(connectionId, "bad_request", "The match is still running.");
    }

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

    this.broadcast({
      type: "match.started",
      payload: { room: this.roomSnapshot(), match: this.matchSnapshot() }
    });
  }

  private handleMove(
    connectionId: string,
    playerId: string,
    payload: { row: number; col: number; moveCount: number }
  ) {
    if (this.status !== "in_match" || !this.game) {
      return this.sendError(connectionId, "bad_request", "No match is running.");
    }

    const current = this.game.players[this.game.currentPlayerIndex];
    if (!current || current.id !== playerId) {
      return this.sendError(connectionId, "not_your_turn", "It is not your turn.");
    }
    // A double tap, or a move sent just as the timer auto-played, arrives with a
    // stale count and is dropped rather than played twice.
    if (payload.moveCount !== this.game.moveCount) return;

    const move: Move = { playerId, row: payload.row, col: payload.col };
    if (!isLegalMove(this.game, move)) {
      return this.sendError(connectionId, "illegal_move", "You cannot play there.");
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
   * Play for whoever ran out of time — or never came back after a disconnect.
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
      this.broadcast({
        type: "match.finished",
        payload: {
          room: this.roomSnapshot(),
          match: this.matchSnapshot(),
          move: played,
          winnerPlayerId: this.game.winnerId
        }
      });
      return;
    }

    this.armTurnTimer();
    this.broadcast({
      type: "match.updated",
      payload: { room: this.roomSnapshot(), match: this.matchSnapshot(), move: played }
    });
  }

  /* ---------------- snapshots ---------------- */

  private seatedInOrder(): SeatedPlayer[] {
    return [...this.players.values()].sort((a, b) => a.seatIndex - b.seatIndex);
  }

  private roomSnapshot(): RoomSnapshot {
    const players: RoomPlayer[] = this.seatedInOrder().map((seat, index) => ({
      playerId: seat.playerId,
      displayName: seat.displayName,
      color: PLAYER_COLORS[index % PLAYER_COLORS.length],
      seatIndex: seat.seatIndex,
      isHost: seat.playerId === this.hostPlayerId,
      isReady: seat.playerId === this.hostPlayerId ? true : seat.isReady,
      connectionStatus: seat.connections.size > 0 ? "online" : "offline",
      joinedAs: "player",
      isRegistered: seat.accountId !== null
    }));

    return {
      roomCode: this.roomCode,
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

  /* ---------------- plumbing ---------------- */

  private sendTo(connectionId: string, message: ServerMessage) {
    const client = this.clients.get(connectionId);
    if (!client) return;
    try {
      client.socket.send(encode(message));
    } catch {
      this.clients.delete(connectionId);
    }
  }

  private sendError(connectionId: string, code: RoomErrorCode, message: string) {
    this.sendTo(connectionId, { type: "room.error", payload: { code, message } });
  }

  private broadcast(message: ServerMessage) {
    const raw = encode(message);
    for (const [id, client] of this.clients) {
      try {
        client.socket.send(raw);
      } catch {
        this.clients.delete(id);
      }
    }
  }

  private broadcastRoom() {
    this.broadcast({ type: "room.snapshot", payload: { room: this.roomSnapshot() } });
  }
}
