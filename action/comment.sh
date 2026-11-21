#!/usr/bin/env bash
# Create or update one pull request comment per tape with the Markdown report.
#   GH_TOKEN, PR, REPO, TAPE, REPORT
set -euo pipefail
if [ ! -s "$REPORT" ]; then echo "No report to post."; exit 0; fi
marker="<!-- gerra-replay:$TAPE -->"
body="$(printf '%s\n%s' "$marker" "$(cat "$REPORT")")"
existing=$(gh api "repos/$REPO/issues/$PR/comments" --paginate --jq ".[] | select(.body | startswith(\"$marker\")) | .id" | head -n1)
if [ -n "$existing" ]; then
  gh api -X PATCH "repos/$REPO/issues/comments/$existing" -f body="$body" >/dev/null
  echo "Updated the gerra comment on #$PR"
else
  gh api -X POST "repos/$REPO/issues/$PR/comments" -f body="$body" >/dev/null
  echo "Commented on #$PR"
fi
