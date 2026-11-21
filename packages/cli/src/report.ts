import type { ExchangeComparison } from "./api.js";
import type { IgnoredGroup, LatencyStats, NoiseProfile, ReplayReport, RouteReport, Sample } from "@gerra/core";

function clip(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** `raw` values are descriptions like `3 bytes` rather than data, so they aren't quoted. */
function value(v: unknown, raw: boolean): string {
  if (v === undefined) return "(none)";
  return clip(raw && typeof v === "string" ? v : JSON.stringify(v), 80);
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function routeCounts(r: RouteReport): string {
  const parts = [
    r.identical && `${r.identical} identical`,
    r.different && `${r.different} different`,
    r.errors && plural(r.errors, "error"),
    r.skipped && `${r.skipped} skipped`,
  ].filter(Boolean);
  return parts.join(", ");
}

function sampleLine(s: Sample, groupAt: string): string[] {
  const raw = groupAt === "body" || groupAt === "body (bytes)";
  const where = s.at ? ` at ${s.at}` : "";
  const change = "original" in s || "candidate" in s ? `: ${value(s.original, raw)} → ${value(s.candidate, raw)}` : "";
  const note = s.note ? ` (${s.note})` : "";
  const lines = [`      e.g. ${s.request}${where}${change}${note}   [${shortId(s.exchangeId)}]`];
  if (s.requestBody) lines.push(`           request body: ${clip(s.requestBody, 120)}`);
  return lines;
}

function ms(n: number): string {
  return n >= 100 ? `${Math.round(n)}ms` : `${Math.round(n * 100) / 100}ms`;
}

/** Below this many requests, percentiles are mostly warm-up and connection setup, so they aren't shown. */
const MIN_LATENCY_SAMPLES = 20;

function latencyLine(o: LatencyStats | null, c: LatencyStats | null): string | null {
  if (!o || !c || c.count < MIN_LATENCY_SAMPLES) return null;
  return `  latency  p50 ${ms(o.p50)} → ${ms(c.p50)}   p95 ${ms(o.p95)} → ${ms(c.p95)}   (recorded → candidate over ${c.count} requests; indicative, not a benchmark)`;
}

/** `ex_55df4f48-732e-…` → `ex_55df4f48`: enough to find the line in the tape. */
function shortId(id: string): string {
  return /^ex_[0-9a-f]{8}-/.test(id) ? id.slice(0, 11) : id;
}

const REASONS: Record<IgnoredGroup["reason"], string> = {
  noise: "noise",
  config: "config",
  timestamps: "timestamp",
  uuids: "uuid",
  ids: "id",
};

function ignoredLine(groups: readonly IgnoredGroup[]): string | null {
  if (groups.length === 0) return null;
  return `    ignored: ${groups.map((g) => `${g.at} ×${g.count} (${REASONS[g.reason]})`).join(", ")}`;
}

export interface ReportMetaForFormat {
  tape: string;
  against: string;
  config?: string | null;
  noise?: NoiseProfile | null;
}

/** Human-readable report: summary, then routes (problems first) with each place responses differ. */
export function formatReport(report: ReplayReport, meta: ReportMetaForFormat): string {
  const s = report.summary;
  const out = [
    `Tape "${meta.tape}" replayed against ${meta.against}`,
    `  ${plural(s.total, "exchange")}: ${s.identical} identical, ${s.different} different, ${plural(s.errors, "error")}, ${s.skipped} skipped`,
  ];
  const latency = latencyLine(report.latency.original, report.latency.candidate);
  if (latency) out.push(latency);
  if (meta.noise) {
    const n = Object.values(meta.noise.routes).reduce((sum, r) => sum + r.length, 0);
    out.push(`  noise    ${n} place${n === 1 ? "" : "s"} learned from ${meta.noise.learnedFrom} at ${meta.noise.learnedAt}`);
  }
  if (meta.config) out.push(`  config   ${meta.config}`);
  out.push("");

  for (const r of report.routes) {
    const mark = r.different + r.errors > 0 ? "✗" : r.identical > 0 ? "✓" : "–";
    out.push(`${mark} ${r.route}  (${routeCounts(r)})`);
    for (const g of r.mismatches) {
      out.push(`    ${g.at}  ×${g.count}`);
      const first = g.samples[0];
      if (first) out.push(...sampleLine(first, g.at));
    }
    for (const e of r.errorGroups) {
      out.push(`    error: ${e.message}  ×${e.count}`);
      const first = e.samples[0];
      if (first) out.push(...sampleLine(first, ""));
    }
    for (const [reason, n] of Object.entries(r.skipReasons)) out.push(`    skipped ×${n}: ${reason}`);
    const ignored = ignoredLine(r.ignored);
    if (ignored) out.push(ignored);
  }

  out.push("");
  const compared = s.identical + s.different;
  if (s.different + s.errors > 0) {
    out.push(`✗ Not equivalent: ${s.different} different, ${plural(s.errors, "error")} out of ${s.total - s.skipped} replayed.`);
  } else if (compared === 0) {
    out.push("Nothing was compared: every exchange was skipped.");
  } else {
    out.push(`✓ All ${compared} replayed exchanges match the tape.`);
  }
  return out.join("\n");
}

/** CI-friendly exit code: 0 only if something was compared and nothing differed or failed. */
export function exitCodeFor(report: ReplayReport): number {
  const s = report.summary;
  return s.different + s.errors > 0 || s.identical === 0 ? 1 : 0;
}

function bodyText(res: { headers: Record<string, string>; body: { encoding: string; data: string; truncated?: true } | null }, max = 2000): string {
  if (!res.body) return "(empty)";
  if (res.body.encoding === "base64") return `(${Buffer.from(res.body.data, "base64").length} bytes, base64${res.headers["content-encoding"] ? `, ${res.headers["content-encoding"]}` : ""})`;
  let text = res.body.data;
  try {
    text = JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    // not JSON: show as is
  }
  return (text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more characters)` : text) + (res.body.truncated ? "\n(truncated in the tape)" : "");
}

/** One exchange in detail: the request, the recorded and candidate answers, and the differences. */
export function formatExchangeComparison(c: ExchangeComparison): string {
  const q = c.request.query ? `?${c.request.query}` : "";
  const out = [`${c.id}  ${c.request.method} ${c.request.path}${q}  (route ${c.route})`];
  if (c.request.body) out.push("", "Request body:", bodyText({ headers: c.request.headers, body: c.request.body }));
  out.push("", `Recorded answer: ${c.recorded.status} ${c.recorded.headers["content-type"] ?? ""}`, bodyText(c.recorded));
  if (c.outcome === "replayed" && c.candidate) {
    out.push("", `Candidate answer: ${c.candidate.status} ${c.candidate.headers["content-type"] ?? ""}`, bodyText(c.candidate));
  } else {
    out.push("", `Candidate: ${c.outcome}${c.error ? ` (${c.error})` : ""}${c.reason ? ` (${c.reason})` : ""}`);
  }
  out.push("");
  if (c.mismatches.length === 0 && c.outcome === "replayed") out.push("✓ Equivalent.");
  for (const m of c.mismatches) out.push(`✗ ${m.at}: ${value(m.original, false)} → ${value(m.candidate, false)}${m.note ? ` (${m.note})` : ""}`);
  if (c.ignored.length > 0) out.push(`ignored: ${c.ignored.map((m) => `${m.at} (${m.ignored})`).join(", ")}`);
  out.push(`From run ${c.run}`);
  return out.join("\n");
}
