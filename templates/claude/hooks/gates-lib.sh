#!/usr/bin/env bash
# Shared helpers for the gate hooks — sourced, never registered as a hook itself.
# Everything stack-specific comes from .claude/gates.json; with no config the gates stay open.
# bash 3.2 compatible (stock macOS): no associative arrays, no mapfile.

PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
GATES_FILE="$PROJECT_DIR/.claude/gates.json"

# gate_get '.mode' → scalar value, empty when unset or no config.
gate_get() {
  [ -f "$GATES_FILE" ] || return 0
  # Not `// empty`: jq treats false as missing there, which would read "cheatGuard": false as unset.
  jq -r "($1) | if . == null then empty elif type == \"boolean\" then tostring else . end" \
    "$GATES_FILE" 2>/dev/null || true
}

# gate_list '.openPaths' → one item per line.
gate_list() {
  [ -f "$GATES_FILE" ] || return 0
  jq -r "($1 // [])[]" "$GATES_FILE" 2>/dev/null || true
}

# require_jq — PreToolUse guards call this first: without jq every check would silently pass
# (a crashed hook is a non-blocking error), so block and say why instead.
require_jq() {
  command -v jq >/dev/null 2>&1 && return 0
  echo "Blocked: jq is not on PATH, so the harness guards cannot run. Install jq (or ask the human)." >&2
  exit 2
}

# repo_is_empty — a git repository with no commits on any ref: nothing to merge a spec into before the
# scaffold. An unborn HEAD alone is not enough: `git checkout --orphan x` gives one in a repo with history.
repo_is_empty() {
  git -C "$PROJECT_DIR" rev-parse --git-dir >/dev/null 2>&1 || return 1
  git -C "$PROJECT_DIR" rev-parse --verify -q HEAD >/dev/null 2>&1 && return 1
  [ -z "$(git -C "$PROJECT_DIR" for-each-ref --count=1 refs/heads refs/remotes refs/tags 2>/dev/null)" ]
}

# canon_dir <dir> → physical path (symlinks resolved: /var → /private/var on macOS).
canon_dir() { (cd -P "$1" 2>/dev/null && pwd -P); }

# lex_norm <abs path> → the same path with empty, `.` and `..` segments folded by text. Used for the part
# of a path that does not exist yet, which `cd -P` cannot resolve: `.claude/new/../hooks/x` → `.claude/hooks/x`.
lex_norm() {
  local seg out="" parts
  IFS=/ read -r -a parts <<<"$1"
  for seg in ${parts[@]+"${parts[@]}"}; do
    case "$seg" in
      ''|.) ;;
      ..) out=${out%/*} ;;
      *) out="$out/$seg" ;;
    esac
  done
  printf '%s' "${out:-/}"
}

# resolve_abs <abs path> → physical path: the deepest existing ancestor through `cd -P`, the rest (which may
# not exist yet) folded by text.
resolve_abs() {
  local dir rest
  dir=$(dirname "$1")
  rest=$(basename "$1")
  while [ ! -d "$dir" ] && [ "$dir" != "/" ]; do
    rest="$(basename "$dir")/$rest"
    dir=$(dirname "$dir")
  done
  lex_norm "$(canon_dir "$dir")/$rest"
}

# rel_path <path> → path relative to the project root, both sides symlink-resolved, so a file_path
# under /private/var still matches a project dir under /var. Paths outside the project stay absolute.
# A last component that is a symlink is followed (max 40 hops; a relative target is read against the
# link's folder), so a Write to `notes/l.json -> ../.claude/tmp/runs/lock` is judged as the lock.
rel_path() {
  local p=$1 root full target hops=0
  case "$p" in /*) ;; *) p="$PROJECT_DIR/${p#./}" ;; esac
  full=$(resolve_abs "$p")
  while [ -L "$full" ] && [ "$hops" -lt 40 ]; do
    target=$(readlink "$full") || break
    case "$target" in /*) ;; *) target="$(dirname "$full")/$target" ;; esac
    full=$(resolve_abs "$target")
    hops=$((hops + 1))
  done
  root=$(canon_dir "$PROJECT_DIR")
  case "$full" in
    "$root"/*) printf '%s' "${full#"$root"/}" ;;
    *) printf '%s' "$full" ;;
  esac
}

# is_secret_path <path> [word] — true for files that usually hold credentials: env files (not their
# .example/.sample/.template/.dist copies), private keys, cloud credentials. Case-insensitive.
# With `word` (a word of a shell command, maybe not a path): an extension-only name (*.key, *.pem, …) counts
# only when the file exists, so `grep "event.key" src` is not a secret read.
is_secret_path() {
  local p=$1 base hit=1 nocase=0
  base=${p##*/}
  shopt -q nocasematch && nocase=1
  shopt -s nocasematch
  case "$base" in
    .env.example|.env.sample|.env.template|.env.dist|.env.*.example|.env.*.sample|.env.*.template) ;;
    .env|.env.*|id_rsa|id_dsa|id_ecdsa|id_ed25519) hit=0 ;;
    *.pem|*.key|*.p12|*.pfx)
      if [ "${2:-}" != word ] || [ -f "$p" ] || [ -f "$PROJECT_DIR/$p" ]; then hit=0; fi ;;
    *)
      case "$p" in .aws/credentials|*/.aws/credentials) hit=0 ;; esac ;;
  esac
  [ "$nocase" = 1 ] || shopt -u nocasematch
  return "$hit"
}

