/**
 * Worker entry point: route a request to the Durable Object that owns it.
 *
 * Rooms live at `/parties/main/:roomCode`, a shape kept from the PartyKit layout
 * this replaced so the browser client needs no change — `partysocket` builds
 * exactly that path. Accounts live at `/auth/*` and are served by a single
 * object; see `accounts.ts` for why it is one.
 */

import { Accounts } from "./accounts";
import { ChainReactionRoom, type Env } from "./room";

export { Accounts, ChainReactionRoom };

/**
 * The account routes are called cross-origin — the app is on Vercel and this is
 * on workers.dev — so they need CORS. `*` is safe here specifically because the
 * API carries no ambient authority: there are no cookies, and every
 * authenticated call passes its token explicitly, so a hostile page calling
 * these routes is only ever calling them as itself.
 */
const CORS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "access-control-max-age": "86400"
};

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [key, value] of Object.entries(CORS)) headers.set(key, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

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

  if (url.pathname === "/auth" || url.pathname.startsWith("/auth/")) {
    if (request.method === "OPTIONS") return withCors(new Response(null, { status: 204 }));

    if (!env.ACCOUNTS) {
      throw new Error("The ACCOUNTS Durable Object binding is missing from this deployment.");
    }
    // One object holds every account, so it is addressed by a constant name.
    const accounts = env.ACCOUNTS.get(env.ACCOUNTS.idFromName("accounts"));
    return withCors(await accounts.fetch(new Request(url.toString(), request)));
  }

  const match = url.pathname.match(/^\/parties\/main\/([^/]+)\/?$/);

  if (!match) {
    return new Response("Not found. Rooms live at /parties/main/:roomCode, accounts at /auth.", {
      status: 404
    });
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
