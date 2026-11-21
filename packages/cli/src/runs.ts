import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseRun, serializeRun, type Run } from "gerra-core";
import { assertTapeName } from "./tapes.js";

export const DEFAULT_RUNS_DIR = join(".gerra", "runs");

/** Runs of a tape live in `<dir>/<tape>/<startedAt>.jsonl`; ISO times sort chronologically by name. */
export function runPath(dir: string, tape: string, startedAt: string): string {
  assertTapeName(tape);
  return join(dir, tape, `${startedAt.replace(/:/g, "-")}.jsonl`);
}

export async function saveRun(dir: string, run: Run): Promise<string> {
  const path = runPath(dir, run.header.tape, run.header.startedAt);
  await mkdir(join(dir, run.header.tape), { recursive: true });
  await writeFile(path, serializeRun(run));
  return path;
}

/** Path of the most recent run of `tape`, or null if it was never replayed. */
export async function latestRunPath(dir: string, tape: string): Promise<string | null> {
  assertTapeName(tape);
  let files: string[];
  try {
    files = await readdir(join(dir, tape));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
  const last = files.filter((f) => f.endsWith(".jsonl")).sort().at(-1);
  return last ? join(dir, tape, last) : null;
}

export async function loadRun(path: string): Promise<Run> {
  return parseRun(await readFile(path, "utf8"));
}
