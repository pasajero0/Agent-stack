# Claude Code Harness — Deployment Guide (JS/TS · React · React Native · Next.js)

Hand this file to a coding agent to set up a complete Claude Code working environment on a **new
JS/TS/React/React Native/Next.js repository**. It has three layers:

1. **Native plugins** — install official Claude Code plugins for code intelligence (LSP), service
   integrations (MCP), and workflows. *Don't reinvent these.*
2. **Custom harness** — drop a `.claude/` directory (hooks, agents, commands, skills, settings)
   and a repo-root `CLAUDE.md` (§2.7). Full verbatim sources are below. This is the part Anthropic
   does **not** ship.
3. **Per-repo specialization** — generate path-scoped rules for *this* codebase, wire the linter,
   git hooks, and git-exclude.

Guiding principle: **ride the native rails (plugins do install/version/LSP/MCP); add only what's
missing (our guards, discipline, and rules).**

Tags: **VERBATIM** = copy as-is · **PARAM** = copy then adjust the marked values · **PER-REPO** =
generate/author against the target repo.

---

## 0. Prerequisites

- **Claude Code**, recent version. Older versions reject the current plugin-marketplace schema.
  `claude --version`; if old: `claude update` (or `npm i -g @anthropic-ai/claude-code@latest` /
  `brew upgrade claude-code`). Plugins activate on the **next session** (restart after installing).
- **Node ≥ 18** and **pnpm** (this stack is pnpm-only).
- **On the hook-runner PATH**: `jq`, `git`, `timeout`, `python3`.
- **`typescript-language-server`** on PATH — required by the `typescript-lsp` plugin
  (`npm i -g typescript-language-server typescript`, or via your version manager).

---

## 1. Native plugins (install — do not hand-roll)

The official marketplace `claude-plugins-official` is auto-registered on first interactive launch.
If running non-interactively first: `claude plugin marketplace add anthropics/claude-plugins-official`.

```bash
# Code intelligence — ONE LSP covers TS/React/React Native/Next (all TypeScript)
claude plugin install typescript-lsp@claude-plugins-official      # needs typescript-language-server

# Service integrations (MCP) — pick what the project uses
claude plugin install github@claude-plugins-official              # issues / PRs / repo
claude plugin install figma@claude-plugins-official               # design → component
claude plugin install sentry@claude-plugins-official              # web/RN error monitoring

# Workflow
claude plugin install security-guidance@claude-plugins-official   # per-change security review
claude plugin install commit-commands@claude-plugins-official     # commit / push / PR skills
claude plugin install pr-review-toolkit@claude-plugins-official   # PR-review agents
```

Notes:
- Scope: `--scope user` (all your projects) or `--scope project` (writes `.claude/settings.json`,
  shared with collaborators). For a personal harness use **user**; for a team repo use **project**.
- After installing, **restart the session** (or `/reload-plugins`).
- LSP gives Claude automatic post-edit diagnostics + code navigation (go-to-def, find-refs) — it
  replaces grep-based hunting and catches type errors in the same turn. It needs the language-server
  **binary** present; check the `/plugin` Errors tab if it says "Executable not found in $PATH".

> Why these and not our own: Claude Code plugins natively handle install/versioning/scope/auto-update
> and ship LSP-by-language + MCP-by-service. The custom harness below is only the part they don't cover.

---

## 2. Custom harness — `.claude/` + root `CLAUDE.md`  (the part you deploy by hand)

Create the tree, then write the files from the sections below:

```bash
mkdir -p .claude/{hooks,rules,skills,commands,agents,tmp}
```

After writing the hook scripts: `chmod +x .claude/hooks/*.sh`.

### 2.1 `.claude/settings.json` — hook registration + allow-list  (VERBATIM; allow is PARAM)

Hook paths use `$CLAUDE_PROJECT_DIR`, so the `hooks` block transfers unchanged.

