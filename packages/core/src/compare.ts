import { brotliDecompressSync, gunzipSync, inflateSync, zstdDecompressSync } from "node:zlib";
import { diffJson, groupKey, type Json } from "./diff.js";
import { DEFAULT_COMPARED_HEADERS, normalizeRule, normalizedBy, ruleMatches, type CompareRules, type IgnoreReason } from "./rules.js";
import { MASK, decodeBody, type RecordedResponse } from "./tape.js";

/** One way a candidate response differs from the recorded one. */
export interface Mismatch {
  /**
   * Where it differs: `status`, `header content-type`, `body $.total` (JSON path),
   * `body (text)`, `body (bytes)` or `body` (different kinds of body, e.g. JSON vs empty).
   */
  at: string;
  kind: "changed" | "missing" | "added" | "type";
  original: unknown;
  candidate: unknown;
  /** Extra context, e.g. `line 3` for text bodies. */
  note?: string;
  /** Set when the difference is expected (config rule, learned noise or a normalizer) and doesn't count. */
  ignored?: IgnoreReason;
}

/** How to compare: headers, ignore rules, noise, normalizers, unordered arrays. */
export type CompareOptions = CompareRules;

/**
 * Compare a candidate response with the recorded one. Every difference is returned; the ones that
 * don't count carry `ignored`. Use {@link realMismatches} for the ones that do.
 */
export function compareResponses(
  original: RecordedResponse,
  candidate: RecordedResponse,
  options: CompareOptions = {},
): Mismatch[] {
  const raw = rawMismatches(original, candidate, options);
  const config = (options.ignore ?? []).map(normalizeRule);
  const noise = (options.noise ?? []).map(normalizeRule);
  for (const m of raw) {
    const reason: IgnoreReason | null = config.some((r) => ruleMatches(r, m.at))
      ? "config"
      : noise.some((r) => ruleMatches(r, m.at))
        ? "noise"
        : m.kind === "changed" || m.kind === "type"
          ? normalizedBy(m.at, m.original, m.candidate, options.normalizers)
          : null;
    if (reason) m.ignored = reason;
  }
  return raw;
}

/** Differences that count. */
export function realMismatches(mismatches: readonly Mismatch[]): Mismatch[] {
  return mismatches.filter((m) => !m.ignored);
}

function rawMismatches(original: RecordedResponse, candidate: RecordedResponse, options: CompareOptions): Mismatch[] {
  const out: Mismatch[] = [];
  if (original.status !== candidate.status) {
    out.push({ at: "status", kind: "changed", original: original.status, candidate: candidate.status });
  }
  for (const name of options.headers ?? DEFAULT_COMPARED_HEADERS) {
    const m = compareHeader(name.toLowerCase(), original.headers, candidate.headers);
    if (m) out.push(m);
  }
  const unordered = new Set((options.unordered ?? []).map((p) => groupKey(normalizeRule(p).replace(/^body /, ""))));
  out.push(...compareBodies(original, candidate, unordered));
  return out;
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) if (key.toLowerCase() === name) return value;
  return undefined;
}

