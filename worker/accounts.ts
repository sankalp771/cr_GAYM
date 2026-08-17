/**
 * The account server, as a single Durable Object.
 *
 * ## Why one object rather than D1
 *
 * D1 is the obvious home for a users table, and it is the wrong one here for a
 * practical reason: creating a D1 database needs a Cloudflare account and a
 * `wrangler d1 create`, which makes the whole feature undeliverable until
 * somebody hands over credentials. A Durable Object needs neither — the
 * `new_sqlite_classes` migration this project already ships for rooms covers
 * this class too, and `wrangler dev` gives it a real local SQLite.
 *
 * The cost is that every account read and write funnels through one object.
 * That is a genuine bottleneck and it is an acceptable one: a login happens once
 * per player per month, and `/auth/resolve` — the hot path, one call per socket
 * — is a single indexed primary-key lookup. **If this ever needs to scale, move
 * the table to D1 rather than sharding this object**; the schema below is
 * ordinary SQL and the move is mechanical.
 *
 * ## Why there is no password reset
 *
 * Registration takes a name and a password and nothing else. There is no email
 * address on file, so there is nothing to send a reset to — which is exactly
 * Showdown's arrangement, and it is a deliberate trade rather than an oversight:
 * asking a player for an email address to play a browser game means storing
 * personal data, and this way there is none to store, leak or delete. A
 * forgotten password means a forgotten name.
 *
 * ## What is stored
 *
 * A name, its normalised id, a random salt, and `SHA-256(salt || authKey)` where
 * `authKey` is what the browser derived. No password, and no way back to one
 * without redoing the client's key derivation per guess. See `lib/auth/crypto.ts`
 * for why the expensive half lives in the browser.
 */

import {
  equalsConstantTime,
  hashAuthKey,
  randomSalt,
  signSession,
  verifySession
} from "../lib/auth/crypto";
import { checkName, toUserId } from "../lib/auth/identity";
import {
  AUTH_PROTOCOL_VERSION,
  SESSION_TTL_MS,
  type Account,
  type AuthErrorCode,
  type AuthResponse,
  type CredentialsRequest,
  type MeResponse,
  type NameStatusResponse,
  type ResolveRequest,
  type ResolveResponse
} from "../lib/auth/protocol";

type UserRow = {
  id: string;
  name: string;
  salt: string;
  hash: string;
  registered_at: number;
  last_login_at: number;
};

/**
 * Failed attempts allowed per name before it is put on ice.
 *
 * Per name rather than per IP: this sits behind Cloudflare, and the address a
 * Worker sees is shared by everyone on a mobile carrier. Locking a name is also
 * the thing worth protecting — the attacker is guessing one account's password,
 * and the real owner is inconvenienced for a minute rather than locked out.
 */
const MAX_ATTEMPTS = 8;
const ATTEMPT_WINDOW_MS = 60_000;

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { "cache-control": "no-store" } });

const fail = (code: AuthErrorCode, message: string, status = 400) =>
  json({ ok: false, code, message }, status);

export class Accounts {
  private ready = false;
  /** name id -> recent failures. In memory on purpose: a lockout need not outlive the object. */
  private attempts = new Map<string, { count: number; firstAt: number }>();

  constructor(readonly state: DurableObjectState) {}

  private sql() {
    return this.state.storage.sql;
  }

