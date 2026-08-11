/**
 * The wire contract between the browser and the authoritative room server.
 *
 * One module, imported by both sides, so a change to a message shape breaks the
 * client and the server in the same `tsc` run rather than at runtime in front of
 * a player. `docs/ARCHITECTURE.md` specifies these event names; this is that
 * contract expressed as types.
 *
 * Deliberately free of React, PartyKit and DOM imports — the server bundles this
 * file too, and it must stay loadable in both places. It may import from
 * `../engine`, which is pure, and does so with a relative path because the
 * server's bundler does not read the Next `@/` alias.
 */

import type { GameState, PresetId } from "../engine";

export const PROTOCOL_VERSION = 1;

export const ROOM_CODE_LENGTH = 6;

/**
 * Ambiguous glyphs are left out. A room code gets read down a voice call and
 * typed by hand, and `0`/`O` and `1`/`I` are where that goes wrong.
 */
const ROOM_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function createRoomCode(random: () => number = Math.random): string {
  let code = "";
  for (let index = 0; index < ROOM_CODE_LENGTH; index += 1) {
    code += ROOM_CODE_ALPHABET[Math.floor(random() * ROOM_CODE_ALPHABET.length)];
  }
  return code;
}

/** Normalises what a player typed: trims, upper-cases, and drops separators. */
export function normalizeRoomCode(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export function isRoomCode(value: string): boolean {
  return new RegExp(`^[${ROOM_CODE_ALPHABET}]{${ROOM_CODE_LENGTH}}$`).test(value);
}

export const MAX_DISPLAY_NAME = 16;

/** Trims and clamps a display name, falling back to a seat-based default. */
export function normalizeDisplayName(value: string, seatIndex: number): string {
  const trimmed = value.trim().slice(0, MAX_DISPLAY_NAME);
  return trimmed.length > 0 ? trimmed : `Player ${seatIndex + 1}`;
}

export type ConnectionStatus = "online" | "offline";

export type RoomStatus = "lobby" | "in_match" | "finished";

export type RoomPlayer = {
  /** Stable across reconnects — derived from the session token, not the socket. */
  playerId: string;
  displayName: string;
  color: string;
  seatIndex: number;
  isHost: boolean;
  /** The host has no ready state; `docs/ARCHITECTURE.md` is explicit about that. */
  isReady: boolean;
  connectionStatus: ConnectionStatus;
  joinedAs: "player" | "spectator";
};

export type RoomSettings = {
  boardPreset: PresetId;
  rows: number;
  cols: number;
  /** Target capacity, 2 to 8. The match cannot start until the room holds exactly this many. */
  maxPlayers: number;
  turnTimeSeconds: number;
};

export type RoomSnapshot = {
  roomCode: string;
  status: RoomStatus;
  hostPlayerId: string | null;
  settings: RoomSettings;
  players: RoomPlayer[];
};

export type MatchSnapshot = {
  matchId: string;
  /** The authoritative game state. `GameState` is already JSON-safe. */
  state: GameState;
  /** Server clock, epoch ms. Paired with `serverNow` so a client with a skewed clock still counts down correctly. */
  turnDeadline: number;
  serverNow: number;
};

export type PlayedMove = {
  playerId: string;
  row: number;
  col: number;
  /** True when the server auto-played for a player who ran out of time or was disconnected. */
  autoPlayed: boolean;
};

export type RoomErrorCode =
  | "room_not_found"
  | "room_full"
  | "match_in_progress"
  | "not_host"
  | "not_seated"
  | "not_your_turn"
  | "illegal_move"
  | "not_ready"
  | "bad_request"
  | "protocol_mismatch";

/* ---------- client -> server ---------- */

export type ClientMessage =
  | { type: "room.create"; payload: { displayName: string; settings: Partial<RoomSettings> } }
  | { type: "room.join"; payload: { displayName: string } }
  | { type: "room.leave"; payload: Record<string, never> }
  | { type: "room.settings"; payload: { settings: Partial<RoomSettings> } }
  | { type: "room.ready"; payload: { isReady: boolean } }
  | { type: "room.start"; payload: Record<string, never> }
  | { type: "room.rematch"; payload: Record<string, never> }
  | {
      type: "match.move";
      payload: {
        row: number;
        col: number;
        /**
         * The mover's view of how many moves have been played. The server drops
         * anything that does not match, which is what makes a double-tap or a
         * message that arrives late harmless rather than a second move.
         */
        moveCount: number;
      };
    };

/* ---------- server -> client ---------- */

export type ServerMessage =
  | { type: "session.ready"; payload: { playerId: string; protocolVersion: number } }
  | { type: "room.snapshot"; payload: { room: RoomSnapshot } }
  | { type: "room.error"; payload: { code: RoomErrorCode; message: string } }
  | { type: "match.started"; payload: { room: RoomSnapshot; match: MatchSnapshot } }
  | { type: "match.updated"; payload: { room: RoomSnapshot; match: MatchSnapshot; move: PlayedMove } }
  | {
      type: "match.finished";
      payload: {
        room: RoomSnapshot;
        match: MatchSnapshot;
        /** The move that ended it. Carried here too, or the winning cascade would never animate. */
        move: PlayedMove;
        winnerPlayerId: string | null;
      };
    };

export function encode(message: ClientMessage | ServerMessage): string {
  return JSON.stringify(message);
}

/**
 * Parse a frame off the wire.
 *
 * Returns `null` rather than throwing on anything malformed: a peer can send
 * whatever it likes, and a room server that throws on bad input is a room server
 * anyone can knock over.
 */
export function decode<T extends ClientMessage | ServerMessage>(raw: string): T | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    if (typeof (parsed as { type?: unknown }).type !== "string") return null;
    if (typeof (parsed as { payload?: unknown }).payload !== "object") return null;
    return parsed as T;
  } catch {
    return null;
  }
}
