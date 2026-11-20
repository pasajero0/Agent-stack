#!/usr/bin/env bash
# PreToolUse(Edit|Write|MultiEdit|NotebookEdit) — the spec always leads the code.
#  1. The stage (from the branch name, see gates-lib) needs a first spec merged into the base branch
#     (origin/<base> if present, else local <base>): a human approved the direction.
#  2. Later spec changes ride in the same branch and MR as the code, but ahead of it: while the spec has
#     uncommitted edits, code is closed; a committed spec that differs from the base must say what
#     changed under "## Changes". So history always reads "spec: …" before the code it explains.
#  3. The plan follows the spec: code waits until /plan has broken the spec into tasks
#     (.claude/tmp/<stage>/tasks.json), so verify and evidence-gate have something to check.
# openPaths (docs, *.md, .claude/) stay open. gates.json → specGate: strict (default) | stage | off.
# A repository with no commits yet is open too: there is nothing to merge a spec into before the scaffold.
# So is a live quick run of the driver on this branch (gates-lib: driver_run_on_branch).
# gates.json → codeBy: "driver" closes code to everything but a live driver run on this branch, any mode.
set -euo pipefail
. "$(dirname "$0")/gates-lib.sh"
require_jq

[ -f "$GATES_FILE" ] || exit 0 # harness without gates.json (older version): gate not configured

path=$(jq -r '.tool_input.file_path // .tool_input.notebook_path // empty')
[ -z "$path" ] && exit 0
rel=$(rel_path "$path")
case "$rel" in /*) exit 0 ;; esac # outside the project
gate_list '.openPaths' | glob_match_any "$rel" && exit 0

# codeBy "driver": code changes only inside a driver call, so a chat runs the work through the driver
# (/drive) instead of doing it. Checked before specGate, so "off" does not open it (spec AC-71).
code_by=$(gate_get '.codeBy')
case "$code_by" in
  "" | anyone) ;;
  *)
    if repo_is_empty; then
      echo "spec-gate: codeBy \"$code_by\" starts after the first commit; this edit is not held by it." >&2
    elif ! driver_run_on_branch; then
      unknown=""
      [ "$code_by" = driver ] || unknown=" (the value \"$code_by\" is unknown, so it is read as \"driver\")"
      echo "Blocked by spec-gate ($rel): gates.json → codeBy is \"driver\"$unknown — code changes only through the driver. Run the work with /drive (agent-stack run task or run quick); do not edit code yourself." >&2
      exit 2
    fi
    ;;
esac

mode=$(gate_get '.specGate')
mode=${mode:-strict}
[ "$mode" = "off" ] && exit 0

# Bootstrap: an empty repository has no base branch to read a spec from — the scaffold comes first.
repo_is_empty && exit 0

# A quick fix run by the driver has no stage spec or plan: open only while that run is live on this branch.
driver_run_on_branch quick && exit 0

deny() {
  echo "Blocked by spec-gate ($rel): $1" >&2
  exit 2
}

stage=$(active_stage)
if [ -z "$stage" ]; then
  [ "$mode" = "stage" ] && exit 0
  deny "not on a stage branch. Work on a branch named after the stage (A0-ingest, feat/A0-ingest) — the stage comes from the branch name (stagePattern in .claude/gates.json)."
fi

specs=$(gate_get '.specsDir')
spec="${specs:-docs/specs}/$stage/SPEC.md"
cd "$PROJECT_DIR"
git rev-parse --git-dir >/dev/null 2>&1 || deny "not a git repository — the spec gate reads the merged spec from git."
ref=$(base_ref)
[ -n "$ref" ] || deny "base branch '$(gate_get '.baseBranch')' not found — set baseBranch in .claude/gates.json."

git cat-file -e "$ref:$spec" 2>/dev/null ||
  deny "$spec is not merged into $ref. The stage's first spec goes through its own MR, merged by a human (git fetch if it was just merged)."
git cat-file -e "HEAD:$spec" 2>/dev/null ||
  deny "this branch does not contain the merged $spec — merge or rebase on $ref first."
git diff --quiet HEAD -- "$spec" 2>/dev/null ||
  deny "$spec has uncommitted changes. Commit the spec change first (spec: …, with an entry under ## Changes), then the code."
if ! git diff --quiet "$ref" HEAD -- "$spec" 2>/dev/null; then
  [ "$(git show "$ref:$spec" | changes_section)" != "$(git show "HEAD:$spec" | changes_section)" ] ||
    deny "$spec differs from $ref, but its ## Changes section does not say what changed and why. Add the entry, commit it, then the code."
fi

# The plan itself is always writable — even with openPaths narrowed below .claude/ — or /plan could never
# open the gate. guard-file checks what a new plan contains.
plan=".claude/tmp/$stage/tasks.json"
[ "$rel" = "$plan" ] || [ -f "$PROJECT_DIR/$plan" ] ||
  deny "stage $stage has no task list yet ($plan). Run /plan $stage first — it breaks the merged spec into tasks with verify commands; the code comes after."

exit 0
