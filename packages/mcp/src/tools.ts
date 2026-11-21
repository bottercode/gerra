import type { Exchange, RecordedBody } from "gerra-core";
import {
  compareExchange,
  exitCodeFor,
  formatExchangeComparison,
  formatTapes,
  getExchanges,
  reportText,
  runDiff,
  runReplay,
  tapesSummary,
  type Dirs,
} from "gerra/api";
import { ToolError, type Tool } from "./server.js";

function str(args: Record<string, unknown>, key: string, required: true): string;
function str(args: Record<string, unknown>, key: string, required?: false): string | undefined;
function str(args: Record<string, unknown>, key: string, required = false): string | undefined {
  const v = args[key];
  if (v === undefined || v === null || v === "") {
    if (required) throw new ToolError(`"${key}" is required`);
    return undefined;
  }
  if (typeof v !== "string") throw new ToolError(`"${key}" must be a string`);
  return v;
}

function strings(args: Record<string, unknown>, key: string): string[] {
  const v = args[key];
  if (v === undefined || v === null) return [];
  if (typeof v === "string") return [v];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) throw new ToolError(`"${key}" must be an array of strings`);
  return v as string[];
}

function headerMap(args: Record<string, unknown>, key: string): Record<string, string> {
  const v = args[key];
  if (v === undefined || v === null) return {};
  if (typeof v !== "object" || Array.isArray(v) || Object.values(v).some((x) => typeof x !== "string")) {
    throw new ToolError(`"${key}" must be an object of header name → value`);
  }
  return Object.fromEntries(Object.entries(v as Record<string, string>).map(([k, val]) => [k.toLowerCase(), val]));
}

function int(args: Record<string, unknown>, key: string, fallback: number, max: number): number {
  const v = args[key];
  if (v === undefined || v === null) return fallback;
  if (typeof v !== "number" || !Number.isInteger(v) || v < 1) throw new ToolError(`"${key}" must be a positive integer`);
  return Math.min(v, max);
}

const routesSchema = {
  type: "array",
  items: { type: "string" },
  description: 'Limit to these routes, written as gerra lists them: "POST /cart/price", "GET /products/:id", or a bare path for any method.',
};
const tapeSchema = { type: "string", description: "Tape name, e.g. checkout (see gerra_list_tapes)." };

function clipBody(body: RecordedBody | null, max: number): RecordedBody | null {
  if (!body || body.data.length <= max) return body;
  return { ...body, data: `${body.data.slice(0, max)}… [${body.data.length - max} more characters]` };
}

function compactExchange(ex: Exchange, maxBody: number) {
  return {
    id: ex.id,
    request: { ...ex.request, body: clipBody(ex.request.body, maxBody) },
    response: { ...ex.response, body: clipBody(ex.response.body, maxBody) },
  };
}

const verdict = (report: Parameters<typeof exitCodeFor>[0]) =>
  exitCodeFor(report) === 0 ? "PASS: every replayed exchange matches the tape." : "FAIL: see the differences above.";

