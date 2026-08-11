/**
 * Worker entry point: route a request to the Durable Object for its room.
 *
 * The URL shape is `/parties/main/:roomCode`, kept from the PartyKit layout this
 * replaced, so the browser client needs no change — `partysocket` builds exactly
 * that path.
 */

import { ChainReactionRoom, type Env } from "./room";

export { ChainReactionRoom };

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/parties\/main\/([^/]+)\/?$/);

    if (!match) {
      return new Response("Not found. Rooms live at /parties/main/:roomCode.", { status: 404 });
    }

    // Upper-cased so a link typed in lower case reaches the same room as the one
    // shown in the lobby — room codes are displayed and read aloud in caps.
    const roomCode = decodeURIComponent(match[1]).toUpperCase();

    // `idFromName` is what guarantees one instance per code, everywhere.
    const id = env.ROOMS.idFromName(roomCode);
    const stub = env.ROOMS.get(id);

    // The object cannot recover its own name, so the code rides along.
    url.searchParams.set("room", roomCode);
    return stub.fetch(new Request(url.toString(), request));
  }
};

export default worker;
