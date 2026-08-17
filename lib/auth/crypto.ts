/**
 * The cryptography behind logging in.
 *
 * Web Crypto only, so one copy of this runs in the browser, in the Cloudflare
 * Worker and in Node tests. No dependencies, and nothing here is reachable from
 * `lib/engine/`.
 *
 * ## Why the slow hash runs in the browser
 *
 * A password should be stretched with a deliberately expensive key derivation,
 * and the honest place for that is the server. This one cannot afford it: the
 * room server runs on a free Cloudflare plan, which budgets a Worker roughly ten
 * milliseconds of CPU per request, and PBKDF2 at any defensible iteration count
 * is tens to hundreds of milliseconds. Raising the plan is a cost decision that
 * is not mine to make, and quietly dropping to a few thousand iterations would
 * look like security while providing very little.
 *
 * So the stretch happens in the browser — `deriveAuthKey` — and the server
 * stores a single salted SHA-256 of the result. The property that actually
 * matters is preserved: somebody who steals the database holds
 * `SHA-256(salt || authKey)` and still has to run `PBKDF2` at
 * `${PBKDF2_ITERATIONS}` iterations per guess to get back to a password. The
 * expensive barrier is in exactly the same place; only the machine paying for it
 * moved. Storing a fast hash of a *password* would be the bad version of this,
 * and is not what happens here.
 *
 * What this does cost, stated plainly: the derived key is password-equivalent in
 * transit, so a login depends on TLS in the same way that posting the password
 * itself would. It also means the iteration count cannot be raised later without
 * every existing account needing a re-derivation on next login, which is why the
 * salt below carries a version marker.
 */

/**
 * OWASP's floor for PBKDF2-HMAC-SHA256 is higher than this. It is set here by
 * what a mid-range Android phone will do without the login feeling broken —
 * roughly a third of a second — because the brief for this game names that
 * device, and a login nobody completes protects nothing.
 */
export const PBKDF2_ITERATIONS = 200_000;

const encoder = new TextEncoder();

export function toBase64(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

const toBase64Url = (bytes: ArrayBuffer | Uint8Array) =>
  toBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const fromBase64Url = (value: string) =>
  fromBase64(value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "="));

export function randomSalt(bytes = 16): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(bytes)));
}

/**
 * Turn a password into the value the client actually sends.
 *
 * The salt is the account id rather than a random value, because the browser has
 * to derive this *before* it has spoken to the server — there is nothing else it
 * could know. It is domain-separated and versioned so the same password on
 * another site, or under a future scheme here, produces a different key.
 */
export async function deriveAuthKey(userId: string, password: string): Promise<string> {
  const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, [
    "deriveBits"
  ]);

  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: encoder.encode(`cr-gaym:auth:v1:${userId}`),
      iterations: PBKDF2_ITERATIONS,
      hash: "SHA-256"
    },
    material,
    256
  );

  return toBase64(bits);
}

/** What the server stores: a salted digest of the key the client sent. */
export async function hashAuthKey(authKey: string, salt: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`${salt}:${authKey}`));
  return toBase64(digest);
}

/**
 * Constant-time comparison.
 *
 * `===` on a digest leaks how much of it matched through timing. The values here
 * are hashes rather than secrets, so the leak is mild, but the fix is four lines.
 */
export function equalsConstantTime(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export type SessionClaims = {
  /** Account id — the normalised name. */
  sub: string;
  /** Display form of the name at the time the token was issued. */
  name: string;
  /** Expiry, epoch milliseconds. */
  exp: number;
};

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
}

/**
 * Sign a session token.
 *
 * A signed claim rather than a row in a sessions table: the room server can then
 * check who you are without a round trip to storage on every connect, which is
 * the only reason a name badge is affordable on a socket that opens as often as
 * this one does.
 */
export async function signSession(claims: SessionClaims, secret: string): Promise<string> {
  const payload = toBase64Url(encoder.encode(JSON.stringify(claims)));
  const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(payload));
  return `${payload}.${toBase64Url(signature)}`;
}

/** Returns null for anything unsigned, tampered with, malformed or expired. */
export async function verifySession(
  token: string,
  secret: string,
  nowMs: number
): Promise<SessionClaims | null> {
  const dot = token.indexOf(".");
  if (dot <= 0 || dot === token.length - 1) return null;

  const payload = token.slice(0, dot);
  const provided = token.slice(dot + 1);

  let expected: string;
  try {
    const signature = await crypto.subtle.sign("HMAC", await hmacKey(secret), encoder.encode(payload));
    expected = toBase64Url(signature);
  } catch {
    return null;
  }

  if (!equalsConstantTime(provided, expected)) return null;

  try {
    const claims = JSON.parse(new TextDecoder().decode(fromBase64Url(payload))) as SessionClaims;
    if (typeof claims?.sub !== "string" || typeof claims?.name !== "string") return null;
    if (typeof claims?.exp !== "number" || claims.exp <= nowMs) return null;
    return claims;
  } catch {
    return null;
  }
}