# decide_ask <reason> — ask the human in interactive mode; in autonomous mode nobody is there to ask,
# so block with the same reason and say where the decision goes.
decide_ask() {
  if [ "$(gate_get '.mode')" = "autonomous" ]; then
    echo "Blocked: $1 Autonomous mode cannot ask — record it under NEEDS HUMAN DECISION and move on." >&2
    exit 2
  fi
  jq -n --arg r "$1" '{
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: $r }
  }'
  exit 0
}

# glob_match_any <path> — true if the path matches any case-glob read from stdin.
glob_match_any() {
  local path=$1 pat
  while IFS= read -r pat; do
    [ -z "$pat" ] && continue
    # shellcheck disable=SC2254 — the pattern is meant to glob.
    case "$path" in $pat) return 0 ;; esac
  done
  return 1
}

# A shell command starts at a line start, after ; & | ( { or an opening quote / backtick
# (catches `bash -c '…'` and `$(…)`), optionally behind shell keywords (then, do, else, !),
# wrapper words or env assignments.
CMD_START='(^|[;&|({`"'"'"'])[[:space:]]*((env|command|exec|nohup|time|sudo|then|do|else|!)[[:space:]]+)*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*'

# SPEC_FLOWS — the spec flow names (AC-83). A copy of SPEC_FLOWS in src/run/spec-flow.ts, held equal to it
# by tests/hooks/spec-flow.test.ts; the first is the default.
SPEC_FLOWS="merge branch"

# spec_flow → gates.json → specFlow, or the default when unset. Exit 1 (printing the value) for a name not in
# SPEC_FLOWS.
spec_flow() {
  local v f
  v=$(gate_get '.specFlow')
  [ -n "$v" ] || { printf '%s' "${SPEC_FLOWS%% *}"; return 0; }
  for f in $SPEC_FLOWS; do
    [ "$v" = "$f" ] && { printf '%s' "$v"; return 0; }
  done
  printf '%s' "$v"
  return 1
}

