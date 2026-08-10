/**
 * Position evaluation weights, shared by the one-ply heuristic in `ai.ts` and
 * the depth search in `search.ts`.
 *
 * They live in their own module so the two cannot drift apart. Depth and
 * evaluation are deliberately separable: if both changed at once, a shift in
 * playing strength could not be attributed to either.
 *
 * The units are "orbs", so each weight says how many orbs of material that
 * consideration is worth. They are ordered by how decisive they are:
 *
 * - `WIN_SCORE` dominates everything, so a move that ends the match is always
 *   taken. Nothing else can add up to it.
 * - `MATERIAL_WEIGHT` is the main signal. Every move adds exactly one orb to
 *   the mover, and a capture also flips the victim's orbs, so capturing `k`
 *   orbs swings the balance by `1 + 2k` — a single-orb capture already scores
 *   12 here, comfortably above any positional term. That is what makes "reach
 *   critical mass next to a loaded enemy cell" the strongly preferred move
 *   without needing a special case for it: the capture shows up as material.
 * - `RISK_WEIGHT` outweighs `THREAT_WEIGHT` because the opponent moves next.
 *   Orbs parked beside an enemy cell that is one orb from exploding are orbs
 *   you are about to hand over; the mirror image is only a maybe.
 * - `POSITION_WEIGHT` is the tie-breaker. A corner needs 2 orbs to hold and an
 *   interior cell needs 4, so corners and edges are cheaper to keep and dearer
 *   to take. It is worth a few tenths of an orb, never enough to pass up a
 *   capture for.
 */

export const WIN_SCORE = 1_000_000;
export const MATERIAL_WEIGHT = 6;
export const RISK_WEIGHT = 3;
export const THREAT_WEIGHT = 1;
export const POSITION_WEIGHT = 1.5;

/** Scores this close together count as equal, and the injected rng breaks the tie. */
export const SCORE_EPSILON = 1e-9;
