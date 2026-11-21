import { spawn } from "node:child_process";

/** The reset command exited non-zero or couldn't start. */
export class ResetError extends Error {}

/**
 * Run a reset command (`npm run seed`, `psql -f fixtures.sql`, `docker compose restart db`) through the
 * shell and wait for it. Resolves with the time it took; rejects with the last lines of its output on failure.
 */
export function runReset(command: string, opts: { cwd?: string; timeoutMs?: number } = {}): Promise<number> {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      cwd: opts.cwd,
      stdio: ["ignore", "pipe", "pipe"],
      signal: AbortSignal.timeout(opts.timeoutMs ?? 120_000),
    });
    let output = "";
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-4000);
    };
    child.stdout.on("data", keep);
    child.stderr.on("data", keep);
    child.on("error", (err) => {
      const timedOut = err.name === "AbortError";
      reject(new ResetError(timedOut ? `reset command timed out after ${opts.timeoutMs ?? 120_000}ms: ${command}` : `reset command failed to start: ${err.message}`));
    });
    child.on("close", (code, signal) => {
      if (code === 0) return resolve(Date.now() - started);
      const tail = output.trim().split("\n").slice(-15).join("\n");
      const why = signal ? `was killed by ${signal}` : `exited with code ${code}`;
      reject(new ResetError(`reset command ${why}: ${command}${tail ? `\n${tail}` : ""}`));
    });
  });
}
