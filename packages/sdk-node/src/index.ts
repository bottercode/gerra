// @gerra/sdk-node: tells gerra what a Node service did while answering a request (outbound HTTP calls,
// database queries), so a rewrite is checked on its side effects as well as its responses.
//
// Protocol (docs/effects.md): gerra sends `x-gerra-effects: 1` on requests it records or replays. While
// such a request is handled, effects are collected; when the response headers go out, they are added as
// `x-gerra-effects: <base64url JSON array>`. gerra strips that header before anything reaches a client.
// Requests without the header are untouched, so leaving the SDK installed in production costs nothing.
import { AsyncLocalStorage } from "node:async_hooks";
import dc from "node:diagnostics_channel";
import type http from "node:http";

/** Request header gerra sends to ask for effects, and response header that carries them. */
export const EFFECTS_HEADER = "x-gerra-effects";

/** One thing the service did. Any `type` is allowed; gerra compares effects as JSON. */
export interface Effect {
  type: string;
  [key: string]: unknown;
}

export interface InstallOptions {
  /** Record outbound calls made with `node:http` / `node:https` (default true). */
  http?: boolean;
  /** Record outbound calls made with `fetch` (undici) (default true). */
  fetch?: boolean;
  /** Request bodies of outbound calls kept up to this many bytes (default 16 KB). */
  maxBodyBytes?: number;
  /** Size limit of the effects header's JSON; past it, bodies are dropped, then effects (default 256 KB). */
  maxHeaderBytes?: number;
  /** Leave out outbound calls to URLs this returns true for (e.g. telemetry). */
  ignoreUrl?: (url: string) => boolean;
}

interface Collector {
  effects: Pending[];
  /** Set once the response headers are out; later effects can't be reported. */
  sealed: boolean;
}

/** An outbound call whose request body may still be arriving. */
type Pending = Effect & { chunks?: Buffer[] };

const storage = new AsyncLocalStorage<Collector | undefined>();
let options: Required<Omit<InstallOptions, "ignoreUrl">> & Pick<InstallOptions, "ignoreUrl"> = {
  http: true,
  fetch: true,
  maxBodyBytes: 16 * 1024,
  maxHeaderBytes: 256 * 1024,
};

/**
 * Record an effect for the request being handled. Does nothing outside a request that gerra asked effects
 * for, so it is safe to call unconditionally (e.g. from a queue publisher or a database wrapper).
 */
export function recordEffect(effect: Effect): void {
  const c = storage.getStore();
  if (c && !c.sealed) c.effects.push(effect);
}

/** Whether the current request is one gerra asked effects for. */
export function isCapturing(): boolean {
  return storage.getStore() !== undefined;
}

/** A body as an effect shows it: parsed JSON when it is JSON, text otherwise, a size for binary. */
export function bodyValue(bytes: Buffer, max = options.maxBodyBytes): unknown {
  if (bytes.length === 0) return undefined;
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) return { bytes: bytes.length };
  try {
    return JSON.parse(text);
  } catch {
    return text.length > max ? `${text.slice(0, max)}… (${text.length - max} more characters)` : text;
  }
}

/** The header value for a list of effects, shrunk to fit `maxBytes`: bodies go first, then the last effects. */
export function encodeEffects(effects: readonly Effect[], maxBytes = options.maxHeaderBytes): string {
  let list: Effect[] = [...effects];
  let json = JSON.stringify(list);
  if (json.length > maxBytes) {
    list = list.map((e) => {
      const { body: _body, ...rest } = e;
      return rest as Effect;
    });
    json = JSON.stringify(list);
  }
  let dropped = 0;
  while (json.length > maxBytes && list.length > 0) {
    list.pop();
    dropped++;
    json = JSON.stringify([...list, { type: "gerra.truncated", dropped }]);
  }
  return Buffer.from(json, "utf8").toString("base64url");
}

function finishBody(e: Pending): void {
  if (!e.chunks) return;
  const body = bodyValue(Buffer.concat(e.chunks));
  delete e.chunks;
  if (body !== undefined) e.body = body;
}

function wantsEffects(req: http.IncomingMessage): boolean {
  return req.headers[EFFECTS_HEADER] === "1";
}

