#!/usr/bin/env bash
# Decides which CI jobs a change needs. Writes `code` and `agent` (true/false) to
# $GITHUB_OUTPUT when set, and prints them either way.
#
#   code  = anything other than Markdown/docs changed → typecheck, tests, build, smoke
#   agent = something that can change the agent's behaviour → live-model evals
#
# Pull requests are diffed against the merge commit's first parent (current base),
# so the result reflects exactly what merging would change.
set -euo pipefail

EVENT="${EVENT:-pull_request}"
FORCE_EVALS="${FORCE_EVALS:-false}"

emit() {
  echo "code=$1"
  echo "agent=$2"
  if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
    echo "code=$1" >>"$GITHUB_OUTPUT"
    echo "agent=$2" >>"$GITHUB_OUTPUT"
  fi
}

case "$EVENT" in
  workflow_dispatch) emit true "$FORCE_EVALS"; exit 0 ;;
  # After merge: full build and tests. Evals already ran on the PR.
  push) emit true false; exit 0 ;;
esac

files="$(git diff --name-only "${BASE_REF:-HEAD^1}" HEAD)"
code=false
agent=false
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  case "$f" in
    *.md | docs/*) ;;
    *) code=true ;;
  esac
  case "$f" in
    packages/agent/* | packages/tools/* | packages/core/src/tool.ts | packages/core/src/policy.ts | \
      fixtures/* | pnpm-lock.yaml | .github/workflows/ci.yml | scripts/ci/*)
      agent=true
      ;;
  esac
done <<<"$files"

printf 'changed files:\n%s\n' "${files:-(none)}"
emit "$code" "$agent"
