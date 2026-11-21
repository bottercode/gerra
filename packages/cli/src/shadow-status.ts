import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ShadowRoute, ShadowState } from "./shadow.js";

export async function readShadowState(dir: string): Promise<ShadowState | null> {
  try {
    return JSON.parse(await readFile(join(dir, "state.json"), "utf8")) as ShadowState;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

/** Whether the process that wrote the state is still alive (a crashed shadow can't mark itself stopped). */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function pct(n: number, of: number): string {
  if (of === 0) return "0%";
  const p = (n / of) * 100;
  return `${Number(p.toFixed(p < 10 ? 2 : 1))}%`;
}

function duration(ms: number): string {
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}h${m}m` : m > 0 ? `${m}m${s % 60}s` : `${s}s`;
}

function ms(n: number): string {
  return n >= 100 ? `${Math.round(n)}ms` : `${Math.round(n * 100) / 100}ms`;
}

function value(v: unknown): string {
  if (v === undefined) return "(none)";
  const s = JSON.stringify(v);
  return s.length > 60 ? `${s.slice(0, 59)}…` : s;
}

function routeLine(r: ShadowRoute): string[] {
  const bad = r.different + r.candidateErrors > 0;
  const parts = [`${r.compared} compared`];
  if (r.different) parts.push(`${r.different} different (${pct(r.different, r.compared)})`);
  if (r.candidateErrors) parts.push(`${r.candidateErrors} errors`);
  if (r.skipped) parts.push(`${r.skipped} skipped`);
  if (r.dropped) parts.push(`${r.dropped} dropped`);
  const lines = [`  ${bad ? "✗" : r.compared > 0 ? "✓" : "–"} ${r.route}  (${parts.join(", ")})`];
  for (const m of r.mismatches.slice(0, 5)) lines.push(`      ${m.at}  ×${m.count}`);
  for (const e of r.errors.slice(0, 3)) lines.push(`      error: ${e.message}  ×${e.count}`);
  if (r.ignored.length > 0) lines.push(`      ignored: ${r.ignored.map((i) => `${i.at} ×${i.count} (${i.reason})`).join(", ")}`);
  return lines;
}

/** Human-readable status: what's running, counters, per-route problems, and the latest differences. */
export function formatShadowState(state: ShadowState, alive: boolean, now = Date.now()): string {
  const c = state.counts;
  const status = state.running && alive ? `running (pid ${state.pid})` : state.running ? "not running (process exited without stopping cleanly)" : "stopped";
  const end = state.running && alive ? now : Date.parse(state.updatedAt);
  const out = [
    `shadow "${state.name}": ${status}, ${duration(end - Date.parse(state.startedAt))} since ${state.startedAt}` +
      (state.running && alive ? ` (counters as of ${duration(Math.max(0, now - Date.parse(state.updatedAt)))} ago)` : ""),
    `  ${state.listen} → primary ${state.primary}, mirrored to candidate ${state.candidate}`,
    `  ${c.requests} requests: ${c.compared} compared, ${c.identical} identical, ${c.different} different (${pct(c.different, c.compared)}), ` +
      `${c.candidateErrors} candidate errors, ${c.skipped} skipped, ${c.dropped} dropped`,
  ];
  const { primary: p, candidate: k } = state.latency;
  if (p && k) out.push(`  latency  p50 ${ms(p.p50)} → ${ms(k.p50)}   p95 ${ms(p.p95)} → ${ms(k.p95)}   (primary → candidate, last ${k.count})`);
  if (state.routes.length > 0) out.push("", ...state.routes.flatMap(routeLine));
  if (state.recent.length > 0) {
    out.push("", "Recent:");
    for (const e of state.recent.slice(0, 10)) {
      const time = e.time.slice(11, 19);
      if (e.error) {
        out.push(`  ${time}  ${e.request}  candidate error: ${e.error}`);
        continue;
      }
      const first = e.mismatches?.[0];
      const more = (e.mismatches?.length ?? 0) > 1 ? ` (+${(e.mismatches?.length ?? 1) - 1} more)` : "";
      const note = first?.note ? ` (${first.note})` : "";
      out.push(`  ${time}  ${e.request}  ${first?.at}: ${value(first?.original)} → ${value(first?.candidate)}${note}${more}   [${e.id.slice(0, 11)}]`);
    }
  }
  out.push("", `Full differences: ${state.log}`);
  return out.join("\n");
}
