/**
 * Where the Cloudflare worker lives.
 *
 * Split out of `use-room.ts` because accounts need it too, and the account
 * client has no business importing a React hook and a WebSocket library to find
 * out a hostname.
 */

/** The deployed room and account server. Public — it ships in the client bundle by definition. */
const DEPLOYED_ROOM_HOST = "cr-gaym-rooms.crgaym.workers.dev";

const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)(:\d+)?$/;

export function partyHost(): string {
  if (process.env.NEXT_PUBLIC_PARTYKIT_HOST) return process.env.NEXT_PUBLIC_PARTYKIT_HOST;

  // Decided at runtime from where the page is served, not baked in at build time.
  // A build-time-only default is what caused the phone to dial `127.0.0.1` — its
  // own loopback — and retry forever: `next build` inlines `NEXT_PUBLIC_*`, so a
  // deploy that forgot the variable had no way to recover. This way a developer
  // on localhost gets their local server and everyone else gets the real one,
  // with the environment variable still overriding both.
  if (typeof window !== "undefined" && !LOCAL_HOST.test(window.location.host)) {
    return DEPLOYED_ROOM_HOST;
  }
  return "127.0.0.1:1999";
}

/** `http://` for a local worker, `https://` for a deployed one. */
export function workerOrigin(): string {
  const host = partyHost();
  return `${LOCAL_HOST.test(host) ? "http" : "https"}://${host}`;
}

/**
 * True when we are dialling a worker on this machine.
 *
 * Which means the fix for "cannot reach it" is `npm run dev:rooms`, not the
 * player's wifi — and saying so is the difference between a five-second fix and
 * a debugging session. See `isRoomServerMisconfigured` for the deployed variant
 * of the same confusion.
 */
export function isLocalWorker(): boolean {
  return LOCAL_HOST.test(partyHost());
}

/**
 * True when the page is deployed but still pointing at a local room server.
 *
 * This is a build-time misconfiguration — `NEXT_PUBLIC_PARTYKIT_HOST` was not
 * set — and it is worth naming explicitly, because the symptom is otherwise
 * indistinguishable from a slow network: the browser dials `127.0.0.1`, which on
 * a phone is the phone, and the socket retries forever without ever failing
 * loudly.
 */
export function isRoomServerMisconfigured(): boolean {
  if (typeof window === "undefined") return false;
  return LOCAL_HOST.test(partyHost()) && !LOCAL_HOST.test(window.location.host);
}
