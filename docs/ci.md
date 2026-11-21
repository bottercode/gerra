# CI: replay on every pull request

The repository is also a GitHub Action. It starts your candidate, replays a committed tape against it, writes the report to the job summary, comments on the pull request (one comment per tape, updated on every push), and fails the job if any response differs.

```yaml
name: gerra
on: pull_request

permissions:
  contents: read
  pull-requests: write   # for the comment

jobs:
  replay:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-go@v5
        with: { go-version: stable }
      - uses: bottercode/gerra@main
        with:
          tape: checkout                     # .gerra/tapes/checkout.jsonl, committed
          start: go run ./cmd/server         # runs in the background; output is shown at the end
          against: :4000
          reset: ./scripts/seed-test-db.sh   # optional: put the database in the recorded state
          args: --unsafe-methods "POST /cart/price"
```

Commit the tape (`.gerra/tapes/<name>.jsonl`) and, if you use them, `gerra.config.json` and learned noise (`.gerra/noise/<name>.json`). Tapes are masked at record time (`authorization`, `cookie`, `set-cookie`, plus anything in `mask`), but read them before committing: they hold real responses.

## Inputs

| Input | Default | |
| --- | --- | --- |
| `tape` | (required) | Tape name. |
| `against` | (required) | Candidate URL, e.g. `http://localhost:4000` or `:4000`. |
| `start` | | Command that starts the candidate. The action waits until it answers HTTP on `against`. Leave empty if an earlier step started it. |
| `wait` | `60` | Seconds to wait for it. |
| `original` | | Original service URL, to learn noise (it must be running). |
| `reset` | | Command run before the replay; see [Writes and state](../README.md#writes-and-state). |
| `args` | | More `gerra replay` arguments, parsed like a shell command line. |
| `working-directory` | `.` | Where `.gerra/` and `gerra.config.json` are. |
| `version` | `latest` | `@gerra/cli` version run with `npx`. |
| `gerra` | | Command that runs gerra instead of npx, e.g. `node packages/cli/dist/index.js`. |
| `comment` | `true` | Comment on the pull request. Forks' tokens can't comment; the summary still has the report. |
| `fail-on-diff` | `true` | Fail the job when anything differs or errors. |
| `token` | `github.token` | Token for the comment. |

Outputs: `exit-code` (0 equivalent, 1 differences or errors) and `report` (path of the Markdown report).

## Elsewhere

Any CI can run `npx @gerra/cli replay <tape> --against <url> --markdown report.md`: it exits 1 when something differs and writes the same report as Markdown (`--markdown -` prints it). On GitHub, `--markdown "$GITHUB_STEP_SUMMARY"` appends it to the job summary.

This repository runs the action on its own example in [.github/workflows/ci.yml](../.github/workflows/ci.yml).
