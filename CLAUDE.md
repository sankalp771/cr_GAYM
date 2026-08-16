# CLAUDE.md

Guidance for agents and humans working in this repository. Everything here was
verified against the source, not copied from the README. If reality and this
file disagree, reality wins — fix this file in the same PR.

## What this is

A glow-styled Chain Reaction game. Players place orbs on a grid; a cell that
reaches its critical mass explodes into its orthogonal neighbours, converting
them and potentially triggering a chain. Last player standing wins.

Deployed on Vercel, with the multiplayer room server on Cloudflare Workers.
Local play and online rooms both work.

## Stack (verified)

| Thing | Version | Notes |
|---|---|---|
| Next.js | 15.5.23 | App Router only. Pinned to the `backport` line for security fixes without the Next 16 migration. |
| React / React DOM | 19.x | |
| TypeScript | 5.9.x | `strict: true` already. |
| Tailwind CSS | 4.2.2 | Via `@tailwindcss/postcss`. |
| `motion` | 12.38.0 | Import from `motion/react`, **not** `framer-motion`. |
| Vitest | 4.x | Two projects: `engine` (node), `ui` (jsdom). |
| Playwright | 1.62 | Desktop Chrome + Pixel 7. |
| ESLint | 9.x | Flat config. |

## Commands

```bash
npm run dev         # dev server
npm run build       # production build
npm run lint        # eslint (NOT `next lint` — see below)
npm run typecheck   # tsc --noEmit
npm test            # vitest run
npm run test:e2e    # playwright (needs `npm run build` first)
```

All five run in CI on every push and pull request.

## Layout

```
app/            App Router routes: / , /local , /multiplayer
components/     React components. Presentation only.
components/home/  The landing page's self-playing demo board.
components/replay/ The replay viewer and the end-of-match offer.
lib/engine/     The game engine. Pure. See the rules below.
lib/multiplayer/ Wire protocol and the client transport hook.
lib/replay/     Match records, the replay timeline, and the HTML export.
worker/         The authoritative room server (Cloudflare Durable Object).
e2e/            Playwright specs.
docs/           Product, architecture, roadmap, agent brief, worklogs.
```

There is **no `pages/` directory**, and adding one back needs a reason. It
previously held a single unmodified `_document.tsx` added *after* the App Router
migration — scaffold drift, not a deliberate Pages Router escape hatch, and dead
under App Router. The one legitimate reason to reintroduce it is a Socket.IO
WebSocket upgrade route, which App Router Route Handlers cannot perform. If that
happens, it must be documented here at the same time.

## The engine boundary — the one hard rule

`lib/engine/` is **pure**: no React, no Next, no `motion`, no DOM, no
`localStorage`, no `Date.now()`, no `Math.random()`, no imports from
`components/`.

This is enforced mechanically in `eslint.config.mjs`, not left to review. It is
not stylistic. The same code is meant to run in three places — the browser, Node
tests, and eventually an authoritative multiplayer server — and anything that
only exists in one of them breaks the other two. Determinism is also what makes
the AI search and server-side move validation possible at all.

Randomness and time are **injected**: `pickAutoMove(state, random)` takes the
random source as an argument, so a server can be the one to roll the dice and a
test can pin the result.

**Any change to a gameplay rule requires a test in the same PR.** No exceptions.

Import from `@/lib/engine`, never from `lib/engine/engine` or `lib/engine/rules`
directly, so the public surface stays a single reviewable seam.

## Gameplay rules the engine guarantees

- A move is legal only on an empty cell or one the player already owns.
- Critical mass is the orthogonal neighbour count: 2 at a corner, 3 on an edge,
  4 in the interior. A cell **reaching** it explodes, so a stable cell holds at
  most `criticalMass - 1`.
- Explosions conserve orbs exactly, and the grid has no sink.
- A player is eliminated only once they have played a turn *and* then lost every
  orb. Elimination is gated on every player having entered play, otherwise
  player 2 is "eliminated" before their opening move — the classic Chain
  Reaction bug.

### Why the cascade stops when one player owns everything

Because orbs are conserved and nothing leaves the grid, a board holding more
orbs than its stable capacity has **no resting configuration at all**. The
original loop had no termination condition and spun forever while appending a
board clone per step until memory ran out. It hung 93% of random 6x6 two-player
games, always at the moment somebody won.

