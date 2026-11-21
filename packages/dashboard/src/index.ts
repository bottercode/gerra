#!/usr/bin/env node
import { parseArgs } from "node:util";
import { startDashboard } from "./server.js";

const HELP = `Usage: gerra-dashboard [options]

Local, read-only web dashboard for the gerra data in the current directory (.gerra/): tapes,
replay runs and their differences, single exchanges side by side, learned noise, and live
shadow and cutover sessions.

Options:
  --port <n>         Port (default 7700)
  --config <path>    Config file used to rebuild reports (default ./gerra.config.json if present)
  --dir <path>       Tapes directory (default .gerra/tapes)
  --runs-dir <path>  Runs directory (default .gerra/runs)
  -h, --help         Show help`;

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "7700" },
    config: { type: "string" },
    dir: { type: "string" },
    "runs-dir": { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});
if (values.help) {
  console.log(HELP);
  process.exit(0);
}
const port = Number(values.port);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`gerra-dashboard: --port must be a port number, got "${values.port}"`);
  process.exit(2);
}
try {
  const d = await startDashboard({
    port,
    ...(values.config ? { config: values.config } : {}),
    dirs: { ...(values.dir ? { tapes: values.dir } : {}), ...(values["runs-dir"] ? { runs: values["runs-dir"] } : {}) },
  });
  console.log(`gerra dashboard on ${d.url}  (Ctrl-C to stop)`);
  process.once("SIGINT", () => void d.close().then(() => process.exit(0)));
} catch (err) {
  const e = err as NodeJS.ErrnoException;
  console.error(`gerra-dashboard: ${e.code === "EADDRINUSE" ? `port ${port} is in use; pick another with --port` : e.message}`);
  process.exit(1);
}