```json
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "permissions": {
    "allow": [
      "Bash(pnpm typecheck:*)",
      "Bash(pnpm test:*)",
      "Bash(pnpm build:*)",
      "Bash(git status:*)",
      "Bash(git diff:*)",
      "Bash(git log:*)",
      "Bash(git show:*)",
      "Bash(gh pr view:*)",
      "Bash(gh pr diff:*)",
      "Bash(gh api:*)",
      "WebSearch"
    ]
  },
  "hooks": {
    "PreToolUse": [
      { "matcher": "Bash", "hooks": [{ "type": "command", "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/guard-bash.sh" }] },
      { "matcher": "Edit|Write|MultiEdit", "hooks": [{ "type": "command", "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/guard-file.sh" }] }
    ],
    "SessionStart": [ { "hooks": [{ "type": "command", "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/session-start-context.sh" }] } ],
    "Stop":         [ { "hooks": [{ "type": "command", "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/stop-flag-reflect.sh" }] } ],
    "PostToolUse":  [ { "matcher": "Edit|Write|MultiEdit", "hooks": [
        { "type": "command", "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/post-edit-lint.sh" },
        { "type": "command", "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/post-edit-verify.sh" }
    ] } ]
  }
}
```

### 2.2 `.claude/settings.local.json` — read-deny for generated noise  (PARAM: lockfile/build dirs)

```json
{
  "permissions": {
    "allow": ["WebSearch", "Bash(gh api:*)"],
    "deny": [
      "Read(./**/dist/**)",
      "Read(./**/build/**)",
      "Read(./**/.next/**)",
      "Read(./**/coverage/**)",
      "Read(./**/*.d.ts)",
      "Read(./**/*.map)",
      "Read(./**/pnpm-lock.yaml)",
      "Read(./**/node_modules/**)"
    ]
  }
}
```

### 2.3 Hooks (`.claude/hooks/`)

**Platform notes (read first):** the hook runner may exec scripts via `zsh -c` — use `printf '%s'`
(never `echo`) for JSON/escaped content. Hooks **fail open**: only `exit 2` in a PreToolUse guard
blocks the call; any other failure lets the tool proceed. Guards catch *mistakes*, not a determined
bypass.

#### `guard-bash.sh` — PARAM (package-manager block per stack)

```bash
#!/usr/bin/env bash
# PreToolUse(Bash) — hard prohibitions.
set -euo pipefail
cmd=$(jq -r '.tool_input.command // empty')
[ -z "$cmd" ] && exit 0

if printf '%s' "$cmd" | grep -Eq '(^|[&|;]|&&)[[:space:]]*git[[:space:]]+push\b'; then
  echo "Blocked: 'git push' is manual-only." >&2; exit 2
fi
# PARAM: forbidden package managers (this stack is pnpm-only).
if printf '%s' "$cmd" | grep -Eq '(^|[&|;]|&&)[[:space:]]*(npm|yarn|bun)[[:space:]]'; then
  echo "Blocked: this repo uses pnpm only." >&2; exit 2
fi
exit 0
```

#### `guard-file.sh` — PARAM (generated globs per build tool)

```bash
#!/usr/bin/env bash
# PreToolUse(Edit|Write|MultiEdit) — protect generated + secret files.
set -euo pipefail
path=$(jq -r '.tool_input.file_path // empty')
[ -z "$path" ] && exit 0

# PARAM: build outputs that must never be hand-edited (tsup/tsc/next/expo/metro).
case "$path" in
  */dist/*|dist/*|*/build/*|*/.next/*|*.d.ts|*.map)
    echo "Blocked: auto-generated build output — never edit by hand." >&2; exit 2 ;;
esac
# Lockfile — regenerate via pnpm, never hand-edit.
case "$path" in
  *pnpm-lock.yaml)
    echo "Blocked: pnpm-lock.yaml is generated by pnpm — never edit by hand." >&2; exit 2 ;;
esac
# Secrets — ask before writing.
case "$path" in
  *.env|*.env.*)
    jq -n '{hookSpecificOutput:{hookEventName:"PreToolUse",permissionDecision:"ask",permissionDecisionReason:"Editing an env file — it may contain secrets. Confirm before writing."}}'
    exit 0 ;;
esac
exit 0
```

#### `session-start-context.sh` — VERBATIM

