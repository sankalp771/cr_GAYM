# Roadmap Reference

## Phase 0: Foundation

- define product rules and multiplayer assumptions
- define architecture and repo shape
- choose stack and workspace structure

## Phase 1: Core Local Gameplay

- implement board model
- implement approved board presets
- implement critical mass logic
- implement move validation
- implement chain reactions
- implement elimination and winner detection
- implement turn timer
- implement timeout auto-play
- build a playable local prototype with responsive glow styling

Exit condition:

- classic Chain Reaction works correctly in a single browser session with the real presets and turn flow

## Phase 2: Visual Identity

- deepen the neon/glow design system
- improve orb placement animation
- improve explosions and chain propagation
- add premium turn/highlight states
- polish responsive layout on desktop and mobile web

Exit condition:

- game already feels visually distinct and satisfying before networking

## Phase 3: Private Room Multiplayer

- create room
- join by room code
- join by shareable link
- host-configured room capacity
- lobby/player seats
- ready/start flow
- authoritative move handling over WebSockets
- synchronized board updates
- turn timer
- timeout auto-play
- reconnect/resync
- spectator continuation for eliminated players
- emoji/reactions

Exit condition:

- multiple devices can play the same match in sync reliably

## Phase 4: Accounts And Identity

- guest flow retained
- optional login/signup
- player profiles
- persistent display identity

Exit condition:

- players can sign in without breaking guest accessibility

## Phase 5: Competitive Layer

- global leaderboard
- ranking/MMR system
- match history
- seasonal framework

Exit condition:

- ranked progression exists on top of stable gameplay and room infrastructure

## Phase 6: Scale And Live Ops

- metrics and observability
- abuse controls
- improved reconnect resilience
- multi-instance realtime scaling
- tournament/championship features

Exit condition:

- system is ready for larger audiences and event-based play

## Immediate Next Build Recommendation

Build in this order:

1. scaffold monorepo or app structure
2. create shared game-engine package
3. implement local playable board with timer and auto-play
4. add glow visuals
5. add websocket room server
6. connect multiplayer clients
7. add reactions, spectator flow, and reconnect handling
