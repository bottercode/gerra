#!/usr/bin/env bash
# Run gerra replay and keep its exit code as a step output instead of failing the step here, so the
# summary and the PR comment are still written when the rewrite isn't equivalent yet.
#   GERRA     how to run gerra (e.g. "npx -y @gerra/cli@latest")
#   TAPE, AGAINST, ORIGINAL, RESET, ARGS, REPORT
set -uo pipefail
rm -f "$REPORT"
cmd=($GERRA replay "$TAPE" --against "$AGAINST" --markdown "$REPORT")
[ -n "${ORIGINAL:-}" ] && cmd+=(--original "$ORIGINAL")
[ -n "${RESET:-}" ] && cmd+=(--reset "$RESET")
# Extra arguments are parsed like a shell command line, so quotes work: --route "GET /posts/:id".
if [ -n "${ARGS:-}" ]; then eval "extra=($ARGS)"; cmd+=("${extra[@]}"); fi
echo "+ ${cmd[*]}"
"${cmd[@]}"
code=$?
echo "exit-code=$code" >>"${GITHUB_OUTPUT:-/dev/null}"
if [ -s "$REPORT" ] && [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then cat "$REPORT" >>"$GITHUB_STEP_SUMMARY"; fi
# 0 equivalent, 1 differences. Anything else, or no report (a missing tape, a failed reset), fails this step.
if [ "$code" -gt 1 ] || [ ! -s "$REPORT" ]; then exit "$((code == 0 ? 1 : code))"; fi
