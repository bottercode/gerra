import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { NoiseProfile } from "@gerra/core";
import { assertTapeName } from "./tapes.js";

export const DEFAULT_NOISE_DIR = join(".gerra", "noise");

/** Learned noise for a tape lives in `<dir>/<tape>.json` and is applied to later replays of that tape. */
export function noisePath(dir: string, tape: string): string {
  assertTapeName(tape);
  return join(dir, `${tape}.json`);
}

export async function saveNoise(dir: string, tape: string, profile: NoiseProfile): Promise<string> {
  const path = noisePath(dir, tape);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(profile, null, 2) + "\n");
  return path;
}

export async function loadNoise(dir: string, tape: string): Promise<NoiseProfile | null> {
  try {
    return JSON.parse(await readFile(noisePath(dir, tape), "utf8")) as NoiseProfile;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}
