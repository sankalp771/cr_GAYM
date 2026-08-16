"use client";

import { useState } from "react";
import { downloadReplay, type MatchRecord } from "@/lib/replay";
import styles from "./replay-actions.module.css";

type ReplayActionsProps = {
  /** Null while a match has no complete record — the buttons then do not appear at all. */
  record: MatchRecord | null;
  onWatch: () => void;
};

/**
 * The two things offered when a match ends: watch it back, or keep it.
 *
 * A fragment rather than a container, so it drops straight into the winner
 * modal's action row and into the side panel without either needing to know the
 * other exists.
 */
export function ReplayActions({ record, onWatch }: ReplayActionsProps) {
  const [savedAs, setSavedAs] = useState<string | null>(null);

  if (!record) return null;

  return (
    <>
      <button className="ghost-link button-reset" type="button" onClick={onWatch}>
        Watch replay
      </button>
      <button
        className="ghost-link button-reset"
        type="button"
        title={savedAs ?? "Save this match as a self-contained HTML file"}
        onClick={() => setSavedAs(downloadReplay(record))}
      >
        {savedAs ? "Saved" : "Download .html"}
      </button>
    </>
  );
}

/**
 * The same offer as a side panel.
 *
 * The modal can be dismissed, and without this the only two things a player can
 * do with a finished match would go with it.
 */
export function ReplayActionsCard(props: ReplayActionsProps) {
  if (!props.record) return null;

  return (
    <section className={styles.card} data-testid="replay-offer">
      <h2 className={styles.title}>This match</h2>
      <div className={styles.row}>
        <ReplayActions {...props} />
      </div>
    </section>
  );
}
