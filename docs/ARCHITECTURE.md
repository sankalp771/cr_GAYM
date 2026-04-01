# Architecture Reference

## Goal

Design the game so we can ship a small web MVP quickly while keeping the foundations compatible with future ranked and large-scale multiplayer features.

## Recommended Stack

- Frontend: React + TypeScript
- Styling: CSS variables with custom styles, optionally Tailwind for layout utilities
- Realtime transport: WebSockets via Socket.IO
- Backend: Node.js + TypeScript
- Data store later: PostgreSQL
- Cache/pub-sub later for scale: Redis

## System Shape

Use a server-authoritative architecture.

### Why

- prevents invalid client moves
- reduces desync risk
- makes turn timers reliable
- gives a clean path to ranked play
- simplifies reconnect/resync behavior

## High-Level Components

### Client

Responsible for:

- rendering board state
- playing glow/chain animations
- sending player intents
- showing timer, reactions, lobby, and spectator UI
- recovering from reconnect using latest server snapshot

### Game Server

Responsible for:

- room creation and joining
- player/session membership
- authoritative game state
- turn progression
- timeout auto-play
- move validation
- explosion resolution
- elimination and winner detection
- reaction broadcasting
- reconnect recovery

### Database

Needed later for:

- accounts
- rankings
- player history
- room/match summaries
- seasonal stats

## Core Technical Decisions

### 1. Shared game rules module

Keep the gameplay engine deterministic and isolated from UI concerns.

Suggested responsibilities:

- create initial board
- expose board presets
- calculate critical mass
- validate moves
- apply move
- resolve chain reactions
- determine ownership changes
- detect eliminations
- detect winner
- enumerate valid moves
- choose random valid move for timeout

This logic should be usable in both:

- backend runtime for real matches
- frontend tests or visual previews

### 2. State authority

The client should never decide the official next board state.

Flow:

1. client sends intended move
2. server validates move against current authoritative state
3. server computes full result
4. server broadcasts updated state/event payload
5. clients animate from the authoritative result

### 3. Networking model

Use room-scoped events.

Suggested event families:

- room lifecycle
- lobby updates
- match lifecycle
- turn updates
- move submission
- board state sync
- reactions
- reconnect/resume

## Initial WebSocket Contract

The first multiplayer implementation may use native WebSockets with JSON messages to avoid dependency overhead.

Envelope shape:

```json
{
  "type": "event_name",
  "payload": {}
}
```

Client-to-server events:

- `session.restore`
- `room.create`
- `room.join`
- `room.leave`
- `room.ready`
- `room.start`
- `match.move`

Server-to-client events:

- `session.ready`
- `room.snapshot`
- `room.error`
- `match.started`
- `match.updated`
- `match.finished`

## Initial Room Flow

1. Client opens a WebSocket connection.
2. Server assigns or restores a session token.
3. Host creates a room with:
   - display name
   - board preset
   - player capacity from 2 to 8
4. Other players join with:
   - room code
   - display name
5. Server broadcasts a full room snapshot after every lobby change.
6. Non-host players toggle ready state.
7. Host can start only when:
   - room is full
   - all non-host players are ready
8. Server creates the authoritative match state and broadcasts it.
9. Players submit move intents.
10. Server validates the move, resolves the board, advances the timer, and broadcasts the next snapshot.

## Suggested Data Model

### Room

- `roomId`
- `roomCode`
- `status`: lobby | in_match | finished
- `hostPlayerId`
- `settings`
- `players`
- `spectators`
- `createdAt`

### Room Settings

- `boardPreset`
- `rows`
- `cols`
- `maxPlayers`
- `turnTimeSeconds`
- `isPrivate`

### Player

- `playerId`
- `displayName`
- `color`
- `isGuest`
- `connectionStatus`
- `seatIndex`
- `isEliminated`
- `hasEnteredPlay`
- `joinedAs`: player | spectator
- `lastSeenAt`

### Match State

- `matchId`
- `turnNumber`
- `currentPlayerId`
- `turnDeadline`
- `board`
- `activePlayers`
- `eliminatedPlayers`
- `winnerPlayerId`
- `phase`: waiting | active | resolving | finished

### Cell

- `ownerPlayerId | null`
- `orbCount`

## Board Sizing Strategy

Board size is preset-based, so avoid hardcoded assumptions while still keeping the UI constrained to approved options.

Supported presets:

- `classic` -> 6x6
- `large` -> 8x8
- `hd` -> 10x10
- `xl` -> 12x12
- `xxl` -> 14x14

Critical mass should always derive from orthogonal neighbor count:

- 2 neighbors => corner
- 3 neighbors => edge
- 4 neighbors => inner

## Timeout Strategy

If a player does not act within 20 seconds:

1. server enumerates valid moves
2. server selects one random valid move
3. server applies it as an auto-move
4. match proceeds normally to next turn

Important:

- randomness must happen on the server
- the chosen move should be included in broadcast payloads so clients can label it as an auto-played turn
- the same auto-play path should cover disconnected players so the match keeps progressing

## Spectator Strategy

Only players who were part of the active match can become spectators later.

Eliminated players remain connected to the room.

They can:

- continue receiving all board updates
- send reactions if allowed by product rules
- choose to exit the match

They cannot:

- submit moves
- re-enter the active player list during the same match

## Reconnect Strategy

Reconnects should be expected from day one.

Approach:

- identify a returning player via reconnect token/session linkage
- rebind socket to room membership
- send latest room + match snapshot
- resume timer based on server time, not client time
- if a player misses turns while disconnected, those turns are auto-played; reconnect should restore them as an active player only if they are still alive

## Lobby Rule Handling

The lobby needs explicit support for host-driven start rules.

Requirements:

- host chooses target room capacity from 2 to 8
- host chooses one approved board preset
- non-host players expose `ready` state
- host has no ready state
- room start becomes available only when:
  - current player count equals target room capacity
  - every non-host player is ready

## Scaling Path

The MVP can start as a single realtime server instance, but we should avoid dead ends.

To stay scale-friendly:

- keep room state isolated by room id
- keep event contracts explicit and typed
- avoid client-owned game state
- design server code so room state can later move to Redis-backed coordination if horizontal scaling is needed
- separate gameplay engine from transport layer
- keep account/ranking concerns separate from room runtime logic

## Folder Direction

When implementation starts, prefer a structure like:

```text
/
  apps/
    web/
    server/
  packages/
    game-engine/
    shared-types/
  docs/
    PRODUCT.md
    ARCHITECTURE.md
    ROADMAP.md
```

This keeps gameplay logic portable and reduces duplication between frontend and backend.

## Non-Goals For Early Builds

- blockchain/web3 features
- public tournament orchestration
- full anti-cheat platform
- complex social/chat systems
- custom modes and power-ups

## Architecture Rule

Before implementing a feature that changes gameplay, networking, room lifecycle, or persistence, update this file first if the decision affects future systems.
