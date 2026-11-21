import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseTape, summarizeRoutes, type RouteSummary } from "@gerra/core";

export const DEFAULT_TAPES_DIR = join(".gerra", "tapes");

const TAPE_NAME = /^[A-Za-z0-9][\w.-]*$/;

/** Tape names become file names, so keep them to a safe character set. */
export function assertTapeName(name: string): void {
  if (!TAPE_NAME.test(name)) {
    throw new Error(`invalid tape name "${name}": use letters, digits, ".", "_" or "-"`);
  }
}

export function tapePath(dir: string, name: string): string {
  assertTapeName(name);
  return join(dir, `${name}.jsonl`);
}

export interface TapeInfo {
  name: string;
  path: string;
  sizeBytes: number;
  exchanges: number;
  firstAt: string | null;
  lastAt: string | null;
  routes: RouteSummary[];
  /** Set when the tape could not be parsed (e.g. a line cut off by a crash). */
  error?: string;
}

export async function readTapeInfo(path: string): Promise<TapeInfo> {
  const name = basename(path, ".jsonl");
  const sizeBytes = (await stat(path)).size;
  try {
    const exchanges = parseTape(await readFile(path, "utf8"));
    return {
      name,
      path,
      sizeBytes,
      exchanges: exchanges.length,
      firstAt: exchanges[0]?.at ?? null,
      lastAt: exchanges.at(-1)?.at ?? null,
      routes: summarizeRoutes(exchanges),
    };
  } catch (err) {
    return { name, path, sizeBytes, exchanges: 0, firstAt: null, lastAt: null, routes: [], error: (err as Error).message };
  }
}

/** All `*.jsonl` tapes in `dir`, sorted by name. A missing directory means no tapes. */
export async function listTapes(dir: string): Promise<TapeInfo[]> {
  let files: string[];
  try {
    files = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  const tapes = files.filter((f) => f.endsWith(".jsonl")).sort();
  return Promise.all(tapes.map((f) => readTapeInfo(join(dir, f))));
}

function formatStatuses(statuses: Record<string, number>): string {
  return Object.entries(statuses)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([status, n]) => `${status}×${n}`)
    .join(" ");
}

export function formatTapes(tapes: readonly TapeInfo[], dir: string): string {
  if (tapes.length === 0) {
    return `No tapes in ${dir}. Record one with: gerra record --target http://localhost:3000 --tape <name>`;
  }
  const blocks = tapes.map((t) => {
    if (t.error) return `${t.name}  (unreadable: ${t.error})\n  ${t.path}`;
    const header = `${t.name}  ${t.exchanges} exchange${t.exchanges === 1 ? "" : "s"}, ${t.routes.length} route${
      t.routes.length === 1 ? "" : "s"
    }  ${t.path}`;
    const width = Math.max(0, ...t.routes.map((r) => r.route.length));
    const countWidth = Math.max(0, ...t.routes.map((r) => String(r.count).length));
    const rows = t.routes.map(
      (r) => `  ${String(r.count).padStart(countWidth)}  ${r.route.padEnd(width)}  ${formatStatuses(r.statuses)}`,
    );
    return [header, ...rows].join("\n");
  });
  return blocks.join("\n\n");
}
