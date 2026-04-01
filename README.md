# Chain Reaction Global

Next.js + TypeScript build of a glow-styled Chain Reaction game with separated local and multiplayer flows.

## Current Structure

- `/`: home screen with mode selection
- `/local`: stable local game mode
- `/multiplayer`: isolated multiplayer workspace for the later socket fix

## Run

1. Install dependencies with `npm install`
2. Start the app with `npm run dev`
3. Open `http://localhost:3000`

## Notes

- Local mode is intentionally separated so unfinished multiplayer work cannot break it.
- Multiplayer will be resumed in Phase 3 after the room/socket flow is rebuilt cleanly.
- Product and architecture references still live in `docs/`.
