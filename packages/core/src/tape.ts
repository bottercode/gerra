/** Version of the tape line format. Bump on breaking changes. */
export const TAPE_VERSION = 1;

/** A body is stored as UTF-8 text when possible, otherwise base64. */
export interface RecordedBody {
  encoding: "utf8" | "base64";
  data: string;
  /** Set when the body exceeded the recorder's size limit; `data` then holds only the first bytes. */
  truncated?: true;
}

export interface RecordedRequest {
  method: string;
  /** Path without the query string, e.g. "/cart/price". */
  path: string;
  /** Raw query string without the leading "?", or "" if none. */
  query: string;
  headers: Record<string, string>;
  body: RecordedBody | null;
}

export interface RecordedResponse {
  status: number;
  headers: Record<string, string>;
  body: RecordedBody | null;
}

/** One request/response pair: a single line in a `.jsonl` tape. */
export interface Exchange {
  v: typeof TAPE_VERSION;
  /** Unique id within the tape. */
  id: string;
  /** ISO-8601 time the request arrived. */
  at: string;
  request: RecordedRequest;
  response: RecordedResponse;
  latencyMs: number;
}

/** Headers masked at record time unless configured otherwise. */
export const DEFAULT_MASKED_HEADERS = ["authorization", "cookie", "set-cookie"] as const;

export const MASK = "[gerra:masked]";

export function maskHeaders(
  headers: Record<string, string>,
  masked: readonly string[] = DEFAULT_MASKED_HEADERS,
): Record<string, string> {
  const lower = new Set(masked.map((h) => h.toLowerCase()));
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = lower.has(key.toLowerCase()) ? MASK : value;
  }
  return out;
}

/**
 * Replace the value of every object key named in `fields` (case-insensitive, at any depth) with MASK.
 * Returns the input unchanged (same reference) when nothing matched.
 */
export function maskJsonFields(value: unknown, fields: readonly string[]): unknown {
  if (fields.length === 0) return value;
  const lower = new Set(fields.map((f) => f.toLowerCase()));
  const walk = (v: unknown): unknown => {
    if (Array.isArray(v)) {
      const mapped = v.map(walk);
      return mapped.some((x, i) => x !== v[i]) ? mapped : v;
    }
    if (v !== null && typeof v === "object") {
      let changed = false;
      const out: Record<string, unknown> = {};
      for (const [key, inner] of Object.entries(v)) {
        const next = lower.has(key.toLowerCase()) ? MASK : walk(inner);
        if (next !== inner) changed = true;
        out[key] = next;
      }
      return changed ? out : v;
    }
    return v;
  };
  return walk(value);
}

/**
 * Mask JSON fields inside a recorded body. Non-JSON, binary and truncated bodies are returned as-is.
 * The body is only re-serialized when something was actually masked, so untouched bodies stay byte-identical.
 */
export function maskBodyFields(body: RecordedBody | null, fields: readonly string[]): RecordedBody | null {
  if (body === null || fields.length === 0 || body.encoding !== "utf8" || body.truncated) return body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.data);
  } catch {
    return body;
  }
  const masked = maskJsonFields(parsed, fields);
  return masked === parsed ? body : { encoding: "utf8", data: JSON.stringify(masked) };
}

export function encodeBody(buf: Buffer): RecordedBody | null {
  if (buf.length === 0) return null;
  const text = buf.toString("utf8");
  // Round-trip check: only store as utf8 if it decodes losslessly.
  return Buffer.from(text, "utf8").equals(buf)
    ? { encoding: "utf8", data: text }
    : { encoding: "base64", data: buf.toString("base64") };
}

export function decodeBody(body: RecordedBody | null): Buffer {
  if (body === null) return Buffer.alloc(0);
  return Buffer.from(body.data, body.encoding);
}

export function serializeExchange(ex: Exchange): string {
  return JSON.stringify(ex);
}

export function parseTape(contents: string): Exchange[] {
  return contents
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line, i) => {
      const ex = JSON.parse(line) as Exchange;
      if (ex.v !== TAPE_VERSION) {
        throw new Error(`tape line ${i + 1}: unsupported version ${String(ex.v)}`);
      }
      return ex;
    });
}

/** An exchange with headers and JSON body fields masked, as it should be written to disk. */
export function maskExchange(ex: Exchange, headers: readonly string[] = DEFAULT_MASKED_HEADERS, fields: readonly string[] = []): Exchange {
  return {
    ...ex,
    request: { ...ex.request, headers: maskHeaders(ex.request.headers, headers), body: maskBodyFields(ex.request.body, fields) },
    response: { ...ex.response, headers: maskHeaders(ex.response.headers, headers), body: maskBodyFields(ex.response.body, fields) },
  };
}
