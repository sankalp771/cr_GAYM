# Product Reference

## One-Liner

Build a web-first, glow-styled version of classic Chain Reaction with synchronized multiplayer rooms, spectator flow, quick turns, and a long-term path to global ranked competition.

## Confirmed Decisions

- Platform now: web game
- Platform now must also be strongly mobile-responsive because most sessions are expected on phones
- Core gameplay: classic Chain Reaction
- Visual direction: premium glow / neon energy styling
- Match type now: private multiplayer rooms and later random ranked matchmaking
- Join methods: room code and shareable link
- Player identity now: free-text guest display name
- Supported players target: 2 to 8
- Initial implementation stage: 2 players first, but architecture must expand cleanly to 8
- Host chooses room capacity
- Board sizing: preset-only options matching the original game style
- Spectator handling: only eliminated players become spectators automatically; no external spectator joining
- Turn limit: 20 seconds
- Timeout handling: if timer expires, the game auto-plays a random valid move for that player
- Disconnect handling: disconnected players can rejoin at any time while still alive; auto-play keeps covering their turns until they return or are eliminated
- Social layer now: emoji/reactions only, no text chat
- Competitive now: ranked play is in scope
- Competitive later: championship/tournament mode
- Design direction: scalable architecture from the start, even if MVP stays lean

## Core Gameplay Rules

The game follows classic Chain Reaction rules:

1. Players take turns placing one orb into a valid cell.
2. A player may place an orb only in:
   - an empty cell, or
   - a cell already owned by that player
3. Each cell has a critical mass determined by its neighbors:
   - corner cells: 2
   - edge cells: 3
   - inner cells: 4
4. When a cell exceeds its critical mass, it explodes and sends one orb to each orthogonal neighbor.
5. Neighboring cells hit by an explosion become owned by the exploding player.
6. Explosions can trigger further explosions, causing chain reactions.
7. Players are eliminated when they own no cells after they have already entered active play.
8. The last surviving player wins.

## Clarifications To Preserve

- The game must feel fast. The 20-second turn timer is part of the identity, not a later add-on.
- A timed-out player is not removed. Only that turn is auto-played.
- A disconnected player should not block the room forever. Their turns continue through server-side auto-play until they return or get wiped out.
- Eliminated players should not be kicked abruptly. They become spectators and can either keep watching or leave the room.
- Classic rules come first. Power-ups and custom modes are not part of phase 1.

## Board Presets

The board size selector must expose only these five presets:

- `Classic (6)` -> 6x6
- `Large (8)` -> 8x8
- `HD (10)` -> 10x10
- `XL (12)` -> 12x12
- `XXL (14)` -> 14x14

Do not offer arbitrary board-size inputs in the UI.

## Lobby And Room Rules

- A player enters a free-text display name before joining or creating a room.
- The host creates a room and chooses:
  - board preset
  - room player count target from 2 to 8
- The room lobby shows:
  - room code
  - shareable link
  - occupancy such as `4/8`
  - full player list
  - ready status of non-host players
- The host does not need a separate `Ready` button.
- Non-host players must click `Ready`.
- The host gets the `Start` button only when the desired player count has joined and every non-host player is ready.
- Once the match starts, no new external spectators should join.
- Players who are eliminated may remain as spectators or leave voluntarily.
- Players and spectators may both send reactions.

## Product Principles

- Easy to start: quick room creation, quick joining, low-friction guest flow
- Fair multiplayer: server-authoritative turns and validations
- Spectacle: chain reactions should feel dramatic and satisfying
- Fast matches: no dead air, timer-driven momentum
- Scalable future: room play first, ranked later without rewriting core systems

## MVP Scope

Phase 1 multiplayer MVP should include:

- preset-only board size selection
- 2-player implementation first, with architecture ready for up to 8
- private room creation
- join by room code
- join by shareable link
- lobby with player list, occupancy, and ready states
- ready/start flow
- synchronized turn-based gameplay
- 20-second turn timer
- random valid auto-move on timeout
- classic elimination and win detection
- spectator continuation for eliminated players
- emoji/reactions in match
- glow/neon visual identity
- reconnect and resync support

## Deferred For Later

- public matchmaking
- seasonal ladders
- MMR/ranked tuning
- persistent profiles
- achievements
- tournaments/championship events
- replays
- anti-cheat hardening beyond basic server authority

## UX Notes

The game should feel more premium than the original mobile version:

- dark arena-style background
- vivid orb glow
- energetic chain explosion flashes
- strong turn indicators
- clean mobile-responsive layout even on web
- minimal friction between opening the site and getting into a room
