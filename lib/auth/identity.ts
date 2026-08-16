/**
 * What a name is, and who owns it.
 *
 * Shared by the browser and the account server, so both agree on exactly which
 * two names are the same name. Deliberately free of React, DOM and Node imports
 * for the same reason `lib/multiplayer/protocol.ts` is — the worker bundles this
 * file too.
 *
 * The model is Pokémon Showdown's, because that is the one this game was asked
 * for: a name is the identity, registering a name claims it, and everybody else
 * plays as a guest under any name that is not claimed. There are no email
 * addresses here, and there is deliberately no password reset — see
 * `worker/accounts.ts` for why that is a feature of this design rather than an
 * omission.
 */

/**
 * The comparison form of a name.
 *
 * Case and punctuation are stripped, so `Sankalp`, `sankalp` and `S.A.N.K.A.L.P`
 * are one account and cannot be used to impersonate each other. This is
 * Showdown's `toID`, and getting it wrong in either direction is the whole
 * security story: too loose and names collide, too strict and impersonation by
 * lookalike is trivial.
 */
export function toUserId(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

export const MIN_NAME_LENGTH = 2;
/** Matches `MAX_DISPLAY_NAME` in the room protocol, so a name that registers can also be worn. */
export const MAX_NAME_LENGTH = 16;

export const MIN_PASSWORD_LENGTH = 6;

/**
 * Names the server keeps for itself.
 *
 * A player called "guest" or "system" could put words in the room's mouth, and
 * the room has no separate channel to say them on.
 */
const RESERVED = new Set(["guest", "system", "server", "admin", "moderator", "mod", "console", "cpu"]);

export type NameCheck = { ok: true; id: string } | { ok: false; reason: string };

export function checkName(name: string): NameCheck {
  const trimmed = name.trim();
  if (trimmed.length > MAX_NAME_LENGTH) {
    return { ok: false, reason: `Names are at most ${MAX_NAME_LENGTH} characters.` };
  }

  const id = toUserId(trimmed);
  if (id.length < MIN_NAME_LENGTH) {
    return { ok: false, reason: `Names need at least ${MIN_NAME_LENGTH} letters or numbers.` };
  }
  if (RESERVED.has(id)) {
    return { ok: false, reason: "That name is reserved." };
  }

  return { ok: true, id };
}

export function checkPassword(password: string): { ok: true } | { ok: false; reason: string } {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return { ok: false, reason: `Passwords need at least ${MIN_PASSWORD_LENGTH} characters.` };
  }
  // A ceiling only so a megabyte of input cannot be handed to the key
  // derivation; it is far above anything a person types.
  if (password.length > 256) {
    return { ok: false, reason: "That password is too long." };
  }
  return { ok: true };
}
