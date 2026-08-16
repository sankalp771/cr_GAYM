/**
 * The contract between the browser and the account server.
 *
 * One module imported by both, so a change to a payload breaks the client and
 * the worker in the same `tsc` run — the same arrangement
 * `lib/multiplayer/protocol.ts` has for rooms.
 *
 * A raw password never appears in any type here. The browser derives
 * `authKey` (see `crypto.ts`) and that is the only credential that travels.
 */

export const AUTH_PROTOCOL_VERSION = 1;

/** A month. Long enough that a casual player stays signed in between sessions. */
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export type Account = {
  /** Normalised name — the account's identity. */
  id: string;
  /** Display form, as registered. */
  name: string;
  registeredAt: number;
};

export type AuthErrorCode =
  | "bad_request"
  | "name_taken"
  | "name_invalid"
  | "bad_credentials"
  | "rate_limited"
  | "server_error";

export type AuthFailure = { ok: false; code: AuthErrorCode; message: string };

export type AuthSuccess = { ok: true; token: string; account: Account };

export type AuthResponse = AuthSuccess | AuthFailure;

export type CredentialsRequest = {
  name: string;
  /** Base64 PBKDF2 output. Never the password. */
  authKey: string;
};

/** `GET /auth/name/:name` — what the join screen asks before letting a guest wear a name. */
export type NameStatusResponse = { ok: true; id: string; registered: boolean } | AuthFailure;

export type MeResponse = { ok: true; account: Account } | AuthFailure;

/**
 * `POST /auth/resolve` — the room server's question, not the browser's.
 *
 * Asked once per socket, it answers both halves of "who is this, and may they
 * wear this name": the account a token proves, and whether the requested name
 * belongs to somebody else.
 */
export type ResolveRequest = { token?: string | null; name?: string | null };

export type ResolveResponse = {
  ok: true;
  account: Account | null;
  /** True when `name` normalises to a registered account that the token did not prove. */
  nameClaimed: boolean;
};