So the cascade stops as soon as every orb belongs to one player: the match is
decided, and there is no opponent left to convert. A generous pass ceiling backs
this up and throws rather than hanging.

**Do not "optimise" that check away.** If a cascade change is needed, the random
playout test in `lib/engine/__tests__/engine.test.ts` is the one that must stay
green — it plays 200 games to completion across four board and player
combinations.

## The computer opponent

There are two opponents, not one.

`lib/engine/ai.ts` holds `chooseGreedyMove(state, random)`. It is one ply: score
every legal move by the position it produces and take the best, breaking ties
with the injected `random`. It is **not** a search.

`lib/engine/search.ts` holds the depth search. It sits *beside* the heuristic,
not inside it — see below.

Seats are chosen per seat in Battle Setup, defaulting to one human and computers
for the rest, so a match can be human + 1 through human + 7 bots. The seat kinds
are snapshotted when the match starts, so editing the panel mid-match cannot
change who is driving a seat.

### Difficulty

`chooseAiMove(state, difficulty, random)` picks between them. The first three
levels are one heuristic at three honesties, expressed as how often a seat
*declines* its best move and plays a random legal one instead — `easy` always,
`normal` 40% of the time, `hard` never. That is three genuine strengths without
three opponents to maintain.

At `hard` the wrapper returns `chooseGreedyMove` directly rather than burning an
rng draw on a roll it cannot act on, so `hard` **is** the greedy move for a given
seed. A test asserts that equivalence; keep it true.

`expert` is the fourth rung and the only one that is a different opponent: the
depth search. It was added beside `hard` rather than replacing it, deliberately —
a player who settled on Hard should keep getting the opponent they know, and a
difficulty that silently gets stronger is a bad surprise. **If a fifth level ever
lands, extend the ladder the same way rather than upgrading an existing rung.**

Difficulty is chosen in the settings popover, persists to `localStorage`, and
takes effect from the computer's next move. The bot reads it through a ref for
the same stale-closure reason it reads game state through one.

### The depth search

`searchBestMove(state, random, options)` is paranoid alpha-beta with iterative
deepening. Three things about it are decisions rather than details:

- **The opponent model is paranoid.** Minimax is a two-player theorem and this
  game seats eight. Everyone who is not the mover is collapsed into one opponent
  minimising the mover's score. Maxn — every seat maximising its own — is more
  truthful and prunes almost nothing, because alpha-beta needs a single scalar to
  bound against.
- **The budget is nodes, not milliseconds.** The engine may not read the clock,
  so a time budget is not available; a node budget is also better, because it is
  deterministic and a server and a client cannot disagree about the best move
  because one of them was busy. Iterative deepening turns the budget into a
  guarantee: small boards get more plies than large ones for the same cost,
  automatically. Measured: depth 5 on Classic, depth 3 on XXL, worst case 14–27ms.
- **It does not run on the engine's own `applyMove`.** That manages ~88k
  positions/sec because it clones every cell as an object; the search's flat
  typed-array mirror manages 0.5M–1.1M, which is the difference between depth 2
  and depth 5.

That last one means the rules exist twice, which is a genuine hazard. It is
covered mechanically, not by care: `lib/engine/__tests__/search.test.ts` replays
random games through both implementations and compares every cell, every
elimination flag and the winner after **every legal move**, not just the played
one. **If you change a gameplay rule, that test is what tells you the search
still agrees — do not skip or weaken it.**

`DEFAULT_MAX_NODES` was set by measurement, and the table justifying it is in the
docstring. Raising it costs latency on the mid-range Android the brief calls out,
where this machine's 27ms is nearer 100ms. If a level ever needs more depth than
the budget allows, move the search to a Web Worker rather than raising the
ceiling — it runs on the main thread today only because it is bounded.

Two things in `components/local-arena.tsx` are load-bearing:

- A bot's move goes through the same `runMove` a click does. There is one move
  path and one animation path, and it must stay that way.
- The bot is dispatched from an effect that re-runs on every state change, so it
  reaches its handler through a ref (stale-closure trap, same as the turn timer)
  and latches on `moveCount` so it cannot play twice for one turn.

