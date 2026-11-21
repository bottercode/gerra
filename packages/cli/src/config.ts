import { readFile } from "node:fs/promises";
import { parseConfig, type GerraConfig } from "@gerra/core";

export const DEFAULT_CONFIG_FILE = "gerra.config.json";

/**
 * Load `--config <path>` (must exist) or `./gerra.config.json` (optional).
 * Returns an empty config when there's no file.
 */
export async function loadConfig(explicit?: string): Promise<{ config: GerraConfig; path: string | null }> {
  const path = explicit ?? DEFAULT_CONFIG_FILE;
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT" && explicit === undefined) return { config: {}, path: null };
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new Error(`config file not found: ${path}`);
    throw err;
  }
  return { config: parseConfig(text, path), path };
}