/** The tools, bound to a set of directories (defaults: .gerra/* under the working directory). */
export function gerraTools(dirs: Dirs = {}): Tool[] {
  return [
    {
      name: "gerra_list_tapes",
      description:
        "List recorded tapes (real traffic captured from the original service) with request counts and status codes per route. Start here to see which routes exist and how much traffic each gets.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
      annotations: { title: "List tapes", readOnlyHint: true, openWorldHint: false },
      run: async () => formatTapes(await tapesSummary(dirs.tapes), dirs.tapes ?? ".gerra/tapes"),
    },
    {
      name: "gerra_get_exchanges",
      description:
        "Read recorded request/response pairs from a tape: method, path, query, headers, body and the original service's exact answer. Use it to learn what a route must return before (re)writing it. Values shown as [gerra:masked] were redacted at record time and match anything.",
      inputSchema: {
        type: "object",
        properties: {
          tape: tapeSchema,
          routes: routesSchema,
          limit: { type: "integer", minimum: 1, maximum: 50, description: "Exchanges to return (default 10, max 50)." },
        },
        required: ["tape"],
        additionalProperties: false,
      },
      annotations: { title: "Read recorded exchanges", readOnlyHint: true, openWorldHint: false },
      run: async (args) => {
        const r = await getExchanges({ tape: str(args, "tape", true), routes: strings(args, "routes"), limit: int(args, "limit", 10, 50), dirs });
        return JSON.stringify({ total: r.total, shown: r.exchanges.length, exchanges: r.exchanges.map((e) => compactExchange(e, 4000)) }, null, 2);
      },
    },
    {
      name: "gerra_replay",
      description:
        "Replay recorded requests against the candidate (the rewrite) and compare every answer with the original's. Returns a report of differences grouped by route and JSON path, with sample requests, and ends with PASS or FAIL. Use `routes` to check one route at a time while rewriting. Only local/internal targets are allowed. GET/HEAD/OPTIONS only unless `unsafe_methods` opts in (writes would be executed). With `original`, each request is also sent twice to the original service to learn noise (values that change on every call).",
      inputSchema: {
        type: "object",
        properties: {
          tape: tapeSchema,
          against: { type: "string", description: "Candidate URL, e.g. http://localhost:4000 or :4000." },
          routes: routesSchema,
          unsafe_methods: {
            type: "array",
            items: { type: "string" },
            description: 'Also replay non-idempotent requests: "*", a method ("POST") or a route ("POST /cart/price"). Only when replaying them has no harmful side effects.',
          },
          headers: { type: "object", additionalProperties: { type: "string" }, description: "Headers to send on every request, e.g. a test Authorization for headers masked in the tape." },
          original: { type: "string", description: "URL of the original service, to learn noise first (optional)." },
        },
        required: ["tape", "against"],
        additionalProperties: false,
      },
      annotations: { title: "Replay a tape against the candidate", readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      run: async (args) => {
        const original = str(args, "original");
        const o = await runReplay({
          tape: str(args, "tape", true),
          against: str(args, "against", true),
          ...(original ? { original } : {}),
          routes: strings(args, "routes"),
          unsafe: strings(args, "unsafe_methods"),
          headers: headerMap(args, "headers"),
          allowProd: false,
          dirs,
        });
        const notes = [];
        if (o.droppedMaskedHeaders.length > 0) {
          notes.push(`Note: ${o.droppedMaskedHeaders.join(", ")} masked in the tape and not sent; pass test values in "headers" if the candidate needs them.`);
        }
        if (o.learned) notes.push(`Learned ${o.learned.places} noisy places from the original (saved to ${o.learned.path}).`);
        return [...notes, reportText(o, true), verdict(o.report)].join("\n");
      },
    },
    {
      name: "gerra_diff",
      description: "Show the report of the latest replay of a tape again (no traffic is sent), optionally limited to routes. Applies the current gerra.config.json.",
      inputSchema: {
        type: "object",
        properties: { tape: tapeSchema, routes: routesSchema, run: { type: "string", description: "A specific run file instead of the latest." } },
        required: ["tape"],
        additionalProperties: false,
      },
      annotations: { title: "Show the last replay report", readOnlyHint: true, openWorldHint: false },
      run: async (args) => {
        const run = str(args, "run");
        const o = await runDiff({ tape: str(args, "tape", true), routes: strings(args, "routes"), ...(run ? { run } : {}), dirs });
        return `${reportText(o, false)}\n${verdict(o.report)}`;
      },
    },
    {
      name: "gerra_explain_exchange",
      description:
        "Show one exchange from the latest replay in full: the request, the original's recorded answer, the candidate's answer, and exactly where they differ. Use the id from a report sample (a prefix like ex_3f445aac is enough).",
      inputSchema: {
        type: "object",
        properties: { tape: tapeSchema, id: { type: "string", description: "Exchange id or unique prefix." }, run: { type: "string" } },
        required: ["tape", "id"],
        additionalProperties: false,
      },
      annotations: { title: "Explain one difference", readOnlyHint: true, openWorldHint: false },
      run: async (args) => {
        const run = str(args, "run");
        return formatExchangeComparison(await compareExchange({ tape: str(args, "tape", true), id: str(args, "id", true), ...(run ? { run } : {}), dirs }));
      },
    },
  ];
}

export const INSTRUCTIONS = `gerra checks that a rewritten backend answers exactly like the original, using real recorded traffic.
Workflow: gerra_list_tapes → gerra_get_exchanges for a route → implement it in the candidate → gerra_replay with routes=[that route] → gerra_explain_exchange on any difference → fix → repeat until PASS → gerra_replay on the whole tape to catch regressions.
Never treat a real difference as noise to make a replay pass; ask the user before adding ignore rules.`;