  /**
   * Create the schema, and mint the token-signing secret on first use.
   *
   * The secret lives in the same storage as the hashes rather than in a Wrangler
   * secret, so the feature deploys with no configuration at all. It is generated
   * once and never leaves this object. Deleting it — or the object — signs
   * everybody out, which is the only rotation mechanism there is and is the
   * right one to reach for if it is ever suspected.
   */
  private async init() {
    if (this.ready) return;

    this.sql().exec(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        salt TEXT NOT NULL,
        hash TEXT NOT NULL,
        registered_at INTEGER NOT NULL,
        last_login_at INTEGER NOT NULL
      );
    `);
    this.sql().exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);

    this.ready = true;
  }

  private async secret(): Promise<string> {
    await this.init();
    const existing = [...this.sql().exec<{ value: string }>("SELECT value FROM meta WHERE key = 'token_secret'")];
    if (existing.length > 0) return existing[0].value;

    const created = randomSalt(32);
    this.sql().exec("INSERT INTO meta (key, value) VALUES ('token_secret', ?)", created);
    return created;
  }

  private find(id: string): UserRow | null {
    const rows = [...this.sql().exec<UserRow>("SELECT * FROM users WHERE id = ?", id)];
    return rows[0] ?? null;
  }

  private static asAccount(row: UserRow): Account {
    return { id: row.id, name: row.name, registeredAt: row.registered_at };
  }

  private throttled(id: string, now: number): boolean {
    const record = this.attempts.get(id);
    if (!record) return false;
    if (now - record.firstAt > ATTEMPT_WINDOW_MS) {
      this.attempts.delete(id);
      return false;
    }
    return record.count >= MAX_ATTEMPTS;
  }

  private noteFailure(id: string, now: number) {
    const record = this.attempts.get(id);
    if (!record || now - record.firstAt > ATTEMPT_WINDOW_MS) {
      this.attempts.set(id, { count: 1, firstAt: now });
      return;
    }
    record.count += 1;
  }

  async fetch(request: Request): Promise<Response> {
    await this.init();

    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/auth/, "") || "/";

    if (request.method === "GET" && path === "/") {
      return json({ ok: true, protocolVersion: AUTH_PROTOCOL_VERSION });
    }
    if (request.method === "POST" && path === "/register") return this.register(request);
    if (request.method === "POST" && path === "/login") return this.login(request);
    if (request.method === "POST" && path === "/resolve") return this.resolve(request);
    if (request.method === "GET" && path === "/me") return this.me(url);
    if (request.method === "GET" && path.startsWith("/name/")) {
      return this.nameStatus(decodeURIComponent(path.slice("/name/".length)));
    }

    return fail("bad_request", "No such account route.", 404);
  }

  private async body<T>(request: Request): Promise<T | null> {
    try {
      const parsed = (await request.json()) as unknown;
      if (typeof parsed !== "object" || parsed === null) return null;
      return parsed as T;
    } catch {
      return null;
    }
  }

  private async issue(row: UserRow): Promise<AuthResponse> {
    const token = await signSession(
      { sub: row.id, name: row.name, exp: Date.now() + SESSION_TTL_MS },
      await this.secret()
    );
    return { ok: true, token, account: Accounts.asAccount(row) };
  }

  private async register(request: Request): Promise<Response> {
    const body = await this.body<CredentialsRequest>(request);
    if (!body || typeof body.name !== "string" || typeof body.authKey !== "string") {
      return fail("bad_request", "Send a name and a key.");
    }

    const name = checkName(body.name);
    if (!name.ok) return fail("name_invalid", name.reason);
    if (body.authKey.length < 16 || body.authKey.length > 128) {
      return fail("bad_request", "That key is not the right shape.");
    }

    if (this.find(name.id)) {
      // Said plainly. Hiding it would be pointless — the join screen has to be
      // able to tell a player a name is taken before they try to wear it.
      return fail("name_taken", "That name is already registered.", 409);
    }

    const now = Date.now();
    const salt = randomSalt();
    const hash = await hashAuthKey(body.authKey, salt);
    const display = body.name.trim();

    this.sql().exec(
      "INSERT INTO users (id, name, salt, hash, registered_at, last_login_at) VALUES (?, ?, ?, ?, ?, ?)",
      name.id,
      display,
      salt,
      hash,
      now,
      now
    );

    return json(await this.issue({
      id: name.id,
      name: display,
      salt,
      hash,
      registered_at: now,
      last_login_at: now
    }));
  }

  private async login(request: Request): Promise<Response> {
    const body = await this.body<CredentialsRequest>(request);
    if (!body || typeof body.name !== "string" || typeof body.authKey !== "string") {
      return fail("bad_request", "Send a name and a key.");
    }

    const id = toUserId(body.name);
    const now = Date.now();

    if (this.throttled(id, now)) {
      return fail("rate_limited", "Too many attempts. Wait a minute and try again.", 429);
    }

    const row = this.find(id);
    if (!row) {
      this.noteFailure(id, now);
      // Same message and same shape as a wrong password: whether a name exists
      // is already public through `/auth/name`, but there is no reason for this
      // route to be a second, faster oracle for it.
      return fail("bad_credentials", "That name and password do not match.", 401);
    }

    const candidate = await hashAuthKey(body.authKey, row.salt);
    if (!equalsConstantTime(candidate, row.hash)) {
      this.noteFailure(id, now);
      return fail("bad_credentials", "That name and password do not match.", 401);
    }

    this.attempts.delete(id);
    this.sql().exec("UPDATE users SET last_login_at = ? WHERE id = ?", now, id);

    return json(await this.issue(row));
  }

  private async me(url: URL): Promise<Response> {
    const token = url.searchParams.get("token");
    if (!token) return fail("bad_request", "No token.", 401);

    const claims = await verifySession(token, await this.secret(), Date.now());
    if (!claims) return fail("bad_credentials", "That session is not valid.", 401);

    const row = this.find(claims.sub);
    if (!row) return fail("bad_credentials", "That account no longer exists.", 401);

    const response: MeResponse = { ok: true, account: Accounts.asAccount(row) };
    return json(response);
  }

  private nameStatus(rawName: string): Response {
    const name = checkName(rawName);
    if (!name.ok) {
      const failure: NameStatusResponse = { ok: false, code: "name_invalid", message: name.reason };
      return json(failure);
    }

    const response: NameStatusResponse = { ok: true, id: name.id, registered: this.find(name.id) !== null };
    return json(response);
  }

  /**
   * Answer the room server's one question per socket.
   *
   * Both halves matter. The account is who the player provably is; `nameClaimed`
   * is whether the name they asked for belongs to somebody who is not them. A
   * room that only checked the first would let a guest sit down as anyone.
   */
  private async resolve(request: Request): Promise<Response> {
    const body = (await this.body<ResolveRequest>(request)) ?? {};

    let account: Account | null = null;
    if (typeof body.token === "string" && body.token.length > 0) {
      const claims = await verifySession(body.token, await this.secret(), Date.now());
      const row = claims ? this.find(claims.sub) : null;
      if (row) account = Accounts.asAccount(row);
    }

    let nameClaimed = false;
    if (typeof body.name === "string" && body.name.length > 0) {
      const id = toUserId(body.name);
      if (id.length > 0 && id !== account?.id) nameClaimed = this.find(id) !== null;
    }

    const response: ResolveResponse = { ok: true, account, nameClaimed };
    return json(response);
  }
}