```bash
#!/usr/bin/env bash
# SessionStart — write a start-marker for the Stop hook + inject git context on fresh starts.
set -euo pipefail
input=$(cat)
session_id=$(echo "$input" | jq -r '.session_id // "unknown"')
cwd=$(echo "$input" | jq -r '.cwd // "."')
src=$(echo "$input" | jq -r '.source // "startup"')

mkdir -p /tmp/claude-sessions
find /tmp/claude-sessions -maxdepth 1 -type f -name '*.start' -mtime +1 -delete 2>/dev/null || true
touch "/tmp/claude-sessions/$session_id.start"

case "$src" in
  startup|clear)
    if git -C "$cwd" rev-parse 2>/dev/null >/dev/null; then
      branch=$(git -C "$cwd" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)
      last=$(git -C "$cwd" log -1 --pretty='%h %s' 2>/dev/null || echo none)
      changed=$(git -C "$cwd" status --short 2>/dev/null | head -20)
      echo "## Session context"; echo
      echo "- Branch: \`$branch\`"
      echo "- Last commit: $last"
      if [ -n "$changed" ]; then
        echo "- Working tree (first 20):"; echo '```'; echo "$changed"; echo '```'
      else
        echo "- Working tree: clean"
      fi
      echo
    fi
    ;;
esac

if ls "${CLAUDE_PROJECT_DIR:-$cwd}"/.claude/tmp/*-plan.md >/dev/null 2>&1; then
  echo "⚠️ Active migration plan(s):"; ls "${CLAUDE_PROJECT_DIR:-$cwd}"/.claude/tmp/*-plan.md
  echo "Re-read before acting; use the migration skill to continue."; echo
fi

if [ -f /tmp/.claude-reflect-pending ]; then
  echo "💡 Memory changed last session — consider \`/reflect\` to consolidate."; echo
  rm -f /tmp/.claude-reflect-pending
fi
exit 0
```

#### `stop-flag-reflect.sh` — VERBATIM (self-derives the memory slug at runtime)

```bash
#!/usr/bin/env bash
# Stop — fires every turn. If memory changed since session start, raise the /reflect flag.
set -euo pipefail
input=$(cat)
session_id=$(echo "$input" | jq -r '.session_id // "unknown"')
marker="/tmp/claude-sessions/$session_id.start"
[ -f "$marker" ] || exit 0

# Memory dir = $HOME/.claude/projects/<cwd-with-each-slash-as-dash>/memory
cwd=$(echo "$input" | jq -r '.cwd // empty')
[ -z "$cwd" ] && exit 0
slug="${cwd//\//-}"
MEM="$HOME/.claude/projects/${slug}/memory"
[ -d "$MEM" ] || exit 0

if find "$MEM" -maxdepth 1 -name '*.md' -newer "$marker" -print -quit 2>/dev/null | grep -q .; then
  touch /tmp/.claude-reflect-pending
fi
exit 0
```

#### `post-edit-verify.sh` — VERBATIM (D12; active only during a migration)

```bash
#!/usr/bin/env bash
# PostToolUse(Edit|Write|MultiEdit) — post-apply diff check. Active ONLY when a migration plan exists.
# set -u without pipefail (SIGPIPE on head); always exit 0.
set -u
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
ls "$PROJECT_DIR/.claude/tmp"/*-plan.md >/dev/null 2>&1 || exit 0

input=$(cat)
path=$(echo "$input" | jq -r '.tool_input.file_path // empty')
[ -z "$path" ] && exit 0
case "$path" in /*) abs="$path" ;; *) abs="$PROJECT_DIR/$path" ;; esac
case "$abs" in *.gen.*|*/node_modules/*|*/dist/*|*/build/*|*/.next/*|*/coverage/*) exit 0 ;; esac

cd "$PROJECT_DIR" 2>/dev/null || exit 0
if git ls-files --error-unmatch -- "$abs" >/dev/null 2>&1; then
  diff_output=$(timeout 10 git diff -U2 -- "$abs" 2>/dev/null | head -200)
else
  diff_output=$(head -50 "$abs" 2>/dev/null)
fi
[ -z "$diff_output" ] && exit 0

ctx="POST-APPLY VERIFY (D12) $abs:
$diff_output

(diff may include earlier uncommitted changes to this file)
Compare against the approved preview. Report any mismatch before marking the step done."

if command -v python3 >/dev/null 2>&1; then
  printf '%s' "$ctx" | python3 -c 'import json,sys; print(json.dumps({"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":sys.stdin.buffer.read().decode("utf-8","replace")}}))'
else
  tmpf=$(mktemp); printf '%s' "$ctx" > "$tmpf"
  jq -nc --rawfile ctx "$tmpf" '{hookSpecificOutput:{hookEventName:"PostToolUse","additionalContext":$ctx}}'
  rm -f "$tmpf"
fi
exit 0
```

