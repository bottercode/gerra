import { createWriteStream, mkdirSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { finished } from "node:stream/promises";
import { DEFAULT_MASKED_HEADERS, maskExchange, serializeExchange, type Exchange } from "@gerra/core";
import { DEFAULT_MAX_BODY_BYTES, startProxy } from "./proxy.js";

export { DEFAULT_MAX_BODY_BYTES };

export interface RecorderOptions {
  /** Service to proxy to, e.g. `http://localhost:3000`. A path prefix is allowed. */
  target: string;
  /** Path of the `.jsonl` tape (created with parent dirs if missing). */
  tapePath: string;
  /**
   * What to do when the tape already has exchanges: refuse (the default, so a re-recording can't
   * silently mix with an old one), add to it, or replace it.
   */
  ifExists?: "error" | "append" | "overwrite";
  /** Port to listen on; 0 picks a free port. */
  port: number;
  host?: string;
  /** Header names to mask in the tape, in addition to the defaults. */
  maskHeaders?: readonly string[];
  /** JSON field names to mask in request/response bodies. */
  maskFields?: readonly string[];
  /** Bodies larger than this are recorded truncated (the client still gets everything). */
  maxBodyBytes?: number;
  onExchange?: (ex: Exchange) => void;
  onError?: (err: Error, method: string, url: string) => void;
}

/** The tape already has exchanges and neither appending nor overwriting was asked for. */
export class TapeExistsError extends Error {
  constructor(readonly tapePath: string) {
    super(`${tapePath} already exists and isn't empty`);
  }
}

export interface Recorder {
  url: string;
  port: number;
  /** Exchanges written so far. */
  readonly recorded: number;
  /** Stop accepting, let in-flight requests finish (up to `graceMs`), then flush and close the tape. */
  close(graceMs?: number): Promise<void>;
}

export async function startRecorder(opts: RecorderOptions): Promise<Recorder> {
  const maskedHeaders = [...DEFAULT_MASKED_HEADERS, ...(opts.maskHeaders ?? [])];
  const maskFields = opts.maskFields ?? [];
  if (!/^https?:$/.test(new URL(opts.target).protocol)) {
    throw new Error(`--target must be an http(s) URL, got "${opts.target}"`);
  }

  const ifExists = opts.ifExists ?? "error";
  const existing = fileSize(opts.tapePath);
  if (existing > 0 && ifExists === "error") throw new TapeExistsError(opts.tapePath);

  mkdirSync(dirname(opts.tapePath), { recursive: true });
  const tape = createWriteStream(opts.tapePath, { flags: ifExists === "overwrite" ? "w" : "a" });
  let tapeError: Error | null = null;
  tape.on("error", (err) => {
    tapeError = err;
  });

  let recorded = 0;
  const proxy = await startProxy({
    target: opts.target,
    port: opts.port,
    ...(opts.host !== undefined ? { host: opts.host } : {}),
    ...(opts.maxBodyBytes !== undefined ? { maxBodyBytes: opts.maxBodyBytes } : {}),
    ...(opts.onError ? { onError: opts.onError } : {}),
    captureEffects: true,
    onExchange: (raw) => {
      if (tapeError) return;
      const ex = maskExchange(raw, maskedHeaders, maskFields);
      tape.write(serializeExchange(ex) + "\n");
      recorded++;
      opts.onExchange?.(ex);
    },
  });

  let closing: Promise<void> | null = null;
  return {
    url: proxy.url,
    port: proxy.port,
    get recorded() {
      return recorded;
    },
    close(graceMs = 5000) {
      closing ??= (async () => {
        await proxy.close(graceMs);
        tape.end();
        await finished(tape).catch(() => undefined);
        if (tapeError) throw tapeError;
      })();
      return closing;
    },
  };
}

function fileSize(path: string): number {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}
