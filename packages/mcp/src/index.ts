#!/usr/bin/env node
// gerra MCP server (stdio). Run it from the project directory that holds .gerra/, or pass --root <dir>.
//   claude mcp add gerra -- node /path/to/gerra/packages/mcp/dist/index.js --root /path/to/project
import { createRequire } from "node:module";
import { parseArgs } from "node:util";
import { serveStdio } from "./server.js";
import { INSTRUCTIONS, gerraTools } from "./tools.js";

const { values } = parseArgs({ options: { root: { type: "string" } } });
if (values.root) process.chdir(values.root);
const { version } = createRequire(import.meta.url)("../package.json") as { version: string };
console.error(`gerra MCP server ${version} on stdio, working in ${process.cwd()}`);
await serveStdio({ name: "gerra", version, instructions: INSTRUCTIONS }, gerraTools());