# active_stage → stage id taken from the current git branch, so the agent cannot quietly point the
# gates at another stage: the last path segment of the branch must match gates.json → stagePattern
# (capture group 1; default: letters+digits at the start — A0-ingest, feat/A0-ingest, spec/A0 → A0).
# In spec flow branch (AC-89) the stage of the live task run that AGENT_STACK_RUN names on this branch comes
# first: a work branch like v2-login would give v2.
# Empty on a branch without a stage (main), on a detached HEAD, or outside git.
active_stage() {
  local branch pattern s
  if [ "$(spec_flow)" = "branch" ] && driver_run_on_branch task; then
    s=$(jq -r '.stage // empty' "$PROJECT_DIR/.claude/tmp/runs/$AGENT_STACK_RUN/run.json" 2>/dev/null)
    case "$s" in
      "" | *[!A-Za-z0-9._-]* | .*) ;;
      *) printf '%s' "$s"; return 0 ;;
    esac
  fi
  branch=$(git -C "$PROJECT_DIR" symbolic-ref --quiet --short HEAD 2>/dev/null) || return 0
  pattern=$(gate_get '.stagePattern')
  [ -n "$pattern" ] || pattern='^([A-Za-z]+[0-9]+)([-_.]|$)'
  [[ "${branch##*/}" =~ $pattern ]] || return 0
  s=${BASH_REMATCH[1]}
  case "$s" in
    "" | *[!A-Za-z0-9._-]* | .*) return 0 ;;
  esac
  printf '%s' "$s"
}

# base_ref → the ref merged work is read from: origin/<baseBranch> if it exists, else the local branch.
# Empty when neither exists (or outside git).
base_ref() {
  local base
  base=$(gate_get '.baseBranch')
  base=${base:-main}
  if git -C "$PROJECT_DIR" rev-parse --verify -q "refs/remotes/origin/$base" >/dev/null 2>&1; then
    printf '%s' "origin/$base"
  elif git -C "$PROJECT_DIR" rev-parse --verify -q "refs/heads/$base" >/dev/null 2>&1; then
    printf '%s' "$base"
  fi
}

# changes_section → the body of the "## Changes" section of a spec read from stdin.
changes_section() { awk '/^## Changes/ { f = 1; next } /^## / { f = 0 } f'; }

tasks_file() {
  local s
  s=$(active_stage)
  [ -n "$s" ] && printf '%s' "$PROJECT_DIR/.claude/tmp/$s/tasks.json"
}

# driver_run_on_branch [mode] — true only while AGENT_STACK_RUN names a live driver run on this branch:
#   - the id is a well-formed run id (r-<yyyymmdd>-<hhmmss>), so it cannot point outside the runs folder;
#   - .claude/tmp/runs/lock holds that id and a positive pid that is alive (kill -0; 0 and -1 would
#     address a process group, so they never count);
#   - the run file says status running, branch = the current branch and, when given, mode = <mode>.
# The variable alone opens nothing. guard-file blocks Edit/Write to the runs folder; forging it with Bash
# is the known blocklist gap.
driver_run_on_branch() {
  local id=${AGENT_STACK_RUN:-} want=${1:-} runs pid branch id_re='^r-[0-9]{8}-[0-9]{6}$' pid_re='^[1-9][0-9]*$'
  [[ "$id" =~ $id_re ]] || return 1
  runs="$PROJECT_DIR/.claude/tmp/runs"
  [ -f "$runs/lock" ] && [ -f "$runs/$id/run.json" ] || return 1
  pid=$(jq -r --arg id "$id" 'if .id == $id and (.pid | type) == "number" then .pid else empty end' \
    "$runs/lock" 2>/dev/null) || return 1
  [[ "$pid" =~ $pid_re ]] || return 1
  kill -0 "$pid" 2>/dev/null || return 1
  branch=$(git -C "$PROJECT_DIR" symbolic-ref --quiet --short HEAD 2>/dev/null) || return 1
  [ -n "$branch" ] || return 1
  jq -e --arg b "$branch" --arg m "$want" \
    '.status == "running" and .branch == $b and ($m == "" or .mode == $m)' "$runs/$id/run.json" >/dev/null 2>&1
}
