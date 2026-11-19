#!/usr/bin/env bash
# PreToolUse guard — Edit|Write|MultiEdit|NotebookEdit: protects the harness itself, generated + secret
# files; Read|Grep: asks before reading a file that holds secrets.
set -euo pipefail
. "$(dirname "$0")/gates-lib.sh"
require_jq

input=$(cat)
tool=$(printf '%s' "$input" | jq -r '.tool_name // empty')
path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // .tool_input.notebook_path // .tool_input.path // empty')
[ -z "$path" ] && exit 0
rel=$(rel_path "$path")

# Reading secrets: whatever lands in the context can leak through any later tool call.
case "$tool" in
  Read|Grep)
    if is_secret_path "$rel"; then
      decide_ask "Reading $rel — it may hold secrets, and what the agent reads can leak. Read the .example copy, or confirm."
    fi
    exit 0
    ;;
esac

# Harness self-protection — the enforcement layer is edited by a human, never by the agent.
# Without this one Edit could switch any guard off. (Bash writes are not covered: blocklist, not a sandbox.)
# Matched on the resolved path (`.claude/./hooks`, `.claude//hooks`, `x/../.claude/hooks` all resolve) and
# in lower case: on a case-insensitive filesystem `.Claude/Hooks/…` is the same file.
rel_lc=$(printf '%s' "$rel" | tr '[:upper:]' '[:lower:]')
case "$rel_lc" in
  .claude/hooks/*|.claude/bin/*|.claude/settings.json|.claude/settings.local.json|.claude/gates.json|\
  */.claude/hooks/*|*/.claude/bin/*|*/.claude/settings.json|*/.claude/settings.local.json|*/.claude/gates.json)
    echo "Blocked: $rel is part of the harness enforcement layer — only a human edits it, by hand." >&2
    exit 2
    ;;
esac

# The driver's run folder (run file, lock, call records): the spec-gate and evidence-gate bypasses trust it.
case "$rel_lc" in
  .claude/tmp/runs/*|*/.claude/tmp/runs/*)
    echo "Blocked: $rel is in the run folder — only the driver (agent-stack run) writes there." >&2
    exit 2
    ;;
esac

# A stage plan: only .claude/bin/verify updates `passes`. A new plan may be written, all tasks unproven.
case "$rel_lc" in
  .claude/tmp/*/tasks.json)
    if [ -e "$PROJECT_DIR/$rel" ]; then
      echo "Blocked: $rel is updated only by .claude/bin/verify. To re-plan, delete it (rm) and write a fresh plan." >&2
      exit 2
    fi
    if ! printf '%s' "$input" | jq -r '.tool_input.content // ""' |
      jq -e '(.tasks | type == "array") and (.tasks | length > 0) and ([.tasks[] | .passes == true] | any | not)' >/dev/null 2>&1; then
      echo "Blocked: a new $rel must be valid JSON with a non-empty tasks array and every task at \"passes\": false — only verify proves them; an empty plan would open spec-gate with nothing to check." >&2
      exit 2
    fi
    ;;
esac

# Generated files and lockfiles (gates.json → protectedGlobs) — regenerate, never hand-edit.
if gate_list '.protectedGlobs' | glob_match_any "$rel"; then
  echo "Blocked: $rel is generated (build output or lockfile) — regenerate it, never edit it by hand." >&2
  exit 2
fi

case "$path" in
  *.env|*.env.*)
    jq -n '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: "Editing an env file — it may contain secrets. Confirm before writing."
      }
    }'
    exit 0
    ;;
esac

exit 0
