"use client";

import { useState, type FormEvent } from "react";
import { MAX_NAME_LENGTH, MIN_PASSWORD_LENGTH } from "@/lib/auth/identity";
import type { UseAccount } from "@/lib/auth/use-account";
import styles from "./account-panel.module.css";

type AccountPanelProps = {
  account: UseAccount;
  /**
   * Called with the registered name when a sign-in succeeds, so the join screen
   * can put it in the name field — the account name is the one that will be used
   * in a room anyway, and leaving a stale guest name there is confusing.
   */
  onSignedIn?: (name: string) => void;
};

/**
 * Sign in, or register a name.
 *
 * Signing in is optional and the panel says so. The only thing an account
 * changes is that a registered name cannot be worn by anybody else — there is no
 * feature behind this gate, and guests are not second-class.
 *
 * One form for both actions rather than two screens: registering and signing in
 * take exactly the same two fields, and a player who typed their details into
 * the wrong one would otherwise have to type them again.
 */
export function AccountPanel({ account, onSignedIn }: AccountPanelProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [mode, setMode] = useState<"login" | "register">("login");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setIsOpen(false);
    setMode("login");
    setName("");
    setPassword("");
    setError(null);
  };

  // Nothing at all while the stored session is being read. A "checking…" box
  // would be a panel that flashes up and vanishes for the majority of visitors
  // who are not signed in, which is worse than a beat of nothing.
  if (account.status === "loading") return null;

  if (account.status === "signed-in" && account.account) {
    // Signing out puts the form back the way somebody arriving would find it.
    // The component is not unmounted in between, so without this the panel
    // reappears in whatever mode it was left in, with the old name still in it.
    const signOut = () => {
      account.signOut();
      close();
    };

    return (
      <div className={styles.chip} data-testid="account-chip">
        <span className={styles.dot} />
        <span className={styles.who}>
          <span className={styles.name}>{account.account.name}</span>
          <span className={styles.since}>Registered</span>
        </span>
        <button className="ghost-link button-reset" type="button" onClick={signOut}>
          Sign out
        </button>
      </div>
    );
  }

  // Collapsed until asked for. Signing in is optional, and a form nobody
  // requested should not be spending a card's worth of the page on the chance
  // that they might.
  if (!isOpen) {
    return (
      <div className={styles.trigger}>
        <button
          className={`button-reset ${styles.triggerButton}`}
          type="button"
          data-testid="account-open"
          onClick={() => setIsOpen(true)}
        >
          Sign in or register
        </button>
        <span className={styles.triggerHint}>optional — guests play the same</span>
      </div>
    );
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    const action = mode === "login" ? account.signIn : account.register;
    const failure = await action(name, password);
    if (failure) {
      setError(failure);
      return;
    }

    setPassword("");
    onSignedIn?.(name.trim());
  };

  return (
    <form className={styles.panel} onSubmit={submit} data-testid="account-panel">
      <div className={styles.header}>
        <h2 className={styles.title}>{mode === "login" ? "Sign in" : "Register a name"}</h2>
        <div className={styles.headerActions}>
          <button
            className={`button-reset ${styles.switch}`}
            type="button"
            onClick={() => {
              setMode(mode === "login" ? "register" : "login");
              setError(null);
            }}
          >
            {mode === "login" ? "Register instead" : "I have an account"}
          </button>
          <button
            className={`button-reset ${styles.close}`}
            type="button"
            aria-label="Close sign in"
            onClick={close}
          >
            &times;
          </button>
        </div>
      </div>

      <p className={styles.hint}>
        {mode === "login"
          ? "Optional. Playing as a guest works the same — an account just means nobody else can use your name."
          : "A name and a password, nothing else. There is no email on file, so there is no password reset: keep it somewhere safe."}
      </p>

      <div className={styles.fields}>
        <label className={styles.field}>
          <span className={styles.label}>Name</span>
          <input
            className={styles.control}
            value={name}
            maxLength={MAX_NAME_LENGTH}
            autoComplete="username"
            placeholder="Player"
            onChange={(event) => setName(event.target.value)}
          />
        </label>

        <label className={styles.field}>
          <span className={styles.label}>Password</span>
          <input
            className={styles.control}
            type="password"
            value={password}
            minLength={MIN_PASSWORD_LENGTH}
            autoComplete={mode === "login" ? "current-password" : "new-password"}
            placeholder="••••••"
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
      </div>

      {error ? (
        <p className={styles.error} role="alert" data-testid="account-error">
          {error}
        </p>
      ) : null}

      {/* Ghost rather than primary. Signing in is optional and Create Room is
          what this page is for, so the account panel must not be the loudest
          thing on it. */}
      <button className={`ghost-link button-reset ${styles.submit}`} type="submit" disabled={account.isBusy}>
        {account.isBusy
          ? "Working…"
          : mode === "login"
            ? "Sign in"
            : "Register"}
      </button>
    </form>
  );
}
