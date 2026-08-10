"use client";

import Link from "next/link";
import { BOARD_PRESETS, PLAYER_COLORS, type PresetId } from "@/lib/engine";
import { SettingsMenu, type SettingsMenuProps } from "@/components/local/settings-menu";
import styles from "./setup-screen.module.css";

/** Who is behind a seat. */
export type SeatKind = "human" | "computer";

type SetupScreenProps = SettingsMenuProps & {
  presetId: PresetId;
  onPresetChange: (presetId: PresetId) => void;
  playerCount: number;
  onPlayerCountChange: (count: number) => void;
  playerNames: string[];
  onPlayerNameChange: (index: number, name: string) => void;
  seatKinds: SeatKind[];
  onSeatKindChange: (index: number, kind: SeatKind) => void;
  onStart: () => void;
  onReset: () => void;
};

/**
 * Everything you configure before a match, on its own screen.
 *
 * Setup used to sit in a column beside the board, which meant eight seats of
 * name fields competed for height with the thing you actually look at. Split
 * apart, each screen gets the whole viewport for one job.
 */
export function SetupScreen({
  presetId,
  onPresetChange,
  playerCount,
  onPlayerCountChange,
  playerNames,
  onPlayerNameChange,
  seatKinds,
  onSeatKindChange,
  onStart,
  onReset,
  ...settings
}: SetupScreenProps) {
  const preset = BOARD_PRESETS[presetId];

  return (
    <main className={styles.screen}>
      <header className={styles.header}>
        <div>
          <h1 className={styles.title}>Local Arena</h1>
          <p className={styles.subtitle}>
            Set up the board and the seats, then start the match.
          </p>
        </div>

        <div className={styles.headerActions}>
          <Link href="/" className="ghost-link">
            Back Home
          </Link>
          <SettingsMenu {...settings} />
        </div>
      </header>

      <section className={styles.panel}>
        <div className={styles.panelTitleRow}>
          <h2 className={styles.panelTitle}>Battle Setup</h2>
          <span className={styles.badge}>
            {preset.label} {preset.size}x{preset.size}
          </span>
        </div>

        <div className={styles.topRow}>
          <label className={styles.field}>
            <span className={styles.fieldLabel}>Board Preset</span>
            <select
              className={styles.control}
              value={presetId}
              onChange={(event) => onPresetChange(event.target.value as PresetId)}
            >
              {Object.values(BOARD_PRESETS).map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label} ({option.size})
                </option>
              ))}
            </select>
          </label>

          <label className={styles.field}>
            <span className={styles.fieldLabel}>Players</span>
            <select
              className={styles.control}
              value={playerCount}
              onChange={(event) => onPlayerCountChange(Number(event.target.value))}
            >
              {Array.from({ length: 7 }, (_, index) => index + 2).map((count) => (
                <option key={count} value={count}>
                  {count} Players
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className={styles.seats}>
          {playerNames.slice(0, playerCount).map((name, index) => (
            // A div rather than a label: the seat owns two controls, and a label
            // wrapping both would name only the first. Each carries its own.
            <div key={`seat-${index + 1}`} className={styles.seat}>
              <span className={styles.seatLabel}>
                <span
                  className={styles.seatDot}
                  style={{ ["--player-color" as string]: PLAYER_COLORS[index] }}
                />
                Player {index + 1}
              </span>

              <div className={styles.seatControls}>
                <input
                  className={styles.control}
                  aria-label={`Player ${index + 1} name`}
                  value={name}
                  onChange={(event) => onPlayerNameChange(index, event.target.value)}
                />
                <select
                  className={styles.control}
                  aria-label={`Player ${index + 1} control`}
                  value={seatKinds[index] ?? "computer"}
                  onChange={(event) => onSeatKindChange(index, event.target.value as SeatKind)}
                >
                  <option value="human">Human</option>
                  <option value="computer">Computer</option>
                </select>
              </div>
            </div>
          ))}
        </div>

        <div className={styles.actions}>
          <button className="primary-link button-reset" type="button" onClick={onStart}>
            Start Battle
          </button>
          <button className="ghost-link button-reset" type="button" onClick={onReset}>
            Reset
          </button>
        </div>
      </section>
    </main>
  );
}
