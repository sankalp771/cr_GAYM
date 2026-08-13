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
    try {
      return await route(request, env);
    } catch (error) {
      // Workers turns an uncaught throw into a bare 500 with the reason only in
      // `wrangler tail`, which needs credentials the person hitting the URL may
      // not have. Saying what broke costs nothing and is not sensitive.
      const detail = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
      return new Response(JSON.stringify({ ok: false, error: detail }, null, 2), {
        status: 500,
        headers: { "content-type": "application/json" }
      });
    }
  }
};

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const match = url.pathname.match(/^\/parties\/main\/([^/]+)\/?$/);

  if (!match) {
    return new Response("Not found. Rooms live at /parties/main/:roomCode.", { status: 404 });
  }

  if (!env.ROOMS) {
    throw new Error("The ROOMS Durable Object binding is missing from this deployment.");
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

export default worker;
