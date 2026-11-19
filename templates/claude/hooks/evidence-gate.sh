#!/usr/bin/env bash
# Stop — no "done" without evidence.
#   always:      blocks a message that claims STATUS: DONE with no EVIDENCE section — with or without a
#                task list, so skipping /plan does not skip the check.
#   with the active stage's tasks.json:
#   interactive: also blocks STATUS: DONE while a task is not passing, or while criteria, tests or a
#                code-health SLO do not line up.
#   autonomous:  also blocks stopping while any task is not passing, unless the agent reports
#                STATUS: BLOCKED or NEEDS HUMAN DECISION.
# Silent under a live driver run on this branch (gates-lib: driver_run_on_branch): the driver decides.
# Never blocks twice in a row (stop_hook_active): one nudge, then the human sees the real state.
# onFailure does not apply to Stop hooks, so this script fails open on bad input instead of crashing.
set -uo pipefail
. "$(dirname "$0")/gates-lib.sh"

input=$(cat)
[ "$(gate_get '.evidenceGate')" = "true" ] || exit 0
# Under a live driver run on this branch the driver runs verify itself and decides the result.
driver_run_on_branch && exit 0
[ "$(printf '%s' "$input" | jq -r '.stop_hook_active // false' 2>/dev/null)" = "true" ] && exit 0
tasks=$(tasks_file)

msg=$(printf '%s' "$input" | jq -r '.last_assistant_message // empty' 2>/dev/null)
if [ -z "$msg" ]; then
  # Older Claude Code: fall back to the last assistant text block in the transcript.
  transcript=$(printf '%s' "$input" | jq -r '.transcript_path // empty' 2>/dev/null)
  if [ -n "$transcript" ] && [ -f "$transcript" ]; then
    msg=$(tail -n 200 "$transcript" | jq -rs '
      [.[] | select(.type == "assistant") | .message.content[]? | select(.type == "text") | .text]
      | last // empty' 2>/dev/null)
  fi
fi

block() {
  jq -nc --arg r "$1" '{decision: "block", reason: $r}'
  exit 0
}

# Report fields count only at the start of a line (markdown bold / heading allowed), not as words.
field() { printf '%s\n' "$msg" | grep -Eq "^[*#>[:space:]]*$1"; }

# No task list, or one jq cannot read: only the evidence rule applies.
evidence_only() {
  field 'STATUS:[*[:space:]]*DONE' && ! field 'EVIDENCE' &&
    block "STATUS: DONE needs an EVIDENCE section: the commands you ran and their real output."
  exit 0
}
{ [ -n "$tasks" ] && [ -f "$tasks" ]; } || evidence_only
failing=$(jq -r '[.tasks[] | select(.passes != true) | .id] | join(", ")' "$tasks" 2>/dev/null) || evidence_only

if field 'STATUS:[*[:space:]]*DONE'; then
  [ -n "$failing" ] &&
    block "You report STATUS: DONE, but these tasks are not passing: $failing. Run .claude/bin/verify and fix them — or report STATUS: IN PROGRESS / BLOCKED honestly."
  field 'EVIDENCE' ||
    block "STATUS: DONE needs an EVIDENCE section: the commands you ran and their real output (at least .claude/bin/verify)."
  trace_out=$("$PROJECT_DIR/.claude/bin/trace" 2>&1)
  [ $? -eq 1 ] &&
    block "STATUS: DONE, but trace failed (criteria ↔ tests, spec terms ↔ glossary): $trace_out"
  health_out=$("$PROJECT_DIR/.claude/bin/health" --quick 2>&1)
  [ $? -eq 1 ] &&
    block "STATUS: DONE, but a code-health SLO is broken: $health_out"
  exit 0
fi

if [ "$(gate_get '.mode')" = "autonomous" ] && [ -n "$failing" ] &&
  ! field 'STATUS:[*[:space:]]*BLOCKED' && ! field 'NEEDS HUMAN DECISION'; then
  block "Autonomous mode: tasks $failing are not passing yet. Keep going (.claude/bin/verify), or stop with STATUS: BLOCKED and a NEEDS HUMAN DECISION entry."
fi

exit 0