## Multiplayer

`/multiplayer` is real. Rooms are **Cloudflare Durable Objects**, in `worker/room.ts`, one instance per
room code — `idFromName` is what guarantees that, and it is why a room can hold
its state in memory and two players can be certain they are talking to the same
one.

Cloudflare because Vercel serverless functions cannot hold a persistent
WebSocket, so realtime could never live inside the Next app. Against a socket
server on Railway or Fly: a turn-based room costs nothing while a lobby waits,
whereas an always-on box costs the same at 3am with nobody playing and needs
Redis the moment it scales past one node.

**PartyKit was tried first and removed.** It is a thin wrapper over this same
Durable Object and it cannot ship: its shared `partykit.dev` zone has hit
Cloudflare's 10,000-custom-domains-per-zone limit, and deploying to a private
account fails too, because a free Cloudflare plan permits Durable Objects only
via a `new_sqlite_classes` migration and no published PartyKit build — latest or
beta — emits one. **Do not reintroduce it.** See `wrangler.toml`, where that
migration is a single line.

```bash
npm run dev          # the Next app
npm run dev:rooms    # the room server, on :1999 — both are needed
npm run deploy:rooms # ships the room server (needs a Cloudflare account)
```

`NEXT_PUBLIC_PARTYKIT_HOST` points the browser at a deployed room server. Unset,
it falls back to `127.0.0.1:1999`, which is also the port the Playwright suite
starts one on — so an untouched `npm run build` is testable without env plumbing.

### The rules run on the server, and that is the whole point

`worker/room.ts` imports `lib/engine` directly and calls the same `applyMove` the
browser does. The purity rule exists *for* this: one copy of the rules, so a
client cannot disagree with the server about what a move did. Both things the
engine refuses to touch are injected in the server — `Math.random` for auto-play,
the wall clock for turn deadlines.

The client holds **no authority**. It sends move intents and renders snapshots.
Whether you may sit, start, or play a given cell is decided in `worker/room.ts`.

**Cascade frames are never sent.** A resolved move can be hundreds of full board
clones. The server broadcasts the move and the resulting state; the client
replays that move through its own engine to generate identical frames, then
reconciles. If its board is not exactly one move behind, it snaps to the
authoritative state instead of animating — see `advanceTo` in `use-room.ts`.
This only works because the engine is deterministic. **Do not add non-determinism
to the engine, or online play will desync rather than merely misbehave.**

### Details that are load-bearing

- **Seats key on a session token, not the socket.** The token lives in
  `localStorage` and is passed as a connect query parameter, so a refresh or a
  dropped connection returns you to the same seat. In the lobby a seat is freed
  after a short grace period; in a match it is never freed — the turn timer
  auto-plays so one person's wifi cannot stall everyone.
- **The room code is in the URL.** That makes a room a shareable link and is what
  makes reload-rejoins work.
- **`match.move` carries the mover's `moveCount`** and the server drops anything
  that does not match, so a double tap, or a move sent as the timer auto-played,
  is ignored rather than played twice.
- **Joining an unknown code is an error, not a new room.** PartyKit creates a room
  on connect, so without this a typo puts you in a lobby nobody is ever joining.
- `components/local/match-screen.tsx` is shared by both modes, and by the replay
  viewer. Its differences from local play are optional props (`canAct`,
  `seatBadge`, `settings`, `showClock`, `sideExtra`, …) that default to local
  behaviour, so there is one board and one animation path.
- **If `NEXT_PUBLIC_PARTYKIT_HOST` is unset on a deployment**, the client dials
  `127.0.0.1:1999` — which on a phone is the phone. The socket then retries
  forever and the lobby reads as merely slow. `isRoomServerMisconfigured()` names
  that case, and an 8-second dial timeout stops the lobby claiming to be
  connecting when nothing is listening. Do not remove either: a silent infinite
  retry is indistinguishable from a bad network, and it wasted a debugging round
  trip once already.

## Replays

When a match ends, both modes offer the same two things — watch it back, or
download it — the way Pokémon Showdown does. `components/replay/replay-actions.tsx`
is that offer, and it appears in the winner modal and, locally, in a side panel
too, because the modal can be dismissed and the offer must not go with it.

### A record is a move list, and nothing else

