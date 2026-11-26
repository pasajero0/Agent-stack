#!/usr/bin/env bash
# SessionStart — write start-marker for Stop hook + inject git context (only on fresh starts).
set -euo pipefail

# Without jq every guard denies every Bash call and edit (gates-lib require_jq): say so once, up front.
if ! command -v jq >/dev/null 2>&1; then
  cat >/dev/null
  echo "⚠️ jq is not on PATH: the harness guards will block every Bash command and file edit until jq is installed."
  exit 0
fi

input=$(cat)
session_id=$(echo "$input" | jq -r '.session_id // "unknown"')
cwd=$(echo "$input" | jq -r '.cwd // "."')
src=$(echo "$input" | jq -r '.source // "startup"')

# Same folder as stop-flag-reflect.sh; the OS sandbox lets Bash write only under $TMPDIR.
tmpbase="${TMPDIR:-/tmp}"
tmpbase="${tmpbase%/}"
mkdir -p "$tmpbase/claude-sessions"
# Sweep stale markers (>24h) so the folder doesn't grow forever
find "$tmpbase/claude-sessions" -maxdepth 1 -type f -name '*.start' -mtime +1 -delete 2>/dev/null || true

# Always write a fresh marker for this session — Stop hook compares memory mtimes against it
touch "$tmpbase/claude-sessions/$session_id.start"

# Heavy git context: only on a truly new context window
case "$src" in
  startup|clear)
    if git -C "$cwd" rev-parse 2>/dev/null >/dev/null; then
      # symbolic-ref also names an unborn branch (no commits yet); a detached HEAD falls back to its hash.
      branch=$(git -C "$cwd" symbolic-ref --quiet --short HEAD 2>/dev/null ||
        git -C "$cwd" rev-parse --short HEAD 2>/dev/null || echo unknown)
      last=$(git -C "$cwd" log -1 --pretty='%h %s' 2>/dev/null || echo "none yet")
      changed=$(git -C "$cwd" status --short 2>/dev/null | head -20)
      echo "## Session context"
      echo
      echo "- Branch: \`$branch\`"
      echo "- Last commit: $last"
      if [ -n "$changed" ]; then
        echo "- Working tree (first 20 entries):"
        echo '```'
        echo "$changed"
        echo '```'
      else
        echo "- Working tree: clean"
      fi
      echo
    fi
    ;;
esac

# Active migration plan(s) — fire on every source. Cheap (3 lines); most valuable
# on `compact` where prior nuances were summarized away.
if ls "${CLAUDE_PROJECT_DIR:-$cwd}"/.claude/tmp/*-plan.md >/dev/null 2>&1; then
  echo "⚠️ Active migration plan(s):"
  ls "${CLAUDE_PROJECT_DIR:-$cwd}"/.claude/tmp/*-plan.md
  echo "Re-read before acting; use /migration to continue."
  echo
fi

# Gate state — mode and active stage, on every source (survives compaction).
. "$(dirname "$0")/gates-lib.sh"
if [ "$(gate_get '.mode')" = "autonomous" ]; then
  echo "🤖 Autonomous mode (.claude/gates.json): no diff confirmations; never install anything, never push;"
  echo "commit per phase; unresolved decisions go to NEEDS HUMAN DECISION in the report."
  echo
fi
stage=$(active_stage)
if [ -n "$stage" ]; then
  tasks=$(tasks_file)
  if [ -f "$tasks" ]; then
    progress=$(jq -r '"\([.tasks[] | select(.passes == true)] | length)/\(.tasks | length) tasks passing"' "$tasks" 2>/dev/null || echo "tasks.json unreadable")
    echo "📋 Active stage: $stage — $progress (.claude/bin/verify to re-check)."
  else
    # The next step, so the model does not have to remember the order: spec first, then plan.
    specs=$(gate_get '.specsDir')
    spec="${specs:-docs/specs}/$stage/SPEC.md"
    ref=$(base_ref)
    closed=""
    [ "$(gate_get '.specGate')" = "off" ] || closed=" (code is closed until then)"
    if [ -z "$ref" ]; then
      echo "📋 Active stage: $stage — base branch '$(gate_get '.baseBranch')' not found; set baseBranch in .claude/gates.json."
    elif ! git -C "$PROJECT_DIR" cat-file -e "$ref:$spec" 2>/dev/null; then
      echo "📋 Active stage: $stage — no merged spec yet. Next: /spec $stage, then a human merges its MR."
    elif ! git -C "$PROJECT_DIR" cat-file -e "HEAD:$spec" 2>/dev/null; then
      echo "📋 Active stage: $stage — the spec is merged into $ref but not in this branch. Next: merge or rebase on $ref."
    else
      echo "📋 Active stage: $stage — spec merged, no tasks.json yet. Next: /plan $stage$closed."
    fi
  fi
  echo
fi
if [ "$(gate_get '.specGate')" != "off" ] && repo_is_empty; then
  echo "🌱 No commits yet: spec-gate stays open until the first commit — scaffold first."
  echo
fi

# A hook file that can never run: not registered in settings, or registered but not executable.
broken=""
for h in "$PROJECT_DIR"/.claude/hooks/*.sh; do
  [ -f "$h" ] || continue
  name=$(basename "$h")
  [ "$name" = gates-lib.sh ] && continue # sourced by the gates, not a hook
  # grep reads the files itself: `cat … | grep -q` can die of SIGPIPE under pipefail on a big file.
  # The closing quote of the JSON string keeps `x.sh` from matching `x.sh.bak`.
  if ! grep -qF "hooks/$name\"" "$PROJECT_DIR"/.claude/settings*.json 2>/dev/null; then
    broken="$broken
⚠️ Hook $name is in .claude/hooks/ but not registered in .claude/settings.json — it never runs."
  elif [ ! -x "$h" ]; then
    broken="$broken
⚠️ Hook $name is registered but not executable — it never runs. Fix: chmod +x .claude/hooks/$name"
  fi
done
if [ -n "$broken" ]; then
  printf '%s\n\n' "${broken#?}"
fi

# Pending /reflect notice — always (cheap), regardless of source
if [ -f "$tmpbase/.claude-reflect-pending" ]; then
  echo "💡 Memory was modified in the previous session — consider running \`/reflect\` to consolidate."
  echo
  rm -f "$tmpbase/.claude-reflect-pending"
fi

exit 0
