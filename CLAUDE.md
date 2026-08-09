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

## Tailwind v4

v4 is CSS-first. There is **no `tailwind.config.js`** and adding one is the wrong
move. Theme tokens are declared in an `@theme` block at the top of
`app/globals.css`, after `@import "tailwindcss"`.

Be aware most of `app/globals.css` (~900 lines) is hand-written CSS driven by
`:root` custom properties, not utility classes. Player colour is passed down as a
`--player-color` custom property on the element. Follow the existing pattern
rather than converting to utilities piecemeal.

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
- Encode player identity in hue alone — it must survive colour blindness
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
