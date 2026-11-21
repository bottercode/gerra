// A minimal Model Context Protocol server: JSON-RPC 2.0 over newline-delimited stdio, tools only.
// Hand-written instead of using the SDK to keep gerra dependency-free; it implements just what tool
// servers need: initialize, ping, tools/list and tools/call.

/** Protocol versions this server speaks, newest first. */
export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"] as const;

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface Tool {
  name: string;
  description: string;
  /** JSON Schema for the arguments object. */
  inputSchema: Record<string, unknown>;
  annotations?: ToolAnnotations;
  /** Returns the text shown to the agent. Throw `ToolError` (or any error) to report a failure. */
  run(args: Record<string, unknown>): Promise<string>;
}

/** A failure the agent should see and can act on (bad arguments, no such tape, …). */
export class ToolError extends Error {}

type Id = string | number;
interface Request {
  jsonrpc: "2.0";
  id?: Id | null;
  method: string;
  params?: Record<string, unknown>;
}
export type Response =
  | { jsonrpc: "2.0"; id: Id | null; result: unknown }
  | { jsonrpc: "2.0"; id: Id | null; error: { code: number; message: string } };

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

export interface ServerInfo {
  name: string;
  version: string;
  /** Shown to the agent on connect: how to use these tools. */
  instructions?: string;
}

/** Handles one parsed message. Returns the response, or null for notifications. */
export function createHandler(info: ServerInfo, tools: readonly Tool[]) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const error = (id: Id | null, code: number, message: string): Response => ({ jsonrpc: "2.0", id, error: { code, message } });

  return async function handle(message: unknown): Promise<Response | null> {
    if (message === null || typeof message !== "object" || Array.isArray(message)) {
      return error(null, INVALID_REQUEST, "expected a JSON-RPC object");
    }
    const req = message as Request;
    const isNotification = req.id === undefined;
    if (req.jsonrpc !== "2.0" || typeof req.method !== "string") {
      return isNotification ? null : error(req.id ?? null, INVALID_REQUEST, "invalid JSON-RPC 2.0 request");
    }
    if (isNotification) return null; // notifications/initialized, notifications/cancelled, …
    const id = req.id as Id | null;
    const ok = (result: unknown): Response => ({ jsonrpc: "2.0", id, result });

    switch (req.method) {
      case "initialize": {
        const requested = req.params?.protocolVersion;
        const version = PROTOCOL_VERSIONS.find((v) => v === requested) ?? PROTOCOL_VERSIONS[0];
        return ok({
          protocolVersion: version,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: info.name, version: info.version },
          ...(info.instructions ? { instructions: info.instructions } : {}),
        });
      }
      case "ping":
        return ok({});
      case "tools/list":
        return ok({
          tools: tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, ...(t.annotations ? { annotations: t.annotations } : {}) })),
        });
      case "tools/call": {
        const name = req.params?.name;
        const args = req.params?.arguments ?? {};
        const tool = typeof name === "string" ? byName.get(name) : undefined;
        if (!tool) return error(id, INVALID_PARAMS, `unknown tool: ${String(name)}`);
        if (args === null || typeof args !== "object" || Array.isArray(args)) return error(id, INVALID_PARAMS, "arguments must be an object");
        try {
          const text = await tool.run(args as Record<string, unknown>);
          return ok({ content: [{ type: "text", text }], isError: false });
        } catch (err) {
          // Tool failures are results the agent can read and react to, not protocol errors.
          return ok({ content: [{ type: "text", text: `Error: ${(err as Error).message}` }], isError: true });
        }
      }
      default:
        return error(id, METHOD_NOT_FOUND, `method not found: ${req.method}`);
    }
  };
}

/** Serve over stdin/stdout. Logs must go to stderr: stdout carries only protocol messages. */
export function serveStdio(info: ServerInfo, tools: readonly Tool[], input = process.stdin, output = process.stdout): Promise<void> {
  const handle = createHandler(info, tools);
  const write = (r: Response) => output.write(JSON.stringify(r) + "\n");
  let buffer = "";
  const pending = new Set<Promise<void>>();
  input.setEncoding("utf8");
  input.on("data", (chunk: string) => {
    buffer += chunk;
    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (line === "") continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        write({ jsonrpc: "2.0", id: null, error: { code: PARSE_ERROR, message: "parse error" } });
        continue;
      }
      // Calls run concurrently (a replay can take seconds); JSON-RPC responses may arrive in any order.
      const p = handle(message).then((r) => {
        if (r) write(r);
      });
      pending.add(p);
      void p.finally(() => pending.delete(p));
    }
  });
  return new Promise((resolve) => input.on("end", () => void Promise.all(pending).then(() => resolve())));
}
