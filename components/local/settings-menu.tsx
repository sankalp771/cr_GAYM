"use client";

import { useEffect, useId, useRef, useState } from "react";
import { AI_DIFFICULTIES, type AiDifficulty } from "@/lib/engine";
import styles from "./settings-menu.module.css";

export type SettingsMenuProps = {
  isMuted: boolean;
  onToggleMute: () => void;
  difficulty: AiDifficulty;
  onDifficultyChange: (difficulty: AiDifficulty) => void;
};

const DIFFICULTY_LABEL: Record<AiDifficulty, string> = {
  easy: "Easy",
  normal: "Normal",
  hard: "Hard"
};

/**
 * Settings popover: computer difficulty and sound.
 *
 * One gear rather than a button each — the arena header had already grown wide
 * enough to push the board off screen once.
 */
export function SettingsMenu({
  isMuted,
  onToggleMute,
  difficulty,
  onDifficultyChange,
  compact = false
}: SettingsMenuProps & { compact?: boolean }) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const difficultyName = useId();

  // Close on outside click and on Escape. Escape also returns focus to the
  // trigger, or a keyboard user is left focused on a removed node.
  useEffect(() => {
    if (!isOpen) return;

    function onPointerDown(event: MouseEvent | TouchEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setIsOpen(false);
    }

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return;
      setIsOpen(false);
      buttonRef.current?.focus();
    }

    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("touchstart", onPointerDown);
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("touchstart", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [isOpen]);

  return (
    <div className={styles.menu} ref={containerRef}>
      <button
        ref={buttonRef}
        type="button"
        className={`ghost-link button-reset ${styles.trigger} ${compact ? styles.triggerCompact : ""}`}
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-controls={panelId}
        aria-label="Settings"
        onClick={() => setIsOpen((open) => !open)}
      >
        <span aria-hidden="true">⚙</span>
        <span className={styles.triggerLabel}>Settings</span>
      </button>

      {isOpen ? (
        <div className={styles.panel} id={panelId} role="dialog" aria-label="Settings">
          <fieldset className={styles.group}>
            <legend className={styles.legend}>Computer difficulty</legend>
            {AI_DIFFICULTIES.map((level) => (
              <label key={level} className={styles.option}>
                <input
                  type="radio"
                  name={difficultyName}
                  value={level}
                  checked={difficulty === level}
                  onChange={() => onDifficultyChange(level)}
                />
                <span>{DIFFICULTY_LABEL[level]}</span>
              </label>
            ))}
          </fieldset>

          <fieldset className={styles.group}>
            <legend className={styles.legend}>Sound</legend>
            <label className={styles.option}>
              <input type="checkbox" checked={!isMuted} onChange={onToggleMute} />
              <span>Sound effects</span>
            </label>
          </fieldset>
        </div>
      ) : null}
    </div>
  );
}
