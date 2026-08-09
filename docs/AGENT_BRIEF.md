# Agent Brief — chain-reaction-global (`cr_GAYM`)

**Read this file completely before doing anything. Do not start writing feature code.**

This is a bootstrap brief for the first working session. Your job in this session is to make the repo *verifiable* — lint, types, tests, CI — and to extract the game engine into pure, testable functions. Feature work comes after, and only once CI is real.

---

## 0. Ground rules for this session

1. **Verify before you trust.** Everything in Section 1 was read from GitHub's web view of `package.json` and `README.md` only. Nobody has read the actual source. If reality differs from what's written here, **reality wins** — correct this file as part of your work.
2. **Do not decide the multiplayer architecture.** See Section 4. That is a human decision and it is still open. Stop and ask.
3. **Do not touch `/local` behaviour.** The README states local mode was deliberately isolated so unfinished multiplayer work cannot break it. Preserve that boundary.
4. **One concern per commit.** Small, reviewable commits with clear messages.
5. **If you are unsure, ask.** A wrong assumption compounds over a week of automated runs. A question costs thirty seconds.

---

## 1. What this repo is (verify all of this)

**Product:** A glow-styled Chain Reaction game. Grid-based; players place orbs; cells exceeding their critical mass explode into neighbours, converting them and potentially triggering cascades. Last player standing wins.

**Stack (from `package.json`):**

| Thing | Version |
|---|---|
| Next.js | ^15.2.0 |
| React / React DOM | ^19.0.0 |
| Tailwind CSS | ^4.2.2 (via `@tailwindcss/postcss`) |
| `motion` (Framer Motion successor) | ^12.38.0 |
| TypeScript | ^5.8.2 |

**Directories:** `app/`, `pages/`, `components/`, `lib/`, `docs/`

**Routes per README:** `/` (mode select), `/local` (stable), `/multiplayer` (incomplete, deferred to "Phase 3")

**Deployment:** Vercel — `cr-gaym.vercel.app`

**Existing docs:** there is a `docs/` folder with product and architecture references. **Read it before Section 5.** If it contradicts this brief, tell me — don't silently pick one.

### First task: write down what's actually true

Before anything else, inventory the repo and report back:

- What's in `lib/` — is game logic already separated, or is it inside components?
- What's in `pages/` vs `app/` and **why** (see Section 3)
- What state management is used (Context? `useState` in a page? Reducer?)
- Is there any persistence (localStorage, cookies)?
- Does `npm run build` actually pass right now?
- Is there any `.github/` directory?

---

## 2. Known broken / missing things

These are high-confidence problems. Confirm each, then fix in the order given in Section 5.

- **`npm run lint` is broken.** `package.json` defines `"lint": "next lint"`, but neither `eslint` nor `eslint-config-next` is in `devDependencies`. There is currently no static analysis on this project at all.
- **No `typecheck` script.** Type errors are only caught during `next build`, which is slow feedback.
- **No test infrastructure whatsoever.** No Vitest, no Testing Library, no Playwright, no test files.
- **No CI.** No `.github/workflows/`. Vercel builds it and that is the entire quality gate.
- **Multiplayer is unimplemented.** There is no `socket.io`, no `ws`, no realtime dependency in `package.json`. Phase 3 has not started.
- **README may drift from reality.** Treat it as a claim, not a spec.

---

## 3. The `app/` + `pages/` question

Both router directories exist. There are two possibilities:

**(a) It's deliberate.** Socket.IO on Next.js requires a Pages Router API route (`pages/api/socket.ts`) because App Router Route Handlers can't perform the WebSocket upgrade on a Node server. If `pages/` exists for this reason, that is legitimate — **document it prominently in `CLAUDE.md`** so no future agent run "helpfully" migrates it and destroys the multiplayer path.

**(b) It's accidental drift** from a scaffold or a half-finished migration. If so, consolidate onto App Router and delete the dead directory.

Find out which, report it, and don't act until it's confirmed.

---

## 4. OPEN DECISION — do not resolve this yourself

**Vercel serverless functions cannot hold persistent WebSocket connections.** The current Phase 3 multiplayer plan does not work on the current hosting. This must be settled before any multiplayer code is written, or the work gets thrown away.

The three viable paths:

1. **PartyKit** — purpose-built for exactly this (stateful multiplayer rooms on the edge). Least infrastructure, cleanest fit for a turn-based grid game.
2. **Separate socket server** on Railway / Fly.io / Render, with the Next app staying on Vercel. Most control, most ops overhead, CORS and auth to handle.
3. **Turn-based over HTTP** with polling or SSE. No WebSockets at all. Chain Reaction is turn-based and not twitch-reactive, so this is genuinely viable and by far the simplest. Cascade animation is client-side; only the resolved move needs transmitting.

**Ask which one before starting any multiplayer work.** Until then, multiplayer stays frozen exactly where it is.

---

## 5. Session 1 task list — do these in order

Each task is one commit (or one PR). Do not proceed to the next until the previous one passes.

### Task 1 — Make lint work
```bash
npm i -D eslint eslint-config-next
```
Add an ESLint config appropriate to Next 15. Run it. **Report the error count, don't mass-autofix.** A wall of autofixed formatting changes hides real problems and makes the diff unreviewable. Fix genuine errors, and tell me about anything ambiguous.

