/**
 * A finished match, written out as one self-contained HTML file.
 *
 * The file has to work from a `file://` URL on a laptop with no network, years
 * from now, so it carries everything: no stylesheet link, no script src, no
 * font request, no image. Everything below is inlined into a single document.
 *
 * What it carries is **frames, not rules**. The board states are produced here
 * by `lib/engine` and serialised; the viewer inside the file only decodes and
 * draws them. That is deliberate — the alternative, shipping a second copy of
 * the cascade rules inside every download, is a rules fork that ages badly and
 * that no test could reach once the file has left the building. The cost is file
 * size, and it is small: two characters per cell per frame, which is a few
 * hundred kilobytes for the longest match this game can produce.
 *
 * The `<script>` the file contains is authored as plain ES5-ish JavaScript with
 * no template literals, because it is being embedded in one.
 */

import { criticalMass, type Board, type GridConfig } from "@/lib/engine";
import { describeBoard, type MatchRecord, type ReplayTimeline } from "./record";
import { flattenTimeline, moveBoundaries, type ReplayFrame } from "./timeline";

/** Guard on what goes into a `--player-color`, since it lands in a style attribute. */
const HEX_COLOR = /^#[0-9a-fA-F]{3,8}$/;

const FALLBACK_COLOR = "#8ef9ff";

