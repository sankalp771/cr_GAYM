/**
 * Player preferences that survive a reload.
 *
 * Outside `lib/engine/` because it touches `localStorage`, and the engine is
 * pure. Every read is guarded: private browsing and blocked storage both throw
 * on access, and a settings menu is not worth failing a render over.
 *
 * Note the mute preference deliberately lives in `lib/sound.ts` instead — it is
 * not just a stored value, it drives the audio graph's gain node.
 */

import { isAiDifficulty, type AiDifficulty } from "@/lib/engine";

const DIFFICULTY_KEY = "cr-gaym:ai-difficulty";

export const DEFAULT_DIFFICULTY: AiDifficulty = "normal";

/**
 * Safe to call during render only if the result is not used to produce markup —
 * see the note in `local-arena.tsx`. Reading storage while rendering and using
 * it in the output is a hydration mismatch, so callers read it in an effect.
 */
export function loadDifficulty(): AiDifficulty {
  if (typeof window === "undefined") return DEFAULT_DIFFICULTY;
  try {
    const stored = window.localStorage.getItem(DIFFICULTY_KEY);
    return isAiDifficulty(stored) ? stored : DEFAULT_DIFFICULTY;
  } catch {
    return DEFAULT_DIFFICULTY;
  }
}

export function saveDifficulty(difficulty: AiDifficulty) {
  try {
    window.localStorage.setItem(DIFFICULTY_KEY, difficulty);
  } catch {
    // The choice just will not persist. Not worth failing a click over.
  }
}
