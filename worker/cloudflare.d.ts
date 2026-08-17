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
    /** The same shape as global `fetch`, for object-to-object calls that build a request inline. */
    fetch(input: string, init?: RequestInit): Promise<Response>;
  }

  interface DurableObjectNamespace {
    idFromName(name: string): DurableObjectId;
    get(id: DurableObjectId): DurableObjectStub;
  }

  /**
   * The SQLite handle a `new_sqlite_classes` object gets.
   *
   * `exec` returns a cursor that is iterated once; the rows are typed by the
   * caller because SQLite has no schema to read them from at compile time.
   */
  interface SqlStorageCursor<T> extends Iterable<T> {
    toArray(): T[];
  }

  interface SqlStorage {
    exec<T = Record<string, unknown>>(query: string, ...bindings: unknown[]): SqlStorageCursor<T>;
  }

  interface DurableObjectStorage {
    readonly sql: SqlStorage;
  }

  interface DurableObjectState {
    readonly id: DurableObjectId;
    readonly storage: DurableObjectStorage;
  }
}

export {};