### Task 2 — Add a typecheck script
Add to `package.json`:
```json
"typecheck": "tsc --noEmit"
```
Run it. Report and fix real type errors. If `tsconfig.json` has `strict: false`, say so — do **not** flip it on in this task, that's its own PR.

### Task 3 — Extract the game engine (the important one)

Create `lib/engine/` containing **pure functions with zero React, zero DOM, zero side effects**:

```
lib/engine/
  types.ts       GameState, Cell, Player, Move, GridConfig
  rules.ts       criticalMass(row, col, rows, cols) — corner=2, edge=3, interior=4
  engine.ts      applyMove(state, move) -> GameState
                 resolveCascade(state) -> GameState
                 isLegalMove(state, move) -> boolean
                 checkWinner(state) -> Player | null
                 createInitialState(config) -> GameState
  index.ts       public exports
```

Rules to preserve exactly as the current game plays them:
- A move is legal only on an empty cell or a cell the player already owns.
- Placing adds one orb. A cell reaching its critical mass explodes: it empties and sends one orb to each orthogonal neighbour, converting those cells to the exploding player's colour.
- Explosions cascade, and cascades can chain indefinitely until no cell is over critical mass.
- **Elimination only applies after every player has taken at least one turn** — otherwise player 2 is "eliminated" before their first move. This is the classic Chain Reaction bug; make sure the current code handles it and that a test pins it.

Refactor `/local` to consume this engine. Behaviour must be identical — this is a pure refactor, no gameplay changes.

### Task 4 — Test infrastructure
```bash
npm i -D vitest @vitejs/plugin-react @testing-library/react @testing-library/jest-dom jsdom
npm i -D @playwright/test
```
Add `"test": "vitest run"` and `"test:e2e": "playwright test"`.

**Minimum test suite before this task is done:**

*Engine unit tests (`lib/engine/__tests__/`)*
- `criticalMass` returns 2/3/4 for corner/edge/interior on a standard grid
- A single placement on an empty cell increments correctly and switches turn
- A corner cell with 1 orb explodes on the second placement
- A cascade converts an opponent's adjacent cell
- **Cascade termination**: a near-saturated grid resolves without infinite looping — wrap in a timeout so a hang fails rather than blocking CI forever
- Orb conservation: total orbs after a resolved move equals total before, plus one
- An illegal move (opponent's cell) is rejected
- No player is eliminated before every player has moved once

*E2E (`e2e/`)*
- `/` loads and both mode links render
- `/local` loads, a click places an orb, turn indicator advances

### Task 5 — CI
Create `.github/workflows/ci.yml` running on push and pull_request: `npm ci`, then typecheck, lint, `test`, `build`, then Playwright. All four must be required checks.

Then **I** enable branch protection on `main` requiring them — tell me when the workflow is green so I can do it.

### Task 6 — Write `CLAUDE.md`
Root-level. Contents:
- Real stack and versions (as verified, not as the README claims)
- The `app/` vs `pages/` answer from Section 3, with reasoning
- Directory conventions and where new code goes
- **`lib/engine/` is pure — no React, no DOM, no imports from `components/`. Any gameplay rule change requires a test in the same PR.**
- Tailwind v4 conventions (v4 is CSS-first config, not `tailwind.config.js` — note how theming is actually done here)
- `motion` not `framer-motion` — the import path is `motion/react`
- Definition of done for a component: loading / empty / error states, keyboard operable, visible focus ring, works at 360px width, no layout shift
- Never: commit secrets, disable a failing test to make CI pass, change `/local` gameplay without a passing engine test, start multiplayer work while Section 4 is unresolved

### Task 7 — Fix the README
Make it match reality. Add a real screenshot. Note that multiplayer is not implemented and that the hosting decision is pending.

---

## 6. Definition of done for this session

- [ ] `npm run lint` runs clean
- [ ] `npm run typecheck` passes
- [ ] `npm run test` passes with the engine suite above
- [ ] `npm run test:e2e` passes
- [ ] `npm run build` passes
- [ ] CI green on a PR
- [ ] `/local` plays identically to before the refactor
- [ ] `CLAUDE.md` exists and is accurate
- [ ] Section 4 answered by a human

---

## 7. After this session (do not start yet)

Roughly ordered. Each becomes a GitHub issue with acceptance criteria before an agent touches it.

**Game feel:** cascade animation timing and easing, sound with a mute toggle, haptics on mobile, explosion particles that don't tank frame rate on a mid-range Android.

**Single player:** AI opponent — start with greedy heuristic, then minimax with alpha-beta at depth 3–4. The pure engine makes this straightforward; it needs a fast `applyMove` with no allocation churn, which is a good reason the engine is pure.

**Product surface:** grid size and player count selection, colour-blind-safe palettes (do not encode player identity in hue alone — use shape or pattern too), undo, match history, PWA install and offline play.

**Then multiplayer**, once Section 4 is answered.

---

## 8. How to use this file

Start the session with:

> Read `docs/AGENT_BRIEF.md` in full. Then do Section 1's inventory task and report back before touching anything else.

Once Tasks 1–6 are merged and CI is green, this repo is ready for the autonomous planner/builder/reviewer loop. Before that it is not — an agent with no passing tests to satisfy will produce a week of confident, untested output that looks fine in the diff.