function normalizeHeader(name: string, value: string): string {
  const v = value.trim();
  if (name !== "content-type") return v;
  // `application/json; charset=UTF-8` and `application/json;charset=utf-8` mean the same thing, and JSON is
  // always UTF-8 (RFC 8259), so Express's `; charset=utf-8` vs a bare `application/json` is not a difference.
  const [type = "", ...params] = v.toLowerCase().split(";").map((p) => p.trim());
  const json = type === "application/json" || type.endsWith("+json");
  const kept = params.filter((p) => p !== "" && !(json && p.replace(/\s|"/g, "") === "charset=utf-8"));
  return [type, ...kept].join("; ");
}

function compareHeader(name: string, a: Record<string, string>, b: Record<string, string>): Mismatch | null {
  const va = headerValue(a, name);
  const vb = headerValue(b, name);
  if (va === MASK) return null;
  if (va === undefined && vb === undefined) return null;
  const at = `header ${name}`;
  if (va === undefined) return { at, kind: "added", original: undefined, candidate: vb };
  if (vb === undefined) return { at, kind: "missing", original: va, candidate: undefined };
  return normalizeHeader(name, va) === normalizeHeader(name, vb) ? null : { at, kind: "changed", original: va, candidate: vb };
}

const DECOMPRESS: Record<string, (b: Buffer) => Buffer> = {
  gzip: gunzipSync,
  "x-gzip": gunzipSync,
  deflate: inflateSync,
  br: brotliDecompressSync,
  zstd: zstdDecompressSync,
};

/**
 * The body as the client sees it after undoing `content-encoding`. Tapes store bytes as they were on the wire,
 * so a gzip response from the original and an uncompressed one from the candidate still compare equal.
 * Truncated or undecodable bodies are returned as-is.
 */
export function decodedBody(res: RecordedResponse): { bytes: Buffer; truncated: boolean } {
  const raw = decodeBody(res.body);
  const truncated = res.body?.truncated === true;
  const encoding = headerValue(res.headers, "content-encoding")?.trim().toLowerCase();
  if (!encoding || encoding === "identity" || truncated || raw.length === 0) return { bytes: raw, truncated };
  try {
    // Multiple codings are applied in order, so undo them in reverse.
    let bytes = raw;
    for (const coding of encoding.split(",").map((c) => c.trim()).reverse()) {
      const fn = DECOMPRESS[coding];
      if (!fn) return { bytes: raw, truncated };
      bytes = fn(bytes);
    }
    return { bytes, truncated };
  } catch {
    return { bytes: raw, truncated };
  }
}

type BodyKind = { kind: "empty" } | { kind: "json"; value: Json } | { kind: "text"; text: string } | { kind: "binary" };

function classify(bytes: Buffer): BodyKind {
  if (bytes.length === 0) return { kind: "empty" };
  const text = bytes.toString("utf8");
  if (!Buffer.from(text, "utf8").equals(bytes)) return { kind: "binary" };
  try {
    return { kind: "json", value: JSON.parse(text) as Json };
  } catch {
    return { kind: "text", text };
  }
}

function describe(kind: BodyKind["kind"], size: number): string {
  return kind === "empty" ? "empty" : `${kind === "json" ? "JSON" : kind}, ${size} bytes`;
}

function compareBodies(original: RecordedResponse, candidate: RecordedResponse, unorderedPaths: ReadonlySet<string>): Mismatch[] {
  const a = decodedBody(original);
  let b = decodedBody(candidate).bytes;
  // Only a prefix of the original was recorded: compare the same prefix of the candidate.
  if (a.truncated) b = b.subarray(0, a.bytes.length);
  if (a.bytes.equals(b)) return [];

  const ka = classify(a.bytes);
  const kb = classify(b);
  if (ka.kind === "json" && kb.kind === "json") {
    return diffJson(ka.value, kb.value, { maskedValue: MASK, unorderedPaths }).map((d) => ({
      at: `body ${d.path}`,
      kind: d.kind,
      original: d.original,
      candidate: d.candidate,
    }));
  }
  const textual = (k: BodyKind) => k.kind === "json" || k.kind === "text";
  if (textual(ka) && textual(kb)) return [compareText(a.bytes.toString("utf8"), b.toString("utf8"))];
  if (ka.kind === "binary" && kb.kind === "binary") {
    let i = 0;
    while (i < a.bytes.length && i < b.length && a.bytes[i] === b[i]) i++;
    return [
      {
        at: "body (bytes)",
        kind: "changed",
        original: `${a.bytes.length} bytes`,
        candidate: `${b.length} bytes`,
        note: `first difference at byte ${i}`,
      },
    ];
  }
  return [{ at: "body", kind: "type", original: describe(ka.kind, a.bytes.length), candidate: describe(kb.kind, b.length) }];
}

/** Report the first differing line; that's usually enough to see what went wrong. */
function compareText(a: string, b: string): Mismatch {
  const la = a.split("\n");
  const lb = b.split("\n");
  let i = 0;
  while (i < la.length && i < lb.length && la[i] === lb[i]) i++;
  const clip = (s: string | undefined) => (s === undefined ? undefined : s.length > 200 ? `${s.slice(0, 200)}…` : s);
  return {
    at: "body (text)",
    kind: i >= lb.length ? "missing" : i >= la.length ? "added" : "changed",
    original: clip(la[i]),
    candidate: clip(lb[i]),
    note: `line ${i + 1}`,
  };
}
