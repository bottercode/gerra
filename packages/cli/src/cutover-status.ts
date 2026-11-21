import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { CutoverState, Thresholds } from "./cutover.js";

export async function readCutoverState(dir: string): Promise<CutoverState | null> {
  try {
    return JSON.parse(await readFile(join(dir, "state.json"), "utf8")) as CutoverState;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** `90s`, `5m`, `1h`, `500ms`; a bare number is seconds. */
export function parseDuration(value: string): number {
  const m = /^(\d+(?:\.\d+)?)(ms|s|m|h)?$/.exec(value.trim());
  if (!m) throw new Error(`invalid duration "${value}" (use e.g. 30s, 5m, 1h)`);
  const n = Number(m[1]);
  const unit = m[2] ?? "s";
  return Math.round(n * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[unit as "ms" | "s" | "m" | "h"]);
}

/** `1%` or `1` → 0.01. */
export function parseRate(value: string): number {
  const m = /^(\d+(?:\.\d+)?)%?$/.exec(value.trim());
  const n = m ? Number(m[1]) : NaN;
  if (!(n >= 0 && n <= 100)) throw new Error(`invalid rate "${value}" (use a percentage, e.g. 1%)`);
  return n / 100;
}

/** `250ms` / `250` → absolute, `2x` → relative to the primary, `off` → disabled. */
export function parseP99(value: string): Thresholds["p99"] {
  const v = value.trim().toLowerCase();
  if (v === "off") return null;
  const ratio = /^(\d+(?:\.\d+)?)x$/.exec(v);
  if (ratio && Number(ratio[1]) > 0) return { ratio: Number(ratio[1]) };
  const ms = /^(\d+(?:\.\d+)?)(ms)?$/.exec(v);
  if (ms && Number(ms[1]) > 0) return { ms: Number(ms[1]) };
  throw new Error(`invalid --max-p99 "${value}" (use e.g. 250ms, 2x or off)`);
}

export function parseSteps(value: string): number[] {
  const steps = value.split(",").map((s) => Number(s.trim().replace(/%$/, "")));
  if (steps.some((n) => !Number.isFinite(n))) throw new Error(`invalid --steps "${value}" (use e.g. 1,10,50,100)`);
  return steps;
}

function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

function rate(n: number, of: number): string {
  return of === 0 ? "–" : `${Number(((n / of) * 100).toFixed(2))}%`;
}

function describeP99(t: Thresholds["p99"]): string {
  return t === null ? "off" : "ms" in t ? `${t.ms}ms` : `${t.ratio}× primary`;
}

/** One line for the live log: where we are and how the current step is doing. */
export function progressLine(s: CutoverState, now = Date.now()): string {
  const st = s.step;
  const p99 = st.p99.candidate === null ? "–" : `${st.p99.candidate.toFixed(1)}ms${st.p99.primary === null ? "" : ` (primary ${st.p99.primary.toFixed(1)}ms)`}`;
  const where =
    s.phase === "rolled_back"
      ? "ROLLED BACK, 0%"
      : s.phase === "complete"
        ? "complete, 100% on candidate"
        : `${s.weight}% · step ${s.stepIndex + 1}/${s.steps.length} · ${clock(now - Date.parse(s.stepStartedAt))}/${clock(s.holdMs)}`;
  return (
    `${where} · served candidate ${st.servedCandidate} / primary ${st.servedPrimary} · ` +
    `diff ${rate(st.different, st.compared)} of ${st.compared} · errors ${rate(st.candidateErrors, st.candidateCalls)} of ${st.candidateCalls} · p99 ${p99}`
  );
}

export function formatCutoverState(s: CutoverState, alive: boolean, now = Date.now()): string {
  const t = s.thresholds;
  const proc = s.running && alive ? `running (pid ${s.pid})` : s.running ? "not running (process exited without stopping cleanly)" : "stopped";
  const phase =
    s.phase === "rolled_back"
      ? `ROLLED BACK at ${s.rollback?.atWeight}%: ${s.rollback?.reason}`
      : s.phase === "complete"
        ? "complete: the candidate serves 100% of traffic"
        : `stepping: candidate serves ${s.weight}% (step ${s.stepIndex + 1} of ${s.steps.join("% → ")}%)`;
  const out = [
    `cutover "${s.name}": ${proc}, since ${s.startedAt}`,
    `  ${s.listen} → primary ${s.primary} / candidate ${s.candidate}`,
    `  ${phase}`,
    `  thresholds: diff ≤ ${rate(t.maxDiffRate, 1)}, errors ≤ ${rate(t.maxErrorRate, 1)}, p99 ≤ ${describeP99(t.p99)}, min ${t.minSamples} samples; hold ${clock(s.holdMs)} per step`,
    `  this step: ${progressLine(s, now)}`,
  ];
  const bad = s.routes.filter((r) => r.different + r.candidateErrors > 0);
  if (bad.length > 0) {
    out.push("", "Routes with problems:");
    for (const r of bad.slice(0, 10)) {
      out.push(`  ✗ ${r.route}  (${r.compared} compared, ${r.different} different, ${r.candidateErrors} candidate errors)`);
      for (const m of r.mismatches.slice(0, 3)) out.push(`      ${m.at}  ×${m.count}`);
    }
  }
  if (s.recent.length > 0) {
    out.push("", "Recent:");
    for (const d of s.recent.slice(0, 8)) {
      const m = d.mismatches?.[0];
      const what = d.error ? `candidate error: ${d.error}` : `${m?.at}: ${JSON.stringify(m?.original)} → ${JSON.stringify(m?.candidate)}`;
      out.push(`  ${d.time.slice(11, 19)}  ${d.request}  (user got ${d.served})  ${what}`);
    }
  }
  out.push("", "Events:");
  for (const e of [...s.events].reverse()) out.push(`  ${e.time.slice(11, 19)}  ${e.type.padEnd(8)} ${String(e.weight).padStart(3)}%  ${e.reason ?? ""}`);
  out.push("", `Full differences: ${s.log}`);
  return out.join("\n");
}
