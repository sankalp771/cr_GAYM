"use client";

import { useEffect, useId, useRef, useState } from "react";
import { AI_DIFFICULTIES, type AiDifficulty } from "@/lib/engine";

type SettingsMenuProps = {
  isMuted: boolean;
  onToggleMute: () => void;
  difficulty: AiDifficulty;
  onDifficultyChange: (difficulty: AiDifficulty) => void;
};

const DIFFICULTY_COPY: Record<AiDifficulty, { label: string; hint: string }> = {
  easy: { label: "Easy", hint: "Plays at random. A gentle introduction." },
  normal: { label: "Normal", hint: "Plays well, but makes mistakes." },
  hard: { label: "Hard", hint: "Always takes its best move." }
};

/**
 * Settings popover: sound and computer difficulty.
 *
 * These were heading for separate header buttons, which is how a header ends up
 * with five controls and no room for the board. One gear, one panel.
 */
export function SettingsMenu({ isMuted, onToggleMute, difficulty, onDifficultyChange }: SettingsMenuProps) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelId = useId();
  const difficultyName = useId();

  // Close on outside click and on Escape. Escape also returns focus to the
  // trigger, otherwise a keyboard user is left with focus on a removed node.
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
    <div className="settings-menu" ref={containerRef}>
      <button
        ref={buttonRef}
        type="button"
        className="ghost-link button-reset settings-trigger"
        aria-haspopup="dialog"
        aria-expanded={isOpen}
        aria-controls={panelId}
        aria-label="Settings"
        onClick={() => setIsOpen((open) => !open)}
      >
        <span aria-hidden="true">⚙</span>
        <span className="settings-trigger-label">Settings</span>
      </button>

      {isOpen ? (
        <div className="settings-panel" id={panelId} role="dialog" aria-label="Settings">
          <fieldset className="settings-group">
            <legend>Computer difficulty</legend>
            {AI_DIFFICULTIES.map((level) => (
              <label key={level} className="settings-option">
                <input
                  type="radio"
                  name={difficultyName}
                  value={level}
                  checked={difficulty === level}
                  onChange={() => onDifficultyChange(level)}
                />
                <span>
                  <strong>{DIFFICULTY_COPY[level].label}</strong>
                  <em>{DIFFICULTY_COPY[level].hint}</em>
                </span>
              </label>
            ))}
            <p className="settings-note">Applies from the computer&apos;s next move.</p>
          </fieldset>

          <fieldset className="settings-group">
            <legend>Sound</legend>
            <label className="settings-option settings-switch">
              <input type="checkbox" checked={!isMuted} onChange={onToggleMute} />
              <span>
                <strong>Sound effects</strong>
                <em>{isMuted ? "Currently muted." : "Placement, explosions and victory."}</em>
              </span>
            </label>
          </fieldset>
        </div>
      ) : null}
    </div>
  );
}