`MatchRecord` in `lib/replay/record.ts` holds the board size, the seats, and the
moves. Every board state a replay shows is re-derived by `expandRecord` running
those moves back through `lib/engine` — the same trick the multiplayer client
uses to animate a move the server never sent frames for.

This is the whole design, and it depends on the engine being deterministic:

- **There is one copy of the rules.** A replay cannot show a game this app would
  not play, because it *is* this app playing it.
- **The record is tiny.** A 375-move XXL match is a few kilobytes of moves and
  1.4MB of frames.
- **A rule change updates old replays for free** — and, being the same engine,
  cannot silently disagree with them.

**Do not start recording board states instead.** The moment a record carries
positions rather than moves, it is a second source of truth for the rules.

### The downloaded file is frames, not rules

The one place that trade is inverted is `lib/replay/export-html.ts`. The exported
HTML carries **serialised frames** and a viewer that only decodes and draws them.

That is the deliberate opposite of the rule above, for one reason: the file has
to open years from now, from a `file://` URL, with no network and no copy of this
app. Embedding the engine would mean shipping a second implementation of the
cascade inside every download — a rules fork nobody can reach or test once the
file has left the building. Frames cost bytes instead, two characters per cell
per frame: 55KB for a typical Classic match, 1.4MB for the worst XXL one. A test
holds that ceiling.

Everything is inlined — no script src, no stylesheet link, no font request, no
image — and `lib/replay/__tests__/export-html.test.ts` asserts that, loads the
result in jsdom and drives it. The file's only public surface is
`window.chainReactionReplay`, which exists so that test can drive the player
rather than assert on the markup that produced it. A player's name reaches the
page only as escaped JSON and as `textContent`, and there is a test that a name
containing `</script>` cannot break out.

### Online records are all-or-nothing

`useRoom` accumulates a move log and throws the whole thing away — `moveLog`
becomes null — the moment a broadcast does not follow the one before it, or the
client joined a match already under way. A replay missing its opening is a replay
of a different game, so the offer simply does not appear. **Do not "repair" a
partial log**; there is nothing to repair it from.

### The finale is shared

`lib/victory-finale.ts` is the winner's flourish, and it now has three consumers:
the live match, the replay viewer and the export. It lives outside `lib/engine/`
because it is presentation, and it exists because the engine stops a decided
cascade mid-reaction — without it, every replay would end on a board that looks
jammed. Its frames carry the last move's number so the counter does not tick past
the end, which is why `moveBoundaries` skips them: counting them would drag that
move's marker onto the emptied board and leave no index meaning "the position the
match finished in".

## The landing page

The board in the hero is **the real engine, playing itself** —
`components/home/demo-board.tsx` runs `chooseGreedyMove` → `applyMove` →
`framesToSteps`, the same path a match uses. It is not a loop of hand-authored
frames, and it should not become one: tying it to the engine is what stops the
marketing page from drifting into showing a game this app does not actually
play. If a rule changes, the demo changes with it, for free.

Three things about it are deliberate:

- **It stops when it is not being watched** — an `IntersectionObserver` plus
  `visibilitychange`. A landing page that keeps a game loop running in a
  background tab is a battery complaint waiting to happen.
- **Under `prefers-reduced-motion` it never animates.** It plays a *seeded* game
  to a mid-match position and shows that still. The arena's cascade is exempt
  from reduced motion because there the cascade is the game; here it is
  decoration, so the exemption does not apply.
- **The seed is fixed**, so every reduced-motion visitor sees the same considered
  position rather than whatever chance produced. This is only possible because
  the engine takes its randomness as an argument.

Copy on this page describes what the game **does today**. It previously
advertised multiplayer as "Phase 3" and a "Lab" long after online play shipped,
which is worse than saying nothing. If a mode's status changes, this page is
part of that change.

## Styling

### Tailwind v4

v4 is CSS-first. There is **no `tailwind.config.js`** and adding one is the wrong
move. Theme tokens are declared in an `@theme` block at the top of
`app/globals.css`, after `@import "tailwindcss"`.

Very little of this app is utility classes. It is hand-written CSS driven by
`:root` custom properties. Player colour is passed down as a `--player-color`
custom property on the element. Follow the existing pattern rather than
converting to utilities piecemeal.