function safeColor(value: string): string {
  return HEX_COLOR.test(value) ? value : FALLBACK_COLOR;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * One cell, two characters: owner then orb count, both base 36, `-` for an empty
 * cell. Fixed width means the decoder is an index calculation rather than a
 * parser, which is most of why the viewer inside the file is as short as it is.
 */
function encodeBoard(board: Board, ownerIndex: Map<string, number>): string {
  let out = "";
  for (const row of board) {
    for (const cell of row) {
      const owner = cell.ownerId === null ? -1 : ownerIndex.get(cell.ownerId) ?? -1;
      out += owner < 0 ? "-" : owner.toString(36);
      out += Math.min(cell.count, 35).toString(36);
    }
  }
  return out;
}

/** Reads a board string back. Exported so a test can check the encoding round-trips. */
export function decodeBoardString(
  encoded: string,
  config: GridConfig
): Array<{ row: number; col: number; owner: number; count: number }> {
  const cells: Array<{ row: number; col: number; owner: number; count: number }> = [];
  for (let index = 0; index < config.rows * config.cols; index += 1) {
    const ownerChar = encoded.charAt(index * 2);
    cells.push({
      row: Math.floor(index / config.cols),
      col: index % config.cols,
      owner: ownerChar === "-" ? -1 : parseInt(ownerChar, 36),
      count: parseInt(encoded.charAt(index * 2 + 1), 36)
    });
  }
  return cells;
}

function cellIndices(keys: ReadonlySet<string>, cols: number): number[] {
  const indices: number[] = [];
  for (const key of keys) {
    const [row, col] = key.split(",").map(Number);
    indices.push(row * cols + col);
  }
  return indices.sort((a, b) => a - b);
}

type ExportedFrame = {
  /** Encoded board. */
  b: string;
  /** Cells that changed on this frame — they replay the orb materialise animation. */
  f: number[];
  /** Cells exploding on this frame. */
  x: number[];
  /** 1-based move number; 0 is the opening board. */
  m: number;
  /** How long to hold this frame at 1x, in milliseconds. */
  d: number;
  /** Player index to move, or -1 once the match is decided. */
  t: number;
  /** 1 once the match is over — the scoreboard freezes on the final tally. */
  s: 0 | 1;
};

export type ReplayPayload = {
  v: number;
  rows: number;
  cols: number;
  players: Array<{ n: string; c: string; b?: string }>;
  winner: number | null;
  mode: "local" | "online";
  room?: string;
  recordedAt: number | null;
  /** Orbs per player on the last real board, so the finale does not zero the scoreboard. */
  finalTally: number[];
  moves: Array<{ p: number; r: number; c: number; a: boolean; end: number }>;
  frames: ExportedFrame[];
  /** The move list itself, so the file remains the record and not only a rendering of it. */
  record: MatchRecord;
};

export function buildReplayPayload(record: MatchRecord, timeline: ReplayTimeline): ReplayPayload {
  const ownerIndex = new Map(record.players.map((player, index) => [player.id, index]));
  const { cols } = record.config;
  const frames = flattenTimeline(timeline);

  const exported: ExportedFrame[] = frames.map((frame: ReplayFrame) => ({
    b: encodeBoard(frame.board, ownerIndex),
    f: cellIndices(frame.flash, cols),
    x: cellIndices(frame.burst, cols),
    m: frame.moveNumber,
    d: Math.round(frame.durationMs),
    t:
      frame.state.status === "playing"
        ? ownerIndex.get(frame.state.players[frame.state.currentPlayerIndex]?.id ?? "") ?? -1
        : -1,
    s: frame.state.status === "finished" ? 1 : 0
  }));

  // Where each move's settled board sits, so "next move" is one jump rather
  // than several hundred clicks through a cascade. The finale is skipped: its
  // frames carry the last move's number, and counting them would move that
  // move's marker onto the emptied board — see `moveBoundaries`.
  const ends = moveBoundaries(frames);

  const finalTally = record.players.map((player) => {
    let total = 0;
    for (const row of timeline.final.board) {
      for (const cell of row) if (cell.ownerId === player.id) total += cell.count;
    }
    return total;
  });

  return {
    v: record.version,
    rows: record.config.rows,
    cols: record.config.cols,
    players: record.players.map((player) => ({
      n: player.name,
      c: safeColor(player.color),
      ...(player.badge ? { b: player.badge } : {})
    })),
    winner: record.winnerId ? ownerIndex.get(record.winnerId) ?? null : null,
    mode: record.mode,
    ...(record.roomCode ? { room: record.roomCode } : {}),
    recordedAt: record.recordedAt,
    finalTally,
    moves: timeline.moves.map((move) => ({
      p: ownerIndex.get(move.playerId) ?? 0,
      r: move.row,
      c: move.col,
      a: move.auto,
      end: ends[move.number] ?? 0
    })),
    frames: exported,
    record
  };
}

/**
 * Critical mass per cell, precomputed for the viewer.
 *
 * The one number the exported file needs that is not a board state. It drives
 * the "one orb from exploding" pulse, which is what makes the position readable
 * — and it is geometry rather than a rule that can change out from under a saved
 * file, so baking it in is safe.
 */
function criticalMassTable(config: GridConfig): string {
  let out = "";
  for (let row = 0; row < config.rows; row += 1) {
    for (let col = 0; col < config.cols; col += 1) out += criticalMass(row, col, config).toString(36);
  }
  return out;
}

const VIEWER_STYLE = `
:root {
  --bg: #04060f;
  --text: #eff6ff;
  --muted: #9fb5d6;
  --accent: #8ef9ff;
  --panel: rgba(255, 255, 255, 0.03);
  --panel-border: rgba(255, 255, 255, 0.08);
}
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; }
body {
  background: #000;
  color: var(--text);
  font-family: "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
  display: flex;
  flex-direction: column;
  min-height: 100dvh;
}
.wrap {
  width: min(1100px, 100%);
  margin: 0 auto;
  padding: 0.9rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  flex: 1;
  min-height: 0;
}
header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 0.4rem 0.9rem; }
h1 { margin: 0; font-size: 1.15rem; letter-spacing: 0.01em; }
.meta { color: var(--muted); font-size: 0.82rem; }
/* The right column is sized so the five transport buttons stay on one row —
   below about 250px the last one wraps and the controls read as broken. */
.layout { display: grid; grid-template-columns: minmax(0, 1fr) minmax(250px, 280px); gap: 0.75rem; min-height: 0; flex: 1; align-items: center; }
.board-area { min-width: 0; display: grid; place-items: center; }
.board {
  width: min(100%, 70dvh);
  aspect-ratio: 1 / 1;
  display: grid;
  gap: 2px;
  padding: 0.35rem;
  border-radius: 20px;
  background: #04070f;
  box-shadow: inset 0 0 0 1px rgba(120, 170, 255, 0.14), 0 0 60px rgba(0, 0, 0, 0.6);
}
.cell {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  border: 1px solid rgba(96, 149, 255, 0.18);
  background: #060a14;
  overflow: hidden;
}
.cell.critical { animation: pulse 900ms ease-in-out infinite; }
@keyframes pulse {
  0%, 100% { box-shadow: inset 0 0 12px color-mix(in srgb, var(--player-color) 25%, transparent); }
  50% { box-shadow: inset 0 0 24px color-mix(in srgb, var(--player-color) 55%, transparent); }
}
.cell.bursting { overflow: visible; z-index: 2; }
.stack { position: relative; width: 84%; height: 84%; display: grid; place-items: center; }
.orb {
  position: absolute;
  width: 36%;
  height: 36%;
  border-radius: 50%;
  background: radial-gradient(circle at 36% 32%, rgba(255,255,255,0.95), var(--player-color) 32%, color-mix(in srgb, var(--player-color) 40%, black) 80%);
  box-shadow: 0 0 18px color-mix(in srgb, var(--player-color) 80%, transparent);
  animation: materialize 240ms cubic-bezier(0.2, 0.8, 0.2, 1);
}
@keyframes materialize { from { opacity: 0; scale: 0.3; } to { opacity: 1; scale: 1; } }
.c2 .orb:nth-child(1) { transform: translateX(-32%); }
.c2 .orb:nth-child(2) { transform: translateX(32%); }
.c3 .orb:nth-child(1) { transform: translate(-32%, 24%); }
.c3 .orb:nth-child(2) { transform: translate(32%, 24%); }
.c3 .orb:nth-child(3) { transform: translateY(-30%); }
.c4 .orb:nth-child(1) { transform: translate(-32%, -30%); }
.c4 .orb:nth-child(2) { transform: translate(32%, -30%); }
.c4 .orb:nth-child(3) { transform: translate(-32%, 30%); }
.c4 .orb:nth-child(4) { transform: translate(32%, 30%); }
.burst { position: absolute; inset: 0; pointer-events: none; }
.spark {
  position: absolute;
  top: 50%;
  left: 50%;
  width: 22%;
  height: 22%;
  margin: -11% 0 0 -11%;
  border-radius: 50%;
  background: var(--player-color, var(--accent));
  box-shadow: 0 0 10px var(--player-color, var(--accent));
  opacity: 0;
  animation: fly 400ms cubic-bezier(0.15, 0.75, 0.3, 1) forwards;
}
.spark[data-d="0"] { --bx: 0; --by: -150%; }
.spark[data-d="1"] { --bx: 150%; --by: 0; }
.spark[data-d="2"] { --bx: 0; --by: 150%; }
.spark[data-d="3"] { --bx: -150%; --by: 0; }
@keyframes fly {
  0% { opacity: 1; transform: translate3d(0, 0, 0) scale(0.7); }
  60% { opacity: 0.85; }
  100% { opacity: 0; transform: translate3d(var(--bx, 0), var(--by, 0), 0) scale(0.45); }
}
aside { display: flex; flex-direction: column; gap: 0.6rem; min-width: 0; }
.card { padding: 0.75rem; border-radius: 16px; border: 1px solid var(--panel-border); background: var(--panel); }
.card h2 { margin: 0 0 0.55rem; font-size: 0.74rem; letter-spacing: 0.08em; text-transform: uppercase; color: var(--muted); font-weight: 600; }
.seat {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  padding: 0.45rem 0.55rem;
  border-radius: 12px;
  border: 1px solid transparent;
  background: rgba(255, 255, 255, 0.03);
  margin-bottom: 0.35rem;
}
.seat:last-child { margin-bottom: 0; }
.seat.active { border-color: var(--player-color); box-shadow: 0 0 18px color-mix(in srgb, var(--player-color) 30%, transparent); }
.seat.out { opacity: 0.45; }
.dot { width: 0.85rem; height: 0.85rem; flex: none; border-radius: 50%; background: var(--player-color); box-shadow: 0 0 10px color-mix(in srgb, var(--player-color) 75%, transparent); }
.seat-name { flex: 1; min-width: 0; font-size: 0.9rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tag { padding: 0.1rem 0.4rem; border-radius: 999px; background: rgba(142, 249, 255, 0.12); color: var(--accent); font-size: 0.62rem; letter-spacing: 0.06em; }
.orbs { color: var(--muted); font-size: 0.85rem; font-variant-numeric: tabular-nums; }
.status { margin: 0; color: var(--muted); font-size: 0.85rem; line-height: 1.5; min-height: 2.5em; }
.controls { display: flex; flex-direction: column; gap: 0.55rem; }
.transport { display: flex; align-items: center; justify-content: center; gap: 0.3rem; flex-wrap: wrap; }
button {
  font: inherit;
  color: var(--text);
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid var(--panel-border);
  border-radius: 10px;
  padding: 0.45rem 0.45rem;
  min-height: 2.4rem;
  min-width: 2.3rem;
  cursor: pointer;
  line-height: 1;
}
button:hover { border-color: color-mix(in srgb, var(--accent) 45%, transparent); }
button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
button.play { background: color-mix(in srgb, var(--accent) 16%, transparent); border-color: color-mix(in srgb, var(--accent) 45%, transparent); color: var(--accent); }
input[type="range"] { width: 100%; accent-color: var(--accent); min-height: 2rem; }
input[type="range"]:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
.readout { display: flex; align-items: center; justify-content: space-between; gap: 0.6rem; font-size: 0.8rem; color: var(--muted); font-variant-numeric: tabular-nums; }
select { font: inherit; font-size: 0.8rem; color: var(--text); background: #0a1120; border: 1px solid var(--panel-border); border-radius: 8px; padding: 0.25rem 0.35rem; }
footer { color: var(--muted); font-size: 0.75rem; text-align: center; padding: 0.4rem 0 0.9rem; }
@media (max-width: 860px) {
  .layout { grid-template-columns: minmax(0, 1fr); }
  .board { width: min(100%, 52dvh); }
  aside { flex-direction: column; }
}
@media (prefers-reduced-motion: reduce) {
  .cell.critical, .orb, .spark { animation-duration: 0.01ms !important; animation-iteration-count: 1 !important; }
}
`;

/**
 * The player inside the downloaded file.
 *
 * ES5-flavoured on purpose: no template literals (it is embedded in one), no
 * modules, no build step. It decodes frames and draws them, and holds no
 * knowledge of the game's rules beyond the critical-mass table baked in above.
 */
const VIEWER_SCRIPT = String.raw`
(function () {
  var data = JSON.parse(document.getElementById("replay-data").textContent);
  var rows = data.rows, cols = data.cols, total = rows * cols;
  var mass = data.mass;
  var frames = data.frames;

  var boardEl = document.getElementById("board");
  var seatsEl = document.getElementById("seats");
  var statusEl = document.getElementById("status");
  var scrubEl = document.getElementById("scrub");
  var readoutEl = document.getElementById("readout");
  var playEl = document.getElementById("play");
  var speedEl = document.getElementById("speed");

  boardEl.style.gridTemplateColumns = "repeat(" + cols + ", minmax(0, 1fr))";

  var cellEls = [];
  var rendered = [];
  for (var i = 0; i < total; i++) {
    var cell = document.createElement("div");
    cell.className = "cell";
    boardEl.appendChild(cell);
    cellEls.push(cell);
    rendered.push(null);
  }

  var seatEls = [];
  for (var p = 0; p < data.players.length; p++) {
    var seat = document.createElement("div");
    seat.className = "seat";
    seat.style.setProperty("--player-color", data.players[p].c);

    var dot = document.createElement("span");
    dot.className = "dot";
    var name = document.createElement("span");
    name.className = "seat-name";
    name.textContent = data.players[p].n;
    seat.appendChild(dot);
    seat.appendChild(name);

    if (data.players[p].b) {
      var tag = document.createElement("span");
      tag.className = "tag";
      tag.textContent = data.players[p].b;
      seat.appendChild(tag);
    }

    var orbs = document.createElement("span");
    orbs.className = "orbs";
    seat.appendChild(orbs);
    seatsEl.appendChild(seat);
    seatEls.push({ root: seat, orbs: orbs });
  }

  // The move a seat first played on. A seat with no orbs is only *out* once it
  // has actually taken a turn — before that it is simply waiting, which is the
  // same distinction the engine draws with hasEnteredPlay.
  var entered = [];
  for (var e = 0; e < data.players.length; e++) entered.push(Infinity);
  for (var mv = 0; mv < data.moves.length; mv++) {
    var seatIndex = data.moves[mv].p;
    if (entered[seatIndex] === Infinity) entered[seatIndex] = mv + 1;
  }

  function owned(str, index) {
    var ch = str.charAt(index * 2);
    return ch === "-" ? -1 : parseInt(ch, 36);
  }

  function counted(str, index) {
    return parseInt(str.charAt(index * 2 + 1), 36);
  }

  function paintCell(index, owner, count, bursting) {
    var el = cellEls[index];
    var color = owner >= 0 ? data.players[owner].c : "";
    if (color) el.style.setProperty("--player-color", color);
    else el.style.removeProperty("--player-color");

    var critical = count > 0 && count === parseInt(mass.charAt(index), 36) - 1;
    el.className = "cell" + (critical && owner >= 0 ? " critical" : "") + (bursting ? " bursting" : "");

    while (el.firstChild) el.removeChild(el.firstChild);

    if (bursting) {
      var burst = document.createElement("span");
      burst.className = "burst";
      for (var d = 0; d < 4; d++) {
        var spark = document.createElement("span");
        spark.className = "spark";
        spark.setAttribute("data-d", String(d));
        burst.appendChild(spark);
      }
      el.appendChild(burst);
    }

    if (count > 0 && owner >= 0) {
      var shown = count > 4 ? 4 : count;
      var stack = document.createElement("span");
      stack.className = "stack c" + shown;
      for (var o = 0; o < shown; o++) {
        var orb = document.createElement("span");
        orb.className = "orb";
        stack.appendChild(orb);
      }
      el.appendChild(stack);
    }

    el.setAttribute(
      "aria-label",
      "Row " + (Math.floor(index / cols) + 1) + ", column " + ((index % cols) + 1) + ": " +
        (owner >= 0 && count > 0
          ? count + (count === 1 ? " orb" : " orbs") + " owned by " + data.players[owner].n
          : "empty")
    );
  }

  function describeMove(frame) {
    if (frame.m === 0) return "The opening position.";
    var move = data.moves[frame.m - 1];
    if (!move) return "";
    var who = data.players[move.p].n;
    var where = "row " + (move.r + 1) + ", column " + (move.c + 1);
    if (frame.s === 1 && data.winner !== null) {
      return who + " played " + where + " and took the board.";
    }
    return who + (move.a ? " ran out of time and the arena auto-played " : " played ") + where + ".";
  }

  var index = 0;
  var playing = false;
  var timer = null;
  var speed = 1;

  function render(next) {
    var frame = frames[next];
    var burst = {};
    for (var b = 0; b < frame.x.length; b++) burst[frame.x[b]] = 1;
    var flash = {};
    for (var f = 0; f < frame.f.length; f++) flash[frame.f[f]] = 1;

    for (var i = 0; i < total; i++) {
      var owner = owned(frame.b, i);
      var count = counted(frame.b, i);
      var bursting = burst[i] === 1;
      // Redraw only what changed, plus anything the frame lights up, so the orb
      // and particle animations replay exactly where the game replayed them.
      var key = owner + ":" + count + ":" + (bursting ? 1 : 0) + ":" + (flash[i] === 1 ? 1 : 0);
      if (rendered[i] !== key || bursting || flash[i] === 1) {
        paintCell(i, owner, count, bursting);
        rendered[i] = key;
      }
    }

    var tally = [];
    for (var t = 0; t < data.players.length; t++) tally.push(0);
    if (frame.s === 1) {
      tally = data.finalTally.slice();
    } else {
      for (var c = 0; c < total; c++) {
        var cellOwner = owned(frame.b, c);
        if (cellOwner >= 0) tally[cellOwner] += counted(frame.b, c);
      }
    }

    for (var s = 0; s < seatEls.length; s++) {
      seatEls[s].orbs.textContent = String(tally[s]);
      var out = entered[s] <= frame.m && tally[s] === 0;
      seatEls[s].root.className = "seat" + (frame.t === s ? " active" : "") + (out ? " out" : "");
    }

    statusEl.textContent =
      frame.s === 1 && data.winner !== null
        ? data.players[data.winner].n + " wins."
        : describeMove(frame);

    scrubEl.value = String(next);
    readoutEl.textContent = "Move " + frame.m + " / " + data.moves.length;
  }

  function seek(next) {
    index = next < 0 ? 0 : next >= frames.length ? frames.length - 1 : next;
    render(index);
  }

  function stop() {
    if (timer !== null) { clearTimeout(timer); timer = null; }
    playing = false;
    playEl.textContent = "Play";
    playEl.setAttribute("aria-label", "Play");
  }

  function tick() {
    if (index >= frames.length - 1) { stop(); return; }
    var hold = frames[index].d / speed;
    timer = setTimeout(function () {
      seek(index + 1);
      tick();
    }, hold < 16 ? 16 : hold);
  }

  function play() {
    if (playing) return;
    if (index >= frames.length - 1) seek(0);
    playing = true;
    playEl.textContent = "Pause";
    playEl.setAttribute("aria-label", "Pause");
    tick();
  }

  function toggle() { if (playing) stop(); else play(); }

  function jumpMove(delta) {
    stop();
    var current = frames[index].m;
    var settled = current === 0 ? 0 : data.moves[current - 1].end;
    // Past the last move's settled frame we are in the winner's flourish. Back
    // from there rewinds to that settled board; forward runs out the flourish.
    if (index > settled) {
      if (delta > 0) { seek(frames.length - 1); return; }
      seek(settled);
      return;
    }

    var target = current + delta;
    if (target < 0) target = 0;
    if (target > data.moves.length) { seek(frames.length - 1); return; }
    seek(target === 0 ? 0 : data.moves[target - 1].end);
  }

  playEl.addEventListener("click", toggle);
  document.getElementById("restart").addEventListener("click", function () { stop(); seek(0); });
  document.getElementById("prev").addEventListener("click", function () { jumpMove(-1); });
  document.getElementById("next").addEventListener("click", function () { jumpMove(1); });
  document.getElementById("end").addEventListener("click", function () { stop(); seek(frames.length - 1); });
  scrubEl.addEventListener("input", function () { stop(); seek(Number(scrubEl.value)); });
  speedEl.addEventListener("change", function () { speed = Number(speedEl.value) || 1; });

  document.addEventListener("keydown", function (event) {
    if (event.target && /^(INPUT|SELECT|TEXTAREA)$/.test(event.target.tagName)) return;
    if (event.key === " ") { event.preventDefault(); toggle(); }
    else if (event.key === "ArrowRight") { event.preventDefault(); if (event.shiftKey) jumpMove(1); else { stop(); seek(index + 1); } }
    else if (event.key === "ArrowLeft") { event.preventDefault(); if (event.shiftKey) jumpMove(-1); else { stop(); seek(index - 1); } }
    else if (event.key === "Home") { stop(); seek(0); }
    else if (event.key === "End") { stop(); seek(frames.length - 1); }
  });

  scrubEl.max = String(frames.length - 1);

  var stamp = document.getElementById("played-at");
  if (stamp && data.recordedAt) {
    // Formatted here rather than at export time, so the file reads in the
    // locale of whoever opens it.
    try { stamp.textContent = " · " + new Date(data.recordedAt).toLocaleString(); }
    catch (error) { stamp.textContent = ""; }
  }

  seek(0);

  // The file's whole public surface. It exists so the exporter's test can drive
  // this player rather than assert on the markup that produced it.
  window.chainReactionReplay = {
    seek: seek,
    play: play,
    pause: stop,
    frameCount: frames.length,
    currentIndex: function () { return index; },
    data: data
  };
})();
`;

export type ReplayHtmlOptions = {
  /** Shown under the title. Defaults to a description of the board and mode. */
  subtitle?: string;
};

export function buildReplayHtml(
  record: MatchRecord,
  timeline: ReplayTimeline,
  options: ReplayHtmlOptions = {}
): string {
  const payload = buildReplayPayload(record, timeline);
  const withTable = { ...payload, mass: criticalMassTable(record.config) };

  // Escaping `<` is what makes a `</script>` inside a player's name inert, and
  // the two line separators are valid JSON but not valid JavaScript source.
  const json = JSON.stringify(withTable)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");

  const names = record.players.map((player) => player.name);
  const winner = record.players.find((player) => player.id === record.winnerId) ?? null;
  const title = `Chain Reaction replay — ${names.join(" vs ")}`;
  const subtitle =
    options.subtitle ??
    [
      record.mode === "online" ? "Online match" : "Local match",
      describeBoard(record.config),
      `${record.moves.length} ${record.moves.length === 1 ? "move" : "moves"}`,
      winner ? `${winner.name} won` : "unfinished",
      record.roomCode ? `room ${record.roomCode}` : null
    ]
      .filter(Boolean)
      .join(" · ");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="generator" content="Chain Reaction replay v${payload.v}">
<title>${escapeHtml(title)}</title>
<style>${VIEWER_STYLE}</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>${escapeHtml(title)}</h1>
    <p class="meta">${escapeHtml(subtitle)}<span id="played-at" class="meta"></span></p>
  </header>

  <div class="layout">
    <div class="board-area">
      <div class="board" id="board" role="img" aria-label="Chain Reaction board"></div>
    </div>

    <aside>
      <section class="card controls">
        <h2>Replay</h2>
        <div class="transport">
          <button id="restart" type="button" aria-label="Back to the start" title="Back to the start">&#9198;</button>
          <button id="prev" type="button" aria-label="Previous move" title="Previous move">&#9664;</button>
          <button id="play" class="play" type="button" aria-label="Play">Play</button>
          <button id="next" type="button" aria-label="Next move" title="Next move">&#9654;</button>
          <button id="end" type="button" aria-label="Jump to the end" title="Jump to the end">&#9197;</button>
        </div>
        <input id="scrub" type="range" min="0" max="0" step="1" value="0" aria-label="Replay position">
        <div class="readout">
          <span id="readout">Move 0 / 0</span>
          <label>Speed
            <select id="speed" aria-label="Playback speed">
              <option value="0.5">0.5x</option>
              <option value="1" selected>1x</option>
              <option value="2">2x</option>
              <option value="4">4x</option>
            </select>
          </label>
        </div>
        <p class="status" id="status"></p>
      </section>

      <section class="card">
        <h2>Standings</h2>
        <div id="seats"></div>
      </section>
    </aside>
  </div>

  <footer>
    Space plays and pauses, arrows step a frame, shift and arrows step a move.
    This file is self-contained and plays offline.
  </footer>
</div>

<script type="application/json" id="replay-data">${json}</script>
<script>${VIEWER_SCRIPT}</script>
</body>
</html>
`;
}