#### `post-edit-lint.sh` — PARAM ⚠️ (linter)

Surfaces linter findings as `additionalContext` after edits. **Contract:** never `--fix` (keeps
Claude's file-state tracking consistent); emit via `additionalContext`, not stderr; self-disable if
the linter is absent.

This stack uses **Biome**. The example below is the generic ESLint-JSON shape; **for Biome you must
swap the binary to `biome check --reporter=json` and rewrite the `jq` filter for Biome's
`diagnostics` schema** (Biome's severities are strings, not the ESLint `severity` number). Until
Biome is wired, the hook self-disables and `pnpm typecheck` (`tsc --noEmit`) is the gate.

```bash
#!/usr/bin/env bash
# PostToolUse — lint edited JS/TS; surface issues as additionalContext. No --fix.
set -euo pipefail
input=$(cat)
path=$(echo "$input" | jq -r '.tool_input.file_path // empty')
[ -z "$path" ] && exit 0
case "$path" in *.ts|*.tsx|*.js|*.jsx|*.mts|*.cts) ;; *) exit 0 ;; esac
case "$path" in *.gen.*|*/node_modules/*|*/dist/*|*/build/*|*/.next/*|*/coverage/*) exit 0 ;; esac

# PARAM: point at your linter (here: project-local Biome). Self-disables if missing.
LINTER="${CLAUDE_PROJECT_DIR:-$(pwd)}/node_modules/.bin/biome"
[ -x "$LINTER" ] || exit 0

out=$(timeout 20 "$LINTER" check --reporter=json "$path" 2>/dev/null) || true
echo "$out" | jq empty 2>/dev/null || exit 0
# PARAM ⚠️: adapt this filter to Biome's actual JSON (diagnostics[].severity/location/description).
filtered=$(echo "$out" | jq -r '.diagnostics[]? | "  \(.severity) \(.location.path // "")  \(.description)"' 2>/dev/null)
if [ -n "$filtered" ]; then
  jq -nc --arg ctx "Biome issues in $(basename "$path"):
$filtered" '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:$ctx}}'
fi
exit 0
```

### 2.4 Agents (`.claude/agents/*.md`)

Four generic agents (read-only reviewers have no `Write`/`Bash`). Frontmatter is portable; the
bodies are summarized here — for full bodies see `templates/claude/agents/*.md` in this repo
(tokenized: `{{DOCS_DIR}}`).

- **`task-analyzer.md`** — `model: opus`, `tools: Read, Glob, Grep`. Intake validation
  (clarity/context/constraints/creativity) then decomposition: affected modules, subtasks, deps,
  tests, suggested commits. Explore 2-3 existing analogues before proposing new structure.
- **`code-reviewer.md`** — `model: sonnet`, `tools: Read, Glob, Grep`. **Grep the changed files for
  anti-patterns first**, then read, then report by severity (critical/warning/suggestion). When one
  site is flagged, grep the touched files for every analogous occurrence.
- **`test-writer.md`** — `model: sonnet`, `tools: Read, Glob, Grep, Write, Edit, Bash`. Read
  neighbouring tests first; semantic queries (role > label > text > test-id); wait on final async
  state, no brittle DOM selectors; meaningful assertions only.
- **`pattern-scout.md`** — `model: opus`, `tools: Read, Glob, Grep, Write, Edit`. Reads architecture
  docs + code, generates the **path-scoped rules** (§3.1). Mark code-derived rules `[DRAFT]`.

**Recommended addition for this stack — `performance-analyzer.md`** (`model: sonnet`, read-only):
React/RN re-render & bundle analysis — observation → cause → impact → fix. Grep for inline
object/array/style props, missing memoization, full-library imports, missing TanStack Query
cache config, long lists without virtualization, high-frequency handlers without debounce.

### 2.5 Commands (`.claude/commands/*.md`)

- **`reflect.md`** — `allowed-tools: Bash(ls:*), Bash(cat:*)`. Injects the memory dir
  (`!`ls -la "$HOME/.claude/projects/$(pwd | sed 's#/#-#g')/memory"``) and proposes a dedup/cleanup
  **as a diff** — never edits memory automatically.
- **`review.md`** — `allowed-tools: Bash(git diff:*), Bash(git status:*), Bash(git log:*)`. Injects
  `!`git diff ${1:-main}...HEAD``; instruct: read the diff yourself first, then run the
  **code-reviewer** subagent against the `.claude/rules/`. Treat Critical as merge-blocker.

### 2.6 Skills (`.claude/skills/`)

- **`migration/SKILL.md`** — anti-drift loop for multi-file refactors. Must live at exactly
  `.claude/skills/migration/SKILL.md` (it resolves the plan dir via `${CLAUDE_SKILL_DIR%/skills/*}/tmp`).
  No plan → draft invariants to `.claude/tmp/<task>-plan.md`, await approval; plan present → next
  step with a compliance header (`Plan check: D1 — ok; D3 — n/a`), re-read files, deviations flagged
  as `ОТКЛОНЕНИЕ ОТ ПЛАНА`; after applying → diff-vs-preview; all done → propose deleting the plan.
- **`mr-description/SKILL.md`** — GitHub PR description: dynamic `!`git log ...`` injection, deliver
  as a **single fenced code block**, `Closes #NN`.
- Reference stubs (fill per project): `repo-structure.md`, `team-conventions.md`, `ci-testing-patterns.md`.

### 2.7 `CLAUDE.md` (repo root) — project body + two VERBATIM normative sections

Author the project body (stack, structure, critical rules) for the target repo, then append these
**verbatim**:

```markdown
## Multi-step migrations
Before any multi-file migration or refactor, write decision invariants to
`.claude/tmp/<task>-plan.md`. Re-read that plan from disk (not memory) immediately before composing
each diff preview, and open every diff preview with a compliance header — e.g.
`Plan check: D1 — ok; D3 — n/a`. Any deviation requires explicit user approval before the diff —
surface it as `ОТКЛОНЕНИЕ ОТ ПЛАНА` with rationale.

## Scope discipline
- Debug budget for support machinery: 2 iterations max; on the third, simplify or defer.
- Nesting limit: if work is >2 levels removed from the original task — stop and ask.
- Cost/value framing: a new support mechanism leads with one line — cost / value / cost-of-not-doing.
- Plan starts with the goal: the first line of any plan is the user's original goal verbatim.
```

---

## 3. Per-repo specialization

### 3.1 Path-scoped rules — `.claude/rules/*.md`  (PER-REPO; never copied)

Rules are machine-checkable conventions that load only when a matching file is touched. **Generate
them with the `pattern-scout` agent against this repo's code/docs** — do not copy another project's
rules. Template:

```markdown
---
description: <what this rule enforces and when it fires>
paths:
  - "src/**/*.{ts,tsx}"
---
# <Rule name>
## Do
- <convention> — detect: `<grep regex>` — severity: critical/warning/suggestion
## Don't
- <banned pattern> — detect: `<grep regex>`
## Why
<the failure mode this prevents>
```

Stack-specific rule zones to generate:
- **React components/hooks** — rules-of-hooks, stable keys, no inline objects/styles as props.
- **Next.js (App Router / RSC)** — no client-only hooks in Server Components; `"use client"` placement;
  `next/image`, metadata, route handlers.
- **React Native** — platform-split files, no web-only APIs; `FlatList` for long lists; Expo vs bare
  constraints.
- **Data fetching** — TanStack Query key/cache conventions.
- **Biome** — encode the project's lint rules as grep-able anti-patterns for the reviewer.

### 3.2 Linter — Biome  (PARAM)

```bash
pnpm add -D @biomejs/biome
pnpm biome init      # biome.json — enable linter + formatter for TS/JS
```
Then point `post-edit-lint.sh` at `node_modules/.bin/biome` and adapt its `jq` filter to Biome's
diagnostics JSON (§2.3). For React/Next/RN-specific lint rules Biome doesn't cover, optionally add a
thin ESLint layer (`eslint-plugin-react-hooks`, `@next/eslint-plugin-next`,
`eslint-plugin-react-native`).

### 3.3 Git hooks (husky + commitlint)

- `.husky/commit-msg` → `pnpm exec commitlint --edit $1` (Conventional Commits).
- `.husky/pre-commit` → `pnpm typecheck` (+ `pnpm biome check` once Biome is wired).

### 3.4 Exclude the personal harness from git

Add to **`.git/info/exclude`** (not `.gitignore`) so the ignore itself isn't committed. **Anchor
each entry with a leading `/`** so it only matches the repo root (an unanchored `CLAUDE.md` would,
on a case-insensitive filesystem, also ignore `docs/claude.md`):

```
/.claude/
/CLAUDE.md
/CODEMAP.md
```

### 3.5 Memory

Auto-memory lives at `~/.claude/projects/<slug>/memory/` where `<slug>` = the absolute cwd with each
`/` replaced by `-`. Created automatically. Seed a `MEMORY.md` index. Carry over only **durable**
notes (`feedback_*`, `user_*`) from prior projects; leave behind `project_*`/`reference_*`.

---

## 4. Deploy checklist (ordered)

1. Verify prerequisites (§0); ensure `typescript-language-server` is on PATH.
2. Install native plugins (§1); **restart the session**.
3. `mkdir -p .claude/{hooks,rules,skills,commands,agents,tmp}`.
4. Write `settings.json` + `settings.local.json` (§2.1–2.2).
5. Write the 6 hooks (§2.3); `chmod +x .claude/hooks/*.sh`.
6. Write the 4 agents + commands + skills + `CLAUDE.md` (§2.4–2.7).
7. Wire Biome + husky (§3.2–3.3); add `.git/info/exclude` (§3.4, **anchored**).
8. Run **pattern-scout** to generate `.claude/rules/*` for this codebase (§3.1).
9. Smoke-test (§5).

---

## 5. Verification

1. **Guards:** `git push` → blocked (exit 2); `npm i` → blocked; editing `dist/x.js` or
   `pnpm-lock.yaml` → blocked; editing a `.env` → "ask"; `git status` / editing `src/x.ts` → pass.
   Test a hook directly: `printf '%s' '{"tool_input":{"command":"git push"}}' | .claude/hooks/guard-bash.sh; echo $?`
2. **LSP:** introduce a type error in a `.ts` file → Claude should see the diagnostic from the
   `typescript-lsp` plugin (and `LSP` navigation operations work). Revert.
3. **D12 verify:** create a throwaway `.claude/tmp/x-plan.md`, edit a source file → the
   post-edit-verify hook injects a "POST-APPLY VERIFY (D12)" block. Delete the plan → silent again.
4. **Memory/reflect:** `ls ~/.claude/projects/` shows a dir matching the cwd slug; touch a file
   under its `memory/`, end a turn, start a new session → the `💡 /reflect` notice appears.

---

## 6. Gotchas (learned the hard way)

- **nvm + GUI git clients (GitKraken, VS Code Source Control).** GUI apps don't load your shell rc,
  so husky hooks can't find `pnpm`/`node` (nvm path) → commit fails with "command not found". Fix:
  create `~/.config/husky/init.sh` adding the node bin to PATH:
  ```sh
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  node_bin="$(ls -d "$NVM_DIR"/versions/node/*/bin 2>/dev/null | sort -V | tail -1)"
  [ -n "$node_bin" ] && export PATH="$node_bin:$PATH"
  ```
- **Keep Claude Code updated** — an old CLI rejects the current marketplace schema
  (`plugins.N.source: Invalid input`). `claude update` fixes it; plugins activate next session.
- **LSP needs the language-server binary** on PATH (`typescript-language-server`); otherwise the
  plugin loads but does nothing (see `/plugin` Errors tab).
- **Anchor `.git/info/exclude` entries** with `/` (§3.4) — case-insensitive filesystems otherwise
  ignore nested files of the same name.
- **Hooks fail open & guards are blocklists** — they catch mistakes, not a determined bypass
  (regex is evadable via quotes/variables/pipes). For irreversible ops prefer allowlist + confirm.
- **Hook-injected text is a prompt-injection surface** — SessionStart injects commit messages/branch
  names; the lint hook quotes file content and runs repo-controlled config; D12 surfaces raw diffs.
  Treat injected text as data; be aware repo-controlled code executes.

---

## 7. What is NOT in this harness (and why)

- **Distribution/versioning/update of the harness** → use Claude Code **plugins + marketplaces**
  (native: scope, auto-update, versioning). Package §2 as a plugin if you want team-wide install.
- **LSP servers, MCP integrations** → official plugins (§1), not hand-rolled.
- **Persona/agent *generation*** → out of scope; the agents above are fixed, the rules are generated
  per-repo by pattern-scout.
```