function attach(res: http.ServerResponse, c: Collector): void {
  const original = res.writeHead;
  // `res.write()` and `res.end()` without an explicit writeHead go through it too (_implicitHeader).
  res.writeHead = function writeHead(this: http.ServerResponse, ...args: unknown[]) {
    if (!c.sealed && !this.headersSent) {
      c.sealed = true;
      for (const e of c.effects) finishBody(e);
      const value = encodeEffects(c.effects);
      const headers = args.find((a, i) => i > 0 && a !== null && typeof a === "object");
      if (Array.isArray(headers)) headers.push(EFFECTS_HEADER, value);
      else if (headers) (headers as Record<string, unknown>)[EFFECTS_HEADER] = value;
      else this.setHeader(EFFECTS_HEADER, value);
    }
    return (original as (...a: unknown[]) => http.ServerResponse).apply(this, args);
  } as typeof res.writeHead;
}

const subscriptions: [string, (message: unknown) => void][] = [];

function on(channel: string, fn: (message: never) => void): void {
  const handler = fn as (message: unknown) => void;
  dc.subscribe(channel, handler);
  subscriptions.push([channel, handler]);
}

let installed = false;

/**
 * Start collecting effects for requests gerra asks about: outbound `node:http` and `fetch` calls are
 * recorded automatically; use {@link recordEffect}, {@link instrumentQueries} or {@link instrumentSqlite} for
 * databases and anything else. Returns a function that uninstalls it.
 */
export function install(opts: InstallOptions = {}): () => void {
  options = { ...options, ...opts };
  if (installed) return uninstall;
  installed = true;

  on("http.server.request.start", ({ request, response }: { request: http.IncomingMessage; response: http.ServerResponse }) => {
    // Always set the store, so a request without the header never inherits another request's collector.
    if (!wantsEffects(request)) return storage.enterWith(undefined);
    const c: Collector = { effects: [], sealed: false };
    storage.enterWith(c);
    // Listeners run in the context of whoever emits, and a request's 'data'/'end' are emitted from the
    // socket, so handlers that do their work in `req.on("end", …)` (or a body parser) would lose the
    // collector. Emitting the request's and response's own events inside it keeps them in.
    for (const emitter of [request, response]) {
      const emit = emitter.emit;
      emitter.emit = function (this: typeof emitter, ...args: Parameters<typeof emit>) {
        return storage.run(c, () => emit.apply(this, args));
      } as typeof emit;
    }
    attach(response, c);
  });

  const pending = new WeakMap<object, Pending>();

  if (options.http) {
    // `created` fires in the ClientRequest constructor, before the caller writes the body (`start` fires later).
    on("http.client.request.created", ({ request }: { request: http.ClientRequest }) => {
      const c = storage.getStore();
      if (!c || c.sealed) return;
      const host = request.getHeader("host") ?? request.host;
      const url = `${request.protocol}//${String(host)}${request.path}`;
      if (options.ignoreUrl?.(url)) return;
      const effect: Pending = { type: "http", method: request.method, url, chunks: [] };
      c.effects.push(effect);
      pending.set(request, effect);
      let size = 0;
      const keep = (chunk: unknown, encoding?: unknown) => {
        if (chunk === undefined || chunk === null || typeof chunk === "function") return;
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string, typeof encoding === "string" ? (encoding as BufferEncoding) : "utf8");
        if (size < options.maxBodyBytes) effect.chunks?.push(buf.subarray(0, options.maxBodyBytes - size));
        size += buf.length;
      };
      const { write, end } = request;
      request.write = function (this: http.ClientRequest, chunk: unknown, ...rest: unknown[]) {
        keep(chunk, rest[0]);
        return (write as (...a: unknown[]) => boolean).call(this, chunk, ...rest);
      } as typeof request.write;
      request.end = function (this: http.ClientRequest, chunk?: unknown, ...rest: unknown[]) {
        keep(chunk, rest[0]);
        finishBody(effect);
        return (end as (...a: unknown[]) => http.ClientRequest).call(this, chunk, ...rest);
      } as typeof request.end;
    });
    on("http.client.response.finish", ({ request, response }: { request: http.ClientRequest; response: http.IncomingMessage }) => {
      const e = pending.get(request);
      if (e && response.statusCode !== undefined) e.status = response.statusCode;
    });
    on("http.client.request.error", ({ request, error }: { request: http.ClientRequest; error: Error }) => {
      const e = pending.get(request);
      if (e) e.error = (error as NodeJS.ErrnoException).code ?? error.message;
    });
  }

  if (options.fetch) {
    type UndiciRequest = { method: string; origin: string; path: string };
    on("undici:request:create", ({ request }: { request: UndiciRequest }) => {
      const c = storage.getStore();
      if (!c || c.sealed) return;
      const url = `${request.origin}${request.path}`;
      if (options.ignoreUrl?.(url)) return;
      const effect: Pending = { type: "http", method: request.method, url, chunks: [] };
      c.effects.push(effect);
      pending.set(request, effect);
    });
    on("undici:request:bodyChunkSent", ({ request, chunk }: { request: UndiciRequest; chunk: Uint8Array | string }) => {
      const e = pending.get(request);
      if (!e?.chunks) return;
      const size = e.chunks.reduce((n, b) => n + b.length, 0);
      if (size < options.maxBodyBytes) e.chunks.push(Buffer.from(chunk).subarray(0, options.maxBodyBytes - size));
    });
    on("undici:request:bodySent", ({ request }: { request: UndiciRequest }) => {
      const e = pending.get(request);
      if (e) finishBody(e);
    });
    on("undici:request:headers", ({ request, response }: { request: UndiciRequest; response: { statusCode: number } }) => {
      const e = pending.get(request);
      if (!e) return;
      finishBody(e);
      e.status = response.statusCode;
    });
    on("undici:request:error", ({ request, error }: { request: UndiciRequest; error: Error }) => {
      const e = pending.get(request);
      if (!e) return;
      finishBody(e);
      e.error = (error as NodeJS.ErrnoException).code ?? error.message;
    });
  }
  return uninstall;
}