### `globals.css` holds tokens and almost nothing else

It is down to design tokens, the reset, and three primitives that genuinely
every screen uses — `.primary-link`, `.ghost-link`, `.button-reset`. **Do not add
a fourth without checking it is really shared.**

Everything else is a CSS Module beside the thing it styles: `app/home.module.css`
for the landing page, `components/**/[name].module.css` for components. This is
the structural fix for the global-namespace collision described under *Never*
below — a module cannot capture a class it does not own, so that bug cannot
recur in module-scoped code.

Roughly 250 lines of global CSS were deleted when the landing page moved to a
module, most of it dead rules left over from a multiplayer placeholder page that
no longer exists. If you find a global rule with no `.tsx` referencing it, it is
probably also dead — grep before assuming otherwise.

### Fonts

Three families, loaded and self-hosted at build time by `next/font/google` in
`app/layout.tsx`, exposed as `--font-heading` / `--font-sans` / `--font-code` and
consumed through the `*-stack` variables in `:root`:

| Role | Family | Used for |
|---|---|---|
| Heading | Chakra Petch | `h1`, `h2`, card and section titles |
| Body | Archivo | running text and UI |
| Mono | IBM Plex Mono | eyebrows, labels, counters, timers |

`next/font` means there is no runtime request to a font CDN, no third-party
connection, and no flash of unstyled text. **Do not replace this with a
`<link>` to Google Fonts** — it would reintroduce all three.

## Sound, haptics and motion

Audio is **synthesised**, not sampled — `lib/sound.ts` builds every effect from
oscillators and a noise buffer. No audio files means nothing to license, host or
download before the first move, and it lets an explosion be pitched by how deep
into a cascade it is, which a fixed sample cannot do. Do not add sample files
without a reason that this cannot cover.

Two rules that are easy to get wrong:

- An `AudioContext` **must** be created inside a user gesture. One created any
  other way stays suspended forever and every sound silently does nothing. It is
  primed on Start Battle and on unmuting.
- The mute preference lives in `localStorage`, so it must not be read during
  render — that is a hydration mismatch. Read it in an effect after mount.

`prefers-reduced-motion: reduce` is respected globally. The cascade still steps
through its frames, because that is the game rather than decoration; only the
ambient and decorative motion stops.

Explosion particles animate with **transform and opacity only** — both
composited, neither triggering layout or paint. A 14x14 board can put a lot of
them on screen at once, and the brief is explicit about frame rate on a
mid-range Android.

## Definition of done for a component

- Loading, empty and error states all handled
- Keyboard operable, with a visible focus ring
- Works at 360px width with no horizontal scroll
- No layout shift
- Interactive elements carry an accessible name — the board cells expose position,
  orb count and owner via `aria-label`, which is also how the e2e tests address
  them

## Never

- Commit secrets
- Disable or skip a failing test to make CI green
- Change `/local` gameplay without a passing engine test in the same PR
- Give orbs per-player shapes. Every orb is the same glossy sphere and **colour
  alone** identifies the owner, as in the original game — this is a deliberate,
  owner-made call. If colour-blind support comes up, it must be an opt-in
  setting, never a change to the default look.
- Add a bare, unprefixed class name to `app/globals.css`. It is one flat global
  namespace shared by the landing page and the arena. A `.burst` rule added for
  the arena's particles silently captured the landing page's `.preview-cell.burst`
  modifier, stretched those cells to fill `.hero-card`, and shipped a broken home
  page to production. Prefix new classes (`.orb-burst`, not `.burst`) and grep
  before naming.
- Move authority for a gameplay rule into the client. The room server decides;
  the browser draws (see below)

## Open decisions

**Multiplayer deploy: pending a Cloudflare deploy.** The code is built and runs
locally; `npm run deploy:rooms` is the only step left. Until then `/multiplayer` works against `npm run dev:rooms` and
against the Playwright suite, and nothing else is blocked on it.

**Next 16 upgrade: pending.** Blocked behind one accepted advisory — `sharp`
0.34.5 carries inherited libvips CVEs and cannot be overridden without Next 16.
It is unreachable here because `sharp` only backs `next/image`, which this app
does not use. Revisit when `next/image` is wanted.
