// Side effects: what a service did while answering a request (outbound HTTP calls, database queries), as
// reported by the service itself. gerra asks for them with a request header and the service answers with a
// response header; see docs/effects.md for the protocol. @gerra/sdk-node implements it for Node services.

/** Request header gerra sends to ask for effects (value "1"), and response header carrying them. */
export const EFFECTS_HEADER = "x-gerra-effects";

/**
 * One thing the service did. Common shapes:
 * - `{ type: "http", method: "POST", url: "https://hooks.example.com/x", body: {...}, status: 200 }`
 * - `{ type: "query", db: "postgres", query: "select * from posts where id = $1", params: [42] }`
 *
 * Any other `type` is allowed; effects are compared as JSON.
 */
export interface Effect {
  type: string;
  [key: string]: unknown;
}

/** Header value for a list of effects: base64url of its JSON. */
export function encodeEffects(effects: readonly Effect[]): string {
  return Buffer.from(JSON.stringify(effects), "utf8").toString("base64url");
}

/** Parse an effects header value. Returns null if it isn't a valid list of effects. */
export function decodeEffects(value: string | undefined): Effect[] | null {
  if (value === undefined) return null;
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value.trim(), "base64url").toString("utf8"));
    if (!Array.isArray(parsed)) return null;
    if (parsed.some((e) => e === null || typeof e !== "object" || Array.isArray(e) || typeof (e as { type?: unknown }).type !== "string")) return null;
    return parsed as Effect[];
  } catch {
    return null;
  }
}

/**
 * Take the effects header out of a response's headers (it's for gerra, not for clients) and decode it.
 * Mutates `headers`. Header names are matched case-insensitively.
 */
export function takeEffects(headers: Record<string, unknown>): Effect[] | null {
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() !== EFFECTS_HEADER) continue;
    const raw = headers[key];
    delete headers[key];
    return decodeEffects(Array.isArray(raw) ? String(raw[0]) : raw === undefined ? undefined : String(raw));
  }
  return null;
}
