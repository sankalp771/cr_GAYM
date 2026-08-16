/**
 * Handing the finished file to the player.
 *
 * The browser half of the replay feature, kept apart from the rest of
 * `lib/replay/` so everything else stays testable in plain Node — the exporter
 * and the record are pure, and only this file touches `Blob`, `document` and the
 * clock.
 */

import { buildReplayHtml } from "./export-html";
import { expandRecord, type MatchRecord } from "./record";

const pad = (value: number) => String(value).padStart(2, "0");

/** `chain-reaction-local-2026-08-16-1402.html` — sortable, and obvious in a downloads folder. */
export function replayFileName(record: MatchRecord, at: Date = new Date()): string {
  const stamp = [
    at.getFullYear(),
    "-",
    pad(at.getMonth() + 1),
    "-",
    pad(at.getDate()),
    "-",
    pad(at.getHours()),
    pad(at.getMinutes())
  ].join("");

  return `chain-reaction-${record.mode}-${stamp}.html`;
}

/**
 * Build the replay and save it.
 *
 * Returns the file name so a caller can say what it wrote. Throws nothing the
 * caller has to handle: an expansion failure would already have shown up when
 * the in-app viewer opened the same record.
 */
export function downloadReplay(record: MatchRecord, at: Date = new Date()): string {
  const html = buildReplayHtml(record, expandRecord(record));
  const fileName = replayFileName(record, at);

  const url = URL.createObjectURL(new Blob([html], { type: "text/html;charset=utf-8" }));
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.rel = "noopener";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();

  // Revoking in the same tick cancels the download in some browsers, so the
  // object URL is left alive long enough for the save to start.
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);

  return fileName;
}
