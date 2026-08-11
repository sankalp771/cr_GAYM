/**
 * The slice of the Workers runtime this project uses.
 *
 * Declared by hand rather than pulling in `@cloudflare/workers-types`, because
 * that package replaces the DOM lib globally and this repo compiles the worker
 * and the browser app under one `tsconfig.json`. Importing it would break every
 * React file's `document`, `window` and `WebSocket`.
 */

declare global {
  /** Cloudflare's client/server socket pair, returned from a 101 upgrade. */
  const WebSocketPair: {
    new (): { 0: WebSocket; 1: WebSocket };
  };

  interface WebSocket {
    /** Workers-only: takes ownership of the server half of the pair. */
    accept(): void;
  }

  interface ResponseInit {
    /** Workers-only: the server socket returned alongside a 101. */
    webSocket?: WebSocket | null;
  }

  interface DurableObjectId {
    toString(): string;
    readonly name?: string;
  }

  interface DurableObjectStub {
    fetch(request: Request): Promise<Response>;
  }

  interface DurableObjectNamespace {
    idFromName(name: string): DurableObjectId;
    get(id: DurableObjectId): DurableObjectStub;
  }

  interface DurableObjectState {
    readonly id: DurableObjectId;
  }
}

export {};
