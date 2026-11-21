# gerra — project rules

Read this first in every session. The roadmap and current milestone live in `docs/PLAN.md`; update it as work lands.

## What we're building
**gerra is an open-source safety net for rewriting backend code with AI.**
It records how an existing service behaves on real traffic, replays that traffic against a rewrite (usually AI-written, e.g. Node → Go), shows every difference, and then switches traffic over gradually with automatic rollback.

One line: *AI rewrites your code; gerra proves the rewrite gives the same answers before real users touch it.*

Analogy we use when explaining it: an old, slow-but-correct cashier and a new fast one. Record the old one's bills, test the new one on the same carts, let both calculate in parallel while customers pay the old total (shadow), then hand over customers gradually and switch back instantly on a mistake.

### Core flow (the product, in order)
1. **record** — reverse proxy in front of the existing service; writes every request/response to a *tape*.
2. **replay** — sends a tape to the candidate (rewritten) service.
3. **diff** — compares responses, filters noise (timestamps, IDs, ordering), reports real differences grouped by cause.
4. **shadow** — live traffic goes to the old service (users get its response) and is mirrored to the new one; differences are tracked live.
5. **cutover** — weighted routing 1% → 100%, auto-rollback on diff rate or latency thresholds.
6. **agent loop** — a Claude Code / Codex skill + MCP server that rewrites one endpoint at a time and only moves on when `gerra replay` passes.

### Positioning / competition (checked 2026-11-20)
- Mechanical Orchard does this for mainframes (enterprise). Proves the idea; not our market.
- rust-anything (OSS, ~6k★) does record→rewrite→verify locally, Rust target only, no live traffic/shadow/cutover.
- Keploy (record/replay → tests), GoReplay (traffic copy), GitHub Scientist (Ruby, in-process compare), Twitter Diffy (dead since 2020) are pieces.
- Our wedge: the full flow for ordinary web backends (any language, because we work at the HTTP layer), free and open source, agent-native.

## Architecture
pnpm monorepo, TypeScript, Node ≥ 24, ESM only.

```
packages/
  core/   tape format, diff + normalization engine, report model (no I/O-heavy deps)
  cli/    `gerra` binary: record | replay | diff | shadow | cutover (uses core); exports `@gerra/cli/api`
  mcp/    MCP server for agents (uses `@gerra/cli/api`)
skills/
  gerra-rewrite/SKILL.md   agent workflow: rewrite route by route until gerra replay passes
examples/
  express-pricing/   small Express app + a deliberately imperfect rewrite
  json-server/       launch demo: json-server ported to Go (go/ is its own Go module)
docs/
  PLAN.md   roadmap + milestone checklist (source of truth for "what next")
```
Later packages (do not create until their milestone): `proxy` (if the CLI's proxy outgrows it), `sdk-node` (DB/outbound-call capture), `dashboard`.

Key design decisions (change only with a note in PLAN.md "Decisions"):
- **HTTP-layer first, language-agnostic.** v1 needs zero code changes in the user's service: point a proxy at it. SDKs for DB/outbound capture come later.
- **Tapes are JSONL** (`.gerra/tapes/<name>.jsonl`), one exchange per line, append-only, human-readable. Schema lives in `packages/core/src/tape.ts`; bump `version` on breaking changes.
- **Noise detection the Diffy way:** replay against the *original* twice; fields that differ between two runs of the original are noise and are ignored when comparing the candidate.
- **Safety by default:** replay only idempotent methods (GET/HEAD/OPTIONS) unless the user opts in per route; never replay against production targets unless `--allow-prod`.
- **PII:** mask configured headers/fields at record time (default: authorization, cookie, set-cookie).

## Conventions
- TypeScript `strict`, no `any` without a comment explaining why. Prefer small pure functions in `core`.
- Node built-ins over dependencies (`node:http`, `node:util` `parseArgs`, `node:test` is NOT used — tests use **vitest**). Add a dependency only if it saves real work; note why in the PR/commit.
- Every core behavior gets a unit test. Diff/normalization changes need a fixture-based test.
- CLI output: human-readable by default, `--json` for machines. Exit code non-zero when replay finds real differences (so it works in CI).
- Keep the README honest: only document commands that work.

## Commands
```bash
pnpm install          # install workspace deps
pnpm build            # tsc build all packages
pnpm test             # vitest across packages
pnpm typecheck
pnpm gerra -- <args>  # run the local CLI (after build)
```

## Working rules for Claude
- Check `docs/PLAN.md` for the current milestone before starting; tick items off as they land.
- Don't start a later milestone's package or feature early.
- Don't commit or push unless asked. No Claude co-author/attribution lines anywhere.
- Ask before choosing a license change, renaming the project, or adding a hosted/paid component.
