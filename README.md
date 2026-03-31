# Chain Reaction Global

Reference-first repository for building a glow-styled, real-time multiplayer Chain Reaction game for the web.

## Purpose

This repo will grow in stages:

1. Nail the classic Chain Reaction gameplay.
2. Add premium glow/neon presentation.
3. Ship private room multiplayer with synchronized turns.
4. Add ranked/global competitive systems on top of the stable core.

## Reference Docs

Use these files first before scanning code:

- `docs/PRODUCT.md`: game vision, confirmed requirements, rules, and UX decisions.
- `docs/ARCHITECTURE.md`: system design, state ownership, networking approach, and scalability direction.
- `docs/ROADMAP.md`: phased delivery plan from MVP to ranked/global play.

## Working Rule

Before adding major features, update the relevant docs so the implementation stays aligned with product and architecture decisions.

## Local Prototype

This repo now includes a no-dependency Phase 1 prototype:

1. Run `npm run dev`
2. Open `http://localhost:3000`

Included in the prototype:

- glow-styled responsive board
- original-style board presets
- 2 to 8 local players for rules validation
- turn timer
- random auto-play on timeout
- elimination and winner detection

Next phases will layer roomed WebSocket multiplayer, reconnect handling, reactions, and ranked systems onto the same core rules.
