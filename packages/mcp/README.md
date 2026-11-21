# gerra-mcp

An MCP server that gives coding agents [gerra](https://www.npmjs.com/package/gerra)'s tapes, replays and diffs, so an agent can rewrite a service one route at a time and only move on when the replay passes.

```bash
claude mcp add gerra -- npx -y gerra-mcp --root "$PWD"
```

Tools: `gerra_list_tapes`, `gerra_get_exchanges`, `gerra_replay`, `gerra_diff`, `gerra_explain_exchange`. Replays only go to local or internal targets. Pair it with the `gerra-rewrite` skill from the repo.

https://github.com/bottercode/gerra · MIT
