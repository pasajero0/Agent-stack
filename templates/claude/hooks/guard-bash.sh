#!/usr/bin/env bash
# PreToolUse(Bash) guard — enforces hard prohibitions. Blocklist: catches mistakes, not a determined bypass.
set -euo pipefail
. "$(dirname "$0")/gates-lib.sh"
require_jq

cmd=$(jq -r '.tool_input.command // empty')
[ -z "$cmd" ] && exit 0

# git push — any form that still starts with git: global options (-C dir, --no-pager, -c k=v), env
# prefixes, `bash -c '…'`, `$(…)`. `git stash push` and commit messages that mention push stay allowed.
GIT_OPTS='([[:space:]]+(-C|-c|--git-dir|--work-tree|--namespace)[[:space:]]+[^[:space:]]+|[[:space:]]+-[^[:space:]]+)*'
if printf '%s' "$cmd" | grep -Eq "${CMD_START}git${GIT_OPTS}[[:space:]]+push([[:space:];&|)\`\"']|\$)"; then
  echo "Blocked: 'git push' is manual-only — a human pushes by hand." >&2
  exit 2
fi

# Merging a PR/MR is the human's approval (a merged spec opens the spec-gate) — never the agent's.
if printf '%s' "$cmd" | grep -Eq "${CMD_START}((gh|glab)[[:space:]]+(pr|mr)[[:space:]]+merge|gh[[:space:]]+api[[:space:]].*/merge)"; then
  echo "Blocked: merging is the human's approval step — ask the human to review and merge." >&2
  exit 2
fi

# Foreign package managers (from gates.json).
forbidden=$(gate_list '.forbiddenPackageManagers' | paste -sd '|' -)
if [ -n "$forbidden" ] && printf '%s' "$cmd" | grep -Eq "${CMD_START}(${forbidden})([[:space:]]|\$)"; then
  echo "Blocked: this repo uses $(gate_get '.packageManager') only." >&2
  exit 2
fi

