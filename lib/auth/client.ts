/**
 * Talking to the account server from the browser.
 *
 * The password never leaves this module. Every call derives a key first — see
 * `crypto.ts` for why the expensive derivation runs here rather than on the
 * server — and sends that.
 *
 * Deliberately free of React so it can be tested in Node against a stubbed
 * `fetch`; the hook that holds the session lives in `use-account.ts`.
 */

import { workerOrigin } from "@/lib/multiplayer/host";
import { deriveAuthKey } from "./crypto";
import { checkName, checkPassword } from "./identity";
import type { Account, AuthResponse, MeResponse, NameStatusResponse } from "./protocol";

export const SESSION_STORAGE_KEY = "cr-gaym:account";

export type StoredSession = { token: string; account: Account };

/**
 * The saved session.
 *
 * Read in an effect after mount, never during render — `localStorage` during
 * render is a hydration mismatch, and this project has the same rule for the
 * mute preference and the display name.
 */
export function loadSession(): StoredSession | null {
  try {
    const raw = window.localStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (typeof parsed?.token !== "string" || typeof parsed?.account?.id !== "string") return null;
    return { token: parsed.token, account: parsed.account as Account };
  } catch {
    return null;
  }
}

export function saveSession(session: StoredSession | null) {
  try {
    if (session) window.localStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
    else window.localStorage.removeItem(SESSION_STORAGE_KEY);
  } catch {
    // Private browsing. The session lasts the tab, which is better than refusing
    // to sign in at all.
  }
}

async function post(path: string, body: unknown): Promise<AuthResponse> {
  try {
    const response = await fetch(`${workerOrigin()}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body)
    });
    return (await response.json()) as AuthResponse;
  } catch {
    return {
      ok: false,
      code: "server_error",
      message: "Could not reach the account server. Check your connection."
    };
  }
}

/**
 * Register or sign in.
 *
 * Both take the same road: validate locally so an obviously bad name never costs
 * a round trip, derive the key, then post it. The two differ only in the route.
 */
async function submit(route: "register" | "login", name: string, password: string): Promise<AuthResponse> {
  const checkedName = checkName(name);
  if (!checkedName.ok) return { ok: false, code: "name_invalid", message: checkedName.reason };

  const checkedPassword = checkPassword(password);
  if (!checkedPassword.ok) {
    return { ok: false, code: "bad_request", message: checkedPassword.reason };
  }

  const authKey = await deriveAuthKey(checkedName.id, password);
  return post(`/auth/${route}`, { name: name.trim(), authKey });
}

export const register = (name: string, password: string) => submit("register", name, password);
export const login = (name: string, password: string) => submit("login", name, password);

/** Is this name spoken for? Asked by the join screen before a guest wears one. */
export async function nameStatus(name: string): Promise<NameStatusResponse> {
  try {
    const response = await fetch(`${workerOrigin()}/auth/name/${encodeURIComponent(name)}`);
    return (await response.json()) as NameStatusResponse;
  } catch {
    return { ok: false, code: "server_error", message: "Could not reach the account server." };
  }
}

/**
 * Confirm a stored session is still good.
 *
 * A token outlives a lot: the account could have been removed, the server's
 * signing secret could have been rotated, or the month could simply be up. The
 * UI treats a failure here as "signed out" rather than as an error, because from
 * the player's side that is what it is.
 */
export async function fetchMe(token: string): Promise<MeResponse> {
  try {
    const response = await fetch(`${workerOrigin()}/auth/me?token=${encodeURIComponent(token)}`);
    return (await response.json()) as MeResponse;
  } catch {
    return { ok: false, code: "server_error", message: "Could not reach the account server." };
  }
}
