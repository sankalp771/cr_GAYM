/**
 * Public surface of the replay feature.
 *
 * A replay is a move list plus the engine — see `record.ts`. Import from
 * `@/lib/replay` so the seam stays reviewable, the same way `@/lib/engine` does.
 */

export {
  REPLAY_FORMAT_VERSION,
  buildRecord,
  describeBoard,
  expandRecord,
  parseRecord,
  serializeRecord
} from "./record";
export type { MatchRecord, RecordedMove, RecordedPlayer, ReplayMove, ReplayTimeline } from "./record";

export { BETWEEN_MOVES_MS, OPENING_HOLD_MS, flattenTimeline, moveBoundaries } from "./timeline";
export type { ReplayFrame } from "./timeline";

export { buildReplayHtml, buildReplayPayload, decodeBoardString } from "./export-html";
export type { ReplayPayload } from "./export-html";

export { downloadReplay, replayFileName } from "./download";