# Running code fetched from outside — a one-shot runner or a download piped into a shell — is an install
# that leaves no trace in the manifest. Fixed here, not in gates.json → installPatterns: `update` never
# touches gates.json, so a list there would not reach existing repos.
RUNNERS='(pnpx|uvx|pnpm[[:space:]]+dlx|yarn[[:space:]]+dlx|uv[[:space:]]+tool[[:space:]]+run|pipx[[:space:]]+run)([[:space:]]|$)'
REMOTE_RUN='(go[[:space:]]+run[[:space:]]+[^[:space:]]+@|deno[[:space:]]+run[[:space:]]+([^[:space:]]+[[:space:]]+)*https?://)'
# A shell, or python/node reading the program from stdin — `| python3 -m json.tool` reads data, not code.
PIPE_TO_SHELL='(curl|wget)[[:space:]][^|]*\|[[:space:]]*(sudo[[:space:]]+)?(((ba|z|da)?sh)([[:space:]]|$)|(python3?|node)([[:space:]]+-)?[[:space:]]*($|[;&|)]))'
# npx / bunx / npm exec also run a binary the project already installed — that is fine; a package that is
# not in node_modules/.bin (or carries a version or a scope) is a download.
JS_RUNNER='(npx|bunx|npm[[:space:]]+(exec|x)|bun[[:space:]]+x)([[:space:]]+-[^[:space:]]+)*[[:space:]]+[^[:space:];&|)]+'
remote_js=""
while IFS= read -r inv; do
  [ -z "$inv" ] && continue
  bin=${inv##*[[:space:]]}
  bin=${bin%%[\"\'\`]*}
  case "$bin" in
    ''|*@*|*/*) remote_js=1 ;;
    *) [ -x "$PROJECT_DIR/node_modules/.bin/$bin" ] || remote_js=1 ;;
  esac
done < <(printf '%s\n' "$cmd" | grep -oE "${CMD_START}${JS_RUNNER}" || true)
if [ -n "$remote_js" ] || printf '%s' "$cmd" | grep -Eq "${CMD_START}(${RUNNERS}|${REMOTE_RUN})" ||
  printf '%s' "$cmd" | grep -Eq "$PIPE_TO_SHELL"; then
  decide_ask "This command downloads code and runs it. A tool the project already has runs from node_modules/.bin or a package script without asking; otherwise confirm."
fi

# Reading a secret file through the shell — the Read hook's twin: cat .env, grep KEY .env, source .env.
# Only a part of the command (split on ; & | and newlines) that starts with a read verb is scanned, so
# `echo .env >> .gitignore && cat x` and a commit message that mentions .env pass; redirect targets are
# skipped. Extension-only names (*.key, *.pem) count only for an existing file: `grep "event.key" src`.
while IFS= read -r seg; do
  read -r -a words <<<"$seg" || true
  n=${#words[@]}
  i=0
  while [ "$i" -lt "$n" ]; do
    w=${words[$i]}
    w=${w#"${w%%[!\$\(\{\`\!]*}"}
    case "$w" in
      ''|env|command|exec|nohup|time|sudo|then|do|else|*=*) i=$((i + 1)) ;;
      *) break ;;
    esac
  done
  [ "$i" -lt "$n" ] || continue
  case "$w" in
    cat|less|more|head|tail|bat|nl|strings|xxd|od|base64|grep|egrep|rg|awk|sed|cut|sort|source|.) ;;
    *) continue ;;
  esac
  skip=""
  i=$((i + 1))
  while [ "$i" -lt "$n" ]; do
    w=${words[$i]}
    i=$((i + 1))
    case "$w" in
      '>'|'>>'|'2>'|'2>>'|'&>') skip=1; continue ;;
      '>'*|'2>'*) continue ;;
    esac
    [ -n "$skip" ] && { skip=""; continue; }
    # One character at a time: a bracket class inside ${//} is unreliable in bash 3.2.
    w=${w//\"/}; w=${w//\'/}; w=${w//\`/}; w=${w//</}; w=${w//\(/}; w=${w//\)/}
    [ -z "$w" ] && continue
    if is_secret_path "$w" word; then
      decide_ask "This command reads $w — it may hold secrets, and what the agent reads can leak. Use the .example copy, or confirm."
    fi
  done
done < <(printf '%s\n' "$cmd" | tr ';&|' '\n\n\n')

# JS package managers, read word by word (V17): a bare install (`install`, `i -w`, a bare `yarn`) adds whatever
# package.json names, also a package the agent just wrote there, and so does `update`/`up`. From the lockfile
# only nothing new comes in: --frozen-lockfile, --immutable (yarn only), `ci` (FROZEN_OK). Global flags
# (`-C dir`, `--filter x`), redirects (`2>&1`, `> log`) and `corepack` are skipped, so they hide nothing. The
# same in every repo and fixed here, not in installPatterns, so `update` brings it to existing repos.
JS_PMS='|pnpm|npm|yarn|bun|'
FROZEN_OK='|pnpm:lock|bun:lock|yarn:lock|yarn:immutable|'
BARE_MSG="A bare install may add packages that are not in the lockfile, such as one just written to package.json. Install from the lockfile: add --frozen-lockfile (yarn: --immutable; npm: use ci); a new package needs the human's yes."
ADD_MSG="This command installs or updates packages from outside the repo. Confirm first."
js_word() { # strip quotes, brackets and command-substitution marks around a word
  local w=$1
  w=${w#"${w%%[!\$\(\{\`\!]*}"}
  w=${w//\"/}; w=${w//\'/}; w=${w//\`/}; w=${w//\(/}; w=${w//\)/}
  printf '%s' "$w"
}
while IFS= read -r seg; do
  read -r -a words <<<"$seg" || true
  n=${#words[@]}
  i=0
  pm=""
  while [ "$i" -lt "$n" ]; do
    w=$(js_word "${words[$i]}")
    i=$((i + 1))
    case "$w" in
      ''|env|command|exec|nohup|time|sudo|then|do|else|corepack|*=*) continue ;;
      bash|sh|zsh) [ "$i" -lt "$n" ] && [ "${words[$i]}" = "-c" ] && i=$((i + 1)); continue ;;
    esac
    case "$JS_PMS" in *"|$w|"*) pm=$w ;; esac
    break
  done
  [ -n "$pm" ] || continue
  sub="" pkgs=0 frozen="" info=""
  while [ "$i" -lt "$n" ]; do
    w=$(js_word "${words[$i]}")
    i=$((i + 1))
    case "$w" in
      '') ;;
      '>'|'>>'|'<'|'2>'|'2>>'|'&>'|'&>>') i=$((i + 1)) ;;
      [0-9]'>'*|'>'*|'<'*|'&>'*) ;;
      --frozen-lockfile|--frozen-lockfile=true) frozen=lock ;;
      --immutable) frozen=immutable ;;
      -v|--version|-h|--help) info=1 ;;
      -C|--dir|--filter|-F|--prefix|--cwd|--workspace|-w)
        # The value of a global flag, unless it is the subcommand itself (`-w install`).
        if [ "$i" -lt "$n" ]; then
          case "$(js_word "${words[$i]}")" in install|i|add|up|update|upgrade|ci) ;; *) i=$((i + 1)) ;; esac
        fi ;;
      -*) ;;
      *) if [ -z "$sub" ]; then sub=$w; else pkgs=$((pkgs + 1)); fi ;;
    esac
  done
  case "$sub" in
    add) if [ "$pkgs" -gt 0 ]; then decide_ask "$ADD_MSG"; fi ;;
    up|update|upgrade) decide_ask "$ADD_MSG" ;;
    install|i|'')
      # A bare word is only an install for yarn, and not `yarn -v` / `yarn --help`.
      if [ -z "$sub" ] && { [ "$pm" != yarn ] || [ -n "$info" ]; }; then continue; fi
      if [ "$pkgs" -gt 0 ]; then decide_ask "$ADD_MSG"; fi
      case "$FROZEN_OK" in
        *"|$pm:$frozen|"*) ;;
        *) decide_ask "$BARE_MSG" ;;
      esac ;;
  esac
# `(` and backticks split too, so `echo $(… install)` is its own command.
done < <(printf '%s\n' "$cmd" | tr ';&|(`' '\n\n\n\n\n')

# Redirects are not package names: `install --frozen-lockfile 2>&1 | tail` must not read `2` as one.
cmd_plain=$(printf '%s' "$cmd" | sed -E 's/[0-9]*(>>?|<|&>>?)(&[0-9-]+|[[:space:]]*[^[:space:];&|<>()]+)?//g')

# Installing anything from outside: ask in interactive mode, never in autonomous mode.
while IFS= read -r pat; do
  [ -z "$pat" ] && continue
  if printf '%s' "$cmd_plain" | grep -Eq "${CMD_START}(${pat})"; then
    if [ "$(gate_get '.mode')" = "autonomous" ]; then
      echo "Blocked: autonomous mode never installs anything. Record it under NEEDS HUMAN DECISION and move on." >&2
      exit 2
    fi
    jq -n '{
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: "This command installs something from outside the repo. Confirm first."
      }
    }'
    exit 0
  fi
done < <(gate_list '.installPatterns')

exit 0
