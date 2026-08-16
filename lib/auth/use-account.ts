"use client";

import { useCallback, useEffect, useState } from "react";
import {
  fetchMe,
  loadSession,
  login as loginRequest,
  register as registerRequest,
  saveSession
} from "./client";
import type { Account } from "./protocol";

export type AccountStatus = "loading" | "signed-in" | "signed-out";

export type UseAccount = {
  status: AccountStatus;
  account: Account | null;
  /** Passed to the room server on connect. Null when playing as a guest. */
  token: string | null;
  /** True while a register or login request is in flight. */
  isBusy: boolean;
  register: (name: string, password: string) => Promise<string | null>;
  signIn: (name: string, password: string) => Promise<string | null>;
  signOut: () => void;
};

/**
 * Who you are, if anybody.
 *
 * Signing in is optional everywhere — this returns `signed-out` and the game
 * plays exactly as it did before. The only thing an account buys is that nobody
 * else can wear your name, which is the whole of Showdown's model and the whole
 * of this one.
 *
 * The stored session is read after mount rather than during render, because
 * reading `localStorage` while rendering is a hydration mismatch — the same rule
 * the mute preference and the saved display name already follow.
 */
export function useAccount(): UseAccount {
  const [status, setStatus] = useState<AccountStatus>("loading");
  const [account, setAccount] = useState<Account | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);

  useEffect(() => {
    const stored = loadSession();
    if (!stored) {
      setStatus("signed-out");
      return;
    }

    // Shown as signed in immediately and confirmed in the background: the token
    // is signed and has an expiry, so trusting it for one paint is safe, and
    // making every visit wait on a network round trip to see its own name is not
    // worth the certainty.
    setAccount(stored.account);
    setToken(stored.token);
    setStatus("signed-in");

    let cancelled = false;
    void fetchMe(stored.token).then((response) => {
      if (cancelled) return;
      if (response.ok) {
        setAccount(response.account);
        saveSession({ token: stored.token, account: response.account });
        return;
      }
      // Only a definite rejection signs you out. A server that could not be
      // reached leaves the session alone, or a flaky connection would log
      // everybody out on the way to a game they can still play.
      if (response.code === "server_error") return;
      saveSession(null);
      setAccount(null);
      setToken(null);
      setStatus("signed-out");
    });

    return () => {
      cancelled = true;
    };
  }, []);

  const run = useCallback(
    async (
      request: (name: string, password: string) => ReturnType<typeof loginRequest>,
      name: string,
      password: string
    ): Promise<string | null> => {
      setIsBusy(true);
      try {
        const response = await request(name, password);
        if (!response.ok) return response.message;

        saveSession({ token: response.token, account: response.account });
        setAccount(response.account);
        setToken(response.token);
        setStatus("signed-in");
        return null;
      } finally {
        setIsBusy(false);
      }
    },
    []
  );

  const register = useCallback(
    (name: string, password: string) => run(registerRequest, name, password),
    [run]
  );

  const signIn = useCallback((name: string, password: string) => run(loginRequest, name, password), [run]);

  const signOut = useCallback(() => {
    saveSession(null);
    setAccount(null);
    setToken(null);
    setStatus("signed-out");
  }, []);

  return { status, account, token, isBusy, register, signIn, signOut };
}
