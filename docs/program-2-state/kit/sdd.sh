#!/usr/bin/env bash
# Controller helper for program 2's subagent-driven execution.
#   sdd.sh ws     <dapi|exp> <plan-slug>               -> the workspace dir (creates ledger + global-constraints.md if new)
#   sdd.sh brief  <dapi|exp> <plan-slug> <N>           -> writes task-N-brief.md; prints brief/report paths, BASE, task count
#   sdd.sh review <dapi|exp> <plan-slug> <base> <head> -> writes the review package; prints its path
#   sdd.sh log    <dapi|exp> <plan-slug> <text...>     -> appends one line to the plan's ledger
set -euo pipefail
S="/Users/golobitch/Library/Application Support/Claude/local-agent-mode-sessions/0ed8c108-8b2a-4845-88c5-ee89977cd684/49390995-b6a1-478f-ad4c-04cfbe476eaf/rpm/plugin_01JETPTMWTgidsotmEhVkQTG/skills/subagent-driven-development/scripts"
mode=$1; repo=$2; slug=$3; shift 3
case "$repo" in
  dapi) root=/Users/golobitch/github.com/GateHubNet/data-api-worktrees/explorer-data-2 ;;
  exp)  root=/Users/golobitch/github.com/GateHubNet/x-explorer-worktrees/explorer-pages-2 ;;
  *) echo "repo must be dapi or exp" >&2; exit 2 ;;
esac
cd "$root"
plan="docs/superpowers/plans/$slug.md"
[ -f "$plan" ] || { echo "no plan $plan" >&2; exit 2; }
ws=$(bash "$S/sdd-workspace" "$plan")
[ -f "$ws/progress.md" ] || printf '# SDD ledger — plan: %s\nBASE (plan start): %s\n' "$plan" "$(git rev-parse --short HEAD)" > "$ws/progress.md"
[ -f "$ws/global-constraints.md" ] || awk '/^## Global Constraints/{f=1} /^## Review Focus/{f=0} f' "$plan" > "$ws/global-constraints.md"
case "$mode" in
  ws) echo "$ws" ;;
  brief)
    bash "$S/task-brief" "$plan" "$1" >/dev/null
    echo "brief=$ws/task-$1-brief.md"
    echo "report=$ws/task-$1-report.md"
    echo "constraints=$ws/global-constraints.md"
    echo "BASE=$(git rev-parse --short HEAD) tasks=$(grep -c '^### Task' "$plan") title=$(grep -m1 "^### Task $1:" "$plan" | sed 's/^### //')" ;;
  review) bash "$S/review-package" "$plan" "$1" "$2" ;;
  log) printf '%s\n' "$*" >> "$ws/progress.md"; echo logged ;;
  *) echo "unknown mode $mode" >&2; exit 2 ;;
esac
