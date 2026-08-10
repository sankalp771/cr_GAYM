# CLAUDE.md

Guidance for agents and humans working in this repository. Everything here was
verified against the source, not copied from the README. If reality and this
file disagree, reality wins — fix this file in the same PR.

## What this is

A glow-styled Chain Reaction game. Players place orbs on a grid; a cell that
reaches its critical mass explodes into its orthogonal neighbours, converting
them and potentially triggering a chain. Last player standing wins.

Deployed on Vercel. Local play works; multiplayer is not implemented.

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
lib/engine/     The game engine. Pure. See the rules below.
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

## Tailwind v4

v4 is CSS-first. There is **no `tailwind.config.js`** and adding one is the wrong
move. Theme tokens are declared in an `@theme` block at the top of
`app/globals.css`, after `@import "tailwindcss"`.

Be aware most of `app/globals.css` (~900 lines) is hand-written CSS driven by
`:root` custom properties, not utility classes. Player colour is passed down as a
`--player-color` custom property on the element. Follow the existing pattern
rather than converting to utilities piecemeal.

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
- Start multiplayer work beyond the agreed transport (see below)

## Open decisions

**Multiplayer transport: PartyKit.** Vercel serverless functions cannot hold
persistent WebSocket connections, so realtime cannot live in the Next app.
PartyKit (now Cloudflare, deployed to your own account) was chosen over a
separate socket server on Railway/Fly: turn-based rooms hibernate while waiting
for a move and are billed nothing, whereas an always-on instance costs the same
at 3am with nobody playing and needs Redis the moment it scales past one node.
Needs a Cloudflare account before that work starts.

**Next 16 upgrade: pending.** Blocked behind one accepted advisory — `sharp`
0.34.5 carries inherited libvips CVEs and cannot be overridden without Next 16.
It is unreachable here because `sharp` only backs `next/image`, which this app
does not use. Revisit when `next/image` is wanted.