function uninstall(): void {
  for (const [channel, handler] of subscriptions.splice(0)) dc.unsubscribe(channel, handler);
  installed = false;
}

type AnyFn = (...args: unknown[]) => unknown;

/**
 * Record every call of `methods` on a database client as a query effect: works for `pg` (Client, Pool),
 * `mysql2` and anything else called as `query(text | { text | sql, values }, values?)`.
 *
 * ```js
 * instrumentQueries(pool, { db: "postgres" });
 * ```
 */
export function instrumentQueries<T extends object>(client: T, opts: { db: string; methods?: string[] }): T {
  for (const name of opts.methods ?? ["query"]) {
    const fn = (client as Record<string, unknown>)[name];
    if (typeof fn !== "function") throw new TypeError(`instrumentQueries: ${name} is not a function on this client`);
    (client as Record<string, unknown>)[name] = function (this: unknown, ...args: unknown[]) {
      const [first, second] = args;
      const config = first !== null && typeof first === "object" ? (first as { text?: unknown; sql?: unknown; values?: unknown }) : null;
      const query = config ? (config.text ?? config.sql) : first;
      const params = Array.isArray(second) ? second : config && Array.isArray(config.values) ? config.values : undefined;
      if (typeof query === "string") recordEffect({ type: "query", db: opts.db, query, ...(params ? { params } : {}) });
      return (fn as AnyFn).apply(this, args);
    };
  }
  return client;
}

/** Minimal shape of `node:sqlite`'s DatabaseSync used here. */
interface SqliteDatabase {
  prepare(sql: string): object;
  exec(sql: string): unknown;
}

/**
 * Record queries run through a `node:sqlite` DatabaseSync (`prepare(sql).run/get/all/iterate(...)` and
 * `exec`), with their parameters.
 */
export function instrumentSqlite<T extends SqliteDatabase>(db: T, opts: { db?: string } = {}): T {
  const name = opts.db ?? "sqlite";
  const prepare = db.prepare.bind(db);
  const exec = db.exec.bind(db);
  db.prepare = (sql: string) => {
    const stmt = prepare(sql) as Record<string, unknown>;
    for (const method of ["run", "get", "all", "iterate"]) {
      const fn = stmt[method];
      if (typeof fn !== "function") continue;
      stmt[method] = (...params: unknown[]) => {
        recordEffect({ type: "query", db: name, query: sql, ...(params.length > 0 ? { params } : {}) });
        return (fn as AnyFn).apply(stmt, params);
      };
    }
    return stmt;
  };
  db.exec = (sql: string) => {
    recordEffect({ type: "query", db: name, query: sql });
    return exec(sql);
  };
  return db;
}
