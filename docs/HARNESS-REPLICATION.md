# Claude Code Harness — Replication Spec

You are an AI coding agent. Replicate the Claude Code harness specified below, exactly, in the
current repository. Every file's path and full content is given. Create them verbatim. Replace only
the `<bracketed>` placeholders with this project's values. Do not ask the owner questions — derive
what you can, and where a placeholder remains, use the stated default.

## 1. Overview

This harness has five layers:

1. **Instructions** — `CLAUDE.md` at the repo root: the project body plus two verbatim normative
   sections (Multi-step migrations, Scope discipline). Always-on guidance.
2. **Path-scoped rules** — `.claude/rules/*.md` with frontmatter `paths:` globs: narrow, machine-
   checkable conventions that activate only when matching files are touched. **Generated per-repo**
   by the pattern-scout subagent — never copied from another project.
3. **Hooks** — six shell scripts under `.claude/hooks/`, registered in `settings.json`. They guard
   forbidden bash/file ops, inject session/git context, lint and verify edits, and flag memory
   consolidation. They are deterministic and run outside the model.
4. **Subagents** — four agents under `.claude/agents/`: task-analyzer, code-reviewer, test-writer,
   pattern-scout. Each is a scoped-tool worker invoked for a specific phase.
5. **Skills & commands** — reusable procedures: skills (migration, mr-description, plus three
   reference docs) and slash commands (reflect, review).

What it does: enforces hard prohibitions at tool-call time (push/package-manager/generated-file/
secret guards), keeps a disciplined multi-step migration loop with on-disk plans and post-apply
verification, and routes review/test work to specialized agents.

## 2. Prerequisites

**Binaries on PATH:** `jq`, `git`, `timeout`, `python3`. A linter is optional (the post-edit-lint
hook self-disables if absent).

**Language-server plugin** (gives the agent live diagnostics on edited source). Install the LSP
plugin matching the project's primary language:

```bash
claude plugin marketplace add anthropics/claude-plugins-official
claude plugin install typescript-lsp@claude-plugins-official
```

Use the language-server plugin matching the project's language (e.g. a Python/Go/Rust LSP plugin if
the repo is not TypeScript).

**Global `~/.claude/settings.json`** (user-level, outside the repo):

```json
{
  "effortLevel": "max",
  "model": "opus[1m]"
}
```

## 3. Platform facts (read before deploying hooks)

- **zsh/printf gotcha.** The hook runner may execute scripts via `zsh -c`, whose `echo` builtin
  interprets `\n` escapes by default — that can turn valid escaped JSON back into raw line-feeds and
  break downstream JSON parsing. Always build hook JSON with `jq`/`python3` and emit raw bytes with
  `printf '%s'`, never `echo`, when correctness of escapes matters.
- **Fail-open hooks.** Context/verify/lint hooks must always `exit 0` even on internal error — a
  crashing hook must never block the agent. Only the _guard_ hooks intentionally `exit 2` to block a
  forbidden action.
- **Memory-slug self-derivation.** The Stop hook locates the auto-memory dir by deriving a slug from
  the session's absolute cwd (every `/` → `-`). Claude Code derives this slug the same way; **if the
  auto-derived path is wrong the hook fails SILENTLY** (no error — the `/reflect` flag just never
  fires). Verify once by running `ls ~/.claude/projects/` after the first session and confirm the
  directory name matches the derived slug; adjust if case/sanitization differs.

## 4. Deploy checklist (in order)

1. `mkdir -p .claude/{hooks,rules,skills,commands,agents,tmp}`
2. Write `.claude/settings.json` and `.claude/settings.local.json` (Section 5.1, 5.2).
3. Write the six hook scripts (Section 5.3) and `chmod +x .claude/hooks/*.sh`.
4. Write the four agents (5.4), two commands (5.5), and five skills (5.6).
5. **Generate the path-scoped rules** by running the **pattern-scout** subagent against this repo's
   code and architecture docs (Section 5.7). Do NOT copy another project's rules.
6. Write `CLAUDE.md` (project body + the two verbatim normative sections, Section 5.8) and
   `CODEMAP.md` (a short map of where things live — apps, packages, entry points).
7. Add the harness to the repo's local git exclude so it is never committed:
   `printf '%s\n' '.claude/' 'CLAUDE.md' 'CODEMAP.md' >> .git/info/exclude`
8. Set up an off-host backup of `.claude/` (the harness is git-excluded, so it is not in the repo's
   history — copy it somewhere durable, e.g. a private gist or a synced dir).
9. Smoke-test the guards (Section 6).

## 5. Inline content

### 5.1 `.claude/settings.json`

`permissions.allow` is a generic starter set — **adjust to your tooling** (replace the typecheck/
lint/test command prefixes with this project's, and the forge CLI with yours).

```json
{
  "$schema": "https://json.schemastore.org/claude-code-settings.json",
  "permissions": {
    "allow": [
      "Bash(<typecheck-command>:*)",
      "Bash(<lint-command>:*)",
      "Bash(<test-command>:*)",
      "Bash(git status:*)",
      "Bash(git diff:*)",
      "Bash(git log:*)",
      "Bash(git show:*)",
      "Bash(<forge-cli> api:*)",
      "Bash(<forge-cli> pr view:*)",
      "Bash(<forge-cli> pr diff:*)",
      "WebSearch"
    ]
  },
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/guard-bash.sh"
          }
        ]
      },
      {
        "matcher": "Edit|Write|MultiEdit",
        "hooks": [
          {
            "type": "command",
            "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/guard-file.sh"
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/session-start-context.sh"
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/stop-flag-reflect.sh"
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "Edit|Write|MultiEdit",
        "hooks": [
          {
            "type": "command",
            "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/post-edit-lint.sh"
          },
          {
            "type": "command",
            "command": "$CLAUDE_PROJECT_DIR/.claude/hooks/post-edit-verify.sh"
          }
        ]
      }
    ]
  }
}
```

### 5.2 `.claude/settings.local.json`

`permissions.deny` blocks the agent from reading build/generated noise — **adjust the globs to your
outputs**. `allow` is left minimal.

```json
{
  "permissions": {
    "allow": ["WebSearch", "Bash(<forge-cli> api:*)"],
    "deny": [
      "Read(./**/dist/**)",
      "Read(./**/build/**)",
      "Read(./**/coverage/**)",
      "Read(./**/*.d.ts)",
      "Read(./**/*.map)",
      "Read(./**/*.gen.*)",
      "Read(./**/<lockfile>)",
      "Read(./**/node_modules/**)"
    ]
  }
}
```

### 5.3 Hooks

#### `.claude/hooks/guard-bash.sh`

Keep the universal `git push` block verbatim. The package-manager block is generic — set `<PM>` to
the forbidden managers for your project (e.g. block `npm|yarn|bun` if the repo is pnpm-only; drop
the block entirely if the project has no package-manager restriction).

```bash
#!/usr/bin/env bash
# PreToolUse(Bash) guard — enforces hard prohibitions.
set -euo pipefail

cmd=$(jq -r '.tool_input.command // empty')
[ -z "$cmd" ] && exit 0

if printf '%s' "$cmd" | grep -Eq '(^|[&|;]|&&)[[:space:]]*git[[:space:]]+push\b'; then
  echo "Blocked: 'git push' is manual-only — the team pushes by hand." >&2
  exit 2
fi

# Package-manager guard. Set <PM> to the forbidden managers, e.g. (npm|yarn|bun) for a pnpm-only
# repo. Remove this block if the project enforces no package manager.
if printf '%s' "$cmd" | grep -Eq '(^|[&|;]|&&)[[:space:]]*(<PM>)[[:space:]]'; then
  echo "Blocked: this repo uses its sanctioned package manager only — <PM> are forbidden." >&2
  exit 2
fi

exit 0
```

#### `.claude/hooks/guard-file.sh`

The `.env`/`.env.*` "ask" behavior is verbatim. Set `*<GENERATED_FILE_GLOB>` to your build/codegen
outputs that must never be hand-edited — e.g. `dist/**`, `*.d.ts`, `*.gen.*`. Add one `case` arm per
glob (the example shows one).

```bash
#!/usr/bin/env bash
# PreToolUse(Edit|Write|MultiEdit) guard — protects generated + secret files.
set -euo pipefail

path=$(jq -r '.tool_input.file_path // empty')
[ -z "$path" ] && exit 0

case "$path" in
  *<GENERATED_FILE_GLOB>)
    echo "Blocked: this file is auto-generated — never edit it by hand." >&2
    exit 2
    ;;
esac

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
```

#### `.claude/hooks/session-start-context.sh`

Verbatim (generic — uses cwd / `CLAUDE_PROJECT_DIR`).

````bash
#!/usr/bin/env bash
# SessionStart — write start-marker for Stop hook + inject git context (only on fresh starts).
set -euo pipefail

input=$(cat)
session_id=$(echo "$input" | jq -r '.session_id // "unknown"')
cwd=$(echo "$input" | jq -r '.cwd // "."')
src=$(echo "$input" | jq -r '.source // "startup"')

mkdir -p /tmp/claude-sessions
# Sweep stale markers (>24h) so /tmp doesn't grow forever
find /tmp/claude-sessions -maxdepth 1 -type f -name '*.start' -mtime +1 -delete 2>/dev/null || true

# Always write a fresh marker for this session — Stop hook compares memory mtimes against it
touch "/tmp/claude-sessions/$session_id.start"

# Heavy git context: only on a truly new context window
case "$src" in
  startup|clear)
    if git -C "$cwd" rev-parse 2>/dev/null >/dev/null; then
      branch=$(git -C "$cwd" rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)
      last=$(git -C "$cwd" log -1 --pretty='%h %s' 2>/dev/null || echo none)
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

# Pending /reflect notice — always (cheap), regardless of source
if [ -f /tmp/.claude-reflect-pending ]; then
  echo "💡 Memory was modified in the previous session — consider running \`/reflect\` to consolidate."
  echo
  rm -f /tmp/.claude-reflect-pending
fi

exit 0
````

#### `.claude/hooks/post-edit-verify.sh`

Verbatim (generic — D12 post-apply verify, active only when a migration plan exists).

```bash
#!/usr/bin/env bash
# PostToolUse(Edit|Write|MultiEdit) — D12 post-apply verify.
# Active ONLY when at least one migration plan exists in .claude/tmp/.
# Outside active migrations: zero noise, near-zero latency.
#
# Caveat: diff is git working-tree vs HEAD, so it shows ALL uncommitted
# changes to the file, not only the change from the just-completed tool call.
# That caveat is surfaced in the additionalContext so Claude does not
# over-interpret unrelated edits.
#
# `set -e` and `pipefail` deliberately omitted: `git diff | head -200`
# triggers SIGPIPE on diffs >200 lines, which would crash the hook under
# pipefail. Defensive philosophy: always exit 0.
#
# JSON build: python3 (stdin + UTF-8 "replace" decode) preferred — survives
# non-UTF-8 bytes from arbitrary diff content. Fallback: `jq --rawfile` via
# temp file if python3 is absent.
#
# Historical note: do NOT use `echo "$out" | jq .` to post-process — the hook
# runner may exec `zsh -c`, and zsh's `echo` interprets `\n` escapes, turning
# valid escaped JSON back into raw LF before parsing. Use `printf '%s'`.
set -u

# (1) Early-exit if no active migration plan.
PROJECT_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}"
PLAN_DIR="$PROJECT_DIR/.claude/tmp"
ls "$PLAN_DIR"/*-plan.md >/dev/null 2>&1 || exit 0

# (2) Parse file path from tool_input.
input=$(cat)
path=$(echo "$input" | jq -r '.tool_input.file_path // empty')
[ -z "$path" ] && exit 0

# (3) Normalize to absolute path so case-glob matches reliably for relative paths.
case "$path" in
  /*) abs_path="$path" ;;
  *)  abs_path="$PROJECT_DIR/$path" ;;
esac

# (4) Skip noise paths (same filter spirit as post-edit-lint.sh).
case "$abs_path" in
  *.gen.*|*/node_modules/*|*/dist/*|*/build/*|*/storybook-static/*|*/coverage/*) exit 0 ;;
esac

# (5) Build diff: tracked → git diff -U2 (truncated 200 lines); untracked → head -50.
cd "$PROJECT_DIR" 2>/dev/null || exit 0
if git ls-files --error-unmatch -- "$abs_path" >/dev/null 2>&1; then
  diff_output=$(timeout 10 git diff -U2 -- "$abs_path" 2>/dev/null | head -200)
else
  diff_output=$(head -50 "$abs_path" 2>/dev/null)
fi
[ -z "$diff_output" ] && exit 0

# (6) Build ctx then emit JSON.
ctx="POST-APPLY VERIFY (D12) $abs_path:
$diff_output

(diff may include earlier uncommitted changes to this file)

Compare against the approved preview table. Report any mismatch before marking the step done."

if command -v python3 >/dev/null 2>&1; then
  printf '%s' "$ctx" | python3 -c 'import json,sys; print(json.dumps({"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":sys.stdin.buffer.read().decode("utf-8","replace")}}))'
else
  tmpf=$(mktemp)
  printf '%s' "$ctx" > "$tmpf"
  jq -nc --rawfile ctx "$tmpf" '{hookSpecificOutput:{hookEventName:"PostToolUse",additionalContext:$ctx}}'
  rm -f "$tmpf"
fi

exit 0
```

#### `.claude/hooks/post-edit-lint.sh`

The eslint path is resolved from the project's `node_modules/.bin` with a global fallback; the
noise-glob skips are generic. **If the project has no linter, either point `LINTER` at your linter
or drop this hook from `settings.json` PostToolUse and run typecheck at the commit gate instead.**
(The example is ESLint with its JSON formatter; swap the binary and its JSON-emitting invocation for
your linter if different.)

```bash
#!/usr/bin/env bash
# PostToolUse(Edit|Write|MultiEdit) — lint edited source files, surface issues as additionalContext.
# Does NOT modify the file (no --fix) — keeps Claude's file-state tracking consistent.
set -euo pipefail

input=$(cat)
path=$(echo "$input" | jq -r '.tool_input.file_path // empty')
[ -z "$path" ] && exit 0

case "$path" in
  *.ts|*.tsx|*.js|*.jsx|*.mts|*.cts) ;;
  *) exit 0 ;;
esac

case "$path" in
  *.gen.*|*/node_modules/*|*/dist/*|*/build/*|*/storybook-static/*|*/coverage/*) exit 0 ;;
esac

LINTER="${CLAUDE_PROJECT_DIR:-$(pwd)}/node_modules/.bin/eslint"
[ -x "$LINTER" ] || LINTER="$(command -v eslint || true)"
[ -x "$LINTER" ] || exit 0

CACHE_DIR=/tmp/claude-eslint-cache
mkdir -p "$CACHE_DIR"

output=$(timeout 20 "$LINTER" \
  --cache \
  --cache-location "$CACHE_DIR/" \
  --cache-strategy content \
  --format=json \
  --no-warn-ignored \
  "$path" 2>/dev/null) || true

# Parse only if output is valid JSON (eslint may bail on config errors)
echo "$output" | jq empty 2>/dev/null || exit 0

filtered=$(echo "$output" | jq -r '
  .[].messages[]?
  | select(.severity >= 1)
  | "  \(if .severity==2 then "✘" else "⚠" end) line \(.line):\(.column)  \(.message)  (\(.ruleId // "—"))"
' 2>/dev/null)

if [ -n "$filtered" ]; then
  jq -nc --arg ctx "Linter issues in $(basename "$path"):
$filtered" '{
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: $ctx
    }
  }'
fi

exit 0
```

#### `.claude/hooks/stop-flag-reflect.sh`

Self-derives the memory slug at runtime from the session cwd: read `.cwd` from stdin JSON, turn
every `/` into `-` to form the slug, and set `MEM="$HOME/.claude/projects/${slug}/memory"`. **Note:**
Claude Code derives this slug from the absolute cwd; if the auto-derived path is wrong the hook fails
SILENTLY (no error, the `/reflect` flag just never fires) — verify once by running
`ls ~/.claude/projects/` after the first session and confirm the directory name matches; adjust if
case/sanitization differs.

```bash
#!/usr/bin/env bash
# Stop — fires every assistant turn. Keep work tiny.
# If any memory file changed since session start, raise the /reflect-pending flag.
set -euo pipefail

input=$(cat)
session_id=$(echo "$input" | jq -r '.session_id // "unknown"')
marker="/tmp/claude-sessions/$session_id.start"
[ -f "$marker" ] || exit 0

# Self-derive the auto-memory dir slug from the session cwd (every "/" → "-").
cwd=$(echo "$input" | jq -r '.cwd // empty')
[ -z "$cwd" ] && exit 0
slug="${cwd//\//-}"
MEM="$HOME/.claude/projects/${slug}/memory"
[ -d "$MEM" ] || exit 0

# -quit stops at first match → ~few ms even if memory has many files
if find "$MEM" -maxdepth 1 -name '*.md' -newer "$marker" -print -quit 2>/dev/null | grep -q .; then
  touch /tmp/.claude-reflect-pending
fi

# Do NOT remove the marker — Stop fires on every turn within the same session.
exit 0
```

### 5.4 Agents

Each agent body goes at the given path. Replace `<docs-dir>`, `<ticket-id>`, etc. with this
project's values; where a placeholder has no project value, leave the guidance generic.

#### `.claude/agents/task-analyzer.md`

````markdown
---
name: task-analyzer
description: Use at the start of a non-trivial task to validate intake (clarity, context, constraints, creativity), decompose work, and identify affected areas of the codebase.
model: opus
tools: Read, Glob, Grep
---

You are a task analyzer. Two phases: intake validation, then analysis.

## Intake Validation

Before analyzing, check the request against 4 criteria. Ask ONLY about missing ones:

- **Clarity** — Is it clear WHAT to do? (vague: "fix filters" → ask what exactly)
- **Context** — Is it clear WHERE? (app/module, ticket `<ticket-id>`, existing patterns to follow)
- **Constraints** — Are there limits? (API readiness, design specs, tech restrictions, deadline)
- **Creativity** — Is the solution defined or should you propose options? (exact spec vs open question)

Rules:

- If all 4 are clear → skip intake, go straight to analysis.
- If 1-2 are missing → ask only those, in one message.
- If 3-4 are missing → ask all, grouped by criterion.
- Never ask what you can infer from the codebase (use Read/Glob/Grep first).

## Analysis

Decompose a task into subtasks, identify affected modules/packages, and produce an implementation
plan.

### What to determine

- Which apps/modules and packages are affected.
- Impact classification: single-module / cross-package / infrastructure.
- Dependencies between subtasks.
- Files to create or modify.
- Implementation sequence and commit structure.

### Before planning a new module

ALWAYS explore 2-3 existing analogues in the codebase before proposing file structure. Use
Read/Glob/Grep to find similar implementations and replicate their patterns exactly.

If the project has an "Adding a New Feature" checklist (see `<docs-dir>`), walk it and verify each
required registration/wiring step is accounted for in the plan.

Out of scope: writing code, running tests, reviewing code.

### References

- Project file-naming / commit conventions (see the team-conventions skill).
- Project architecture / component patterns under `<docs-dir>`.

### Output format

\```

## Task Analysis: <task title>

### Scope

- Apps/modules: [list]
- Packages: [list]
- Impact: single-module / cross-package / infrastructure

### Subtasks (in order)

1. [subtask] — files: [...] — complexity: low/medium/high
2. ...

### Dependencies

- [subtask X] before [subtask Y] because...

### Tests Required

- Unit: [list]
- Integration / UI: [list]

### Suggested Commits

1. `type(scope): message; <ticket-id>`
2. ...
   \```
````

#### `.claude/agents/code-reviewer.md`

```markdown
---
name: code-reviewer
description: Use proactively after writing or modifying code to review for architecture/layering, type safety, data-access patterns, security, and team conventions. Reports issues by severity (critical/warning/suggestion).
model: sonnet
tools: Read, Glob, Grep
---

You are a code reviewer. For each file: run pattern greps → read context → check against Do/Don't → report issues with severity.

## How to review

1. **Run pattern greps first.** Before reading code, grep the changed files for this project's
   known anti-patterns. Machine-checkable rules are deterministic — grep beats interpretive
   reading. Maintain the regex set in your project's rules/conventions docs (see `<docs-dir>`);
   each entry pairs a regex with a default severity. Run greps **across all changed files**, not
   file-by-file — anti-patterns cluster.
2. Read the changed files and understand the context (after greps, with hits as priors).
3. Check each file against the Do/Don't rules below and the project conventions.
4. For each issue: state what's wrong, why, and how to fix.
5. Categorize severity: critical / warning / suggestion.

**Important:** when the reviewer-invoker mentions a specific flagged anti-pattern, **also grep the
touched file(s) for analogous occurrences** of that pattern, not just the flagged line. Reviewers
point to one example to communicate the class — your job is to find every site in the touched
scope.

## Do

- Verify type-only imports use the project's type-import convention where one exists.
- Check proper error handling at system boundaries.
- Confirm data-fetching/cache keys are consistent with existing patterns.
- Verify code follows the correct architecture layer / module boundary for this project.
- Enforce module-boundary rules: only the designated layer may resolve dependencies / cross a
  boundary; the same call from the wrong layer is a breach. Fix is to route through the sanctioned
  abstraction. **Warning.**
- Check that input is validated at boundaries (parse/validate untrusted data before use).
- Verify identifiers / typed values are constructed via the sanctioned constructor, not unsafe
  casts. Flag unsafe casts that bypass a type invariant as **critical**.
- Flag inline domain validation that duplicates a shared/domain-layer rule — reference the shared
  rule instead. **Warning** if the shared rule exists; **suggestion** if it must be created.
- Flag user-facing copy embedded where only shape/structure belongs. **Warning.**
- Flag silent null/fallback handling on security-critical fields (auth tokens, credentials, session
  identifiers). Silent `null` here causes downstream auth failures later. **Critical.**
- When reviewing files that redeclare a type locally, check for an existing shared schema/type and
  prefer reusing it. **Warning** if a strict one exists; **suggestion** otherwise.
- Verify HTTP status codes follow strict semantics where the project defines them: e.g. one code
  only for missing/invalid session, a distinct code for an authenticated-but-missing-requirement
  case, and a distinct code for invalid payload. Overloading one status with multiple meanings is
  **critical**. Allowlist/URL-based workarounds are red flags — they signal an API design issue,
  not a clean fix.
- Verify tests tagged as executable actually assert (smoke-only = **warning**).
- Verify async/portal/animated assertions wait on the final state rather than racing it
  (**warning**).

## Don't

- Accept untyped escape hatches (`any` / unchecked casts) without explicit justification.
- Allow brittle DOM/implementation-detail selectors in tests.
- Allow direct mutation of values that should be immutable.
- Allow inline styling when the project's styling system should be used.
- Allow patterns the project has explicitly banned in its conventions doc.
- Allow module-level shared mutable instances where the project requires encapsulation.
- Allow non-primitive values in memoization dependency arrays — use stable primitive keys.

## Output format

For each issue:

- **Severity**: critical / warning / suggestion
- **File**: `path/to/file:line`
- **Issue**: what's wrong
- **Fix**: how to fix

## References

- Project architecture / layering rules under `<docs-dir>`
- Project data-access / DTO conventions under `<docs-dir>`
- Project HTTP-status semantics under `<docs-dir>`
- Project testing conventions under `<docs-dir>`
```

#### `.claude/agents/test-writer.md`

```markdown
---
name: test-writer
description: Use to write unit tests and component/interaction tests. Reads existing tests in the same directory first to match patterns and follows the project's testing principles.
model: sonnet
tools: Read, Glob, Grep, Write, Edit, Bash
---

You are a test writer. ALWAYS read existing tests in the same directory before writing, to match
patterns.

## How to write tests

1. Read existing tests in the same directory.
2. Read the project's testing reference docs under `<docs-dir>` and the testing-conventions skill.
3. Write tests colocated with source files (or wherever the project places them).
4. Test behaviour and user-visible outcomes, not internal state.

## Do

- Use semantic queries in priority order: by role > by label > by text > by test id.
- Scope queries to the rendered subtree; query the document body (or equivalent) for portalled
  content (modals, popovers, tooltips, toasts).
- For async / animated / portalled content, **wait on the final asserted state** (e.g.
  `waitFor(() => expect(getByRole(...)).toBeVisible())`). Do NOT pair a "find" query that only
  retries existence with a separate visibility assertion — that races visibility.
- Prefer asserting visibility over mere presence in the document.
- Assert callback props were called with expected arguments (destructure them from the test's args
  where the framework supports it).
- Every test tagged as executable MUST have meaningful assertions — smoke-only is a bug.
- Use parameterized/table-driven tests for variants.
- Use the project's typed meta/fixture helpers for component tests.
- Use the project's dependency container, seeders, and test tags where the project provides them.

## Don't

- Use brittle DOM selectors (raw `querySelector`, by-class, by-id) — FORBIDDEN.
- Mock the internals of third-party UI libraries.
- Test CSS class names or other implementation details.
- Use a "find" query plus a separate visibility assertion for animated/portal content — wait on
  the final state instead.
- Use custom timeouts to paper over a flaky test — if the default is insufficient, fix the test.
- Write component/integration tests that need routing/DI context without wiring that context.

## Key details

- Unit tests: `<name>.<test-suffix>`; import the framework's assertion utilities.
- Component/interaction tests: use the project's typed story/test object and import its
  interaction utilities.
- Note any framework-specific gotchas the project has documented (wrapper roles, duplicated
  elements, setup requirements) and account for them in queries.
```

#### `.claude/agents/pattern-scout.md`

````markdown
---
name: pattern-scout
description: Use to generate or update skills/rules files based on architecture docs and real code. Invoke for new projects, after major refactors, or when code review surfaces missed conventions.
model: opus
tools: Read, Glob, Grep, Write, Edit
---

You are a pattern scout. You analyze a codebase and generate or update skills/rules files based on
two sources:

1. **Architecture document** (highest priority) — the project's documented conventions and rules.
2. **Code** (validation) — real implementations that confirm or extend the documented rules.

## When to run

- New project — full skills generation.
- After a major refactoring or new feature — update affected skills.
- After code review revealed missed conventions — add the missing rules.

## Algorithm

### Step 1: Find architecture documentation

Search for architecture docs in this order:

- `<docs-dir>/architecture.md`
- `<docs-dir>/README.md`
- `ARCHITECTURE.md`
- Any `*.md` under `<docs-dir>` containing "architecture", "conventions", "guidelines".

Read them thoroughly. These are the source of truth.

### Step 2: Extract rules from documentation

For each rule found, categorize:

- **Layer rules** — what can import what, where files live.
- **Pattern rules** — how to create entities, services, DTOs, data-access, mappers.
- **Checklist rules** — steps to add a new feature (files to create, registrations).
- **Naming rules** — file naming, class naming, conventions.

### Step 3: Validate against code

For each extracted rule, find 2-3 real implementations:

- Use Glob to find files matching the pattern.
- Read 2-3 examples to confirm the rule holds.
- Note any additional patterns not in the documentation.

### Step 4: Discover undocumented patterns

Search code for recurring patterns not covered by the architecture doc (rendering conventions,
dependency-array conventions, testing patterns, cache-update strategies, error-handling patterns).

For each discovered pattern, check consistency:

- Found in 80%+ of files → **draft skill** (likely intentional convention).
- Found in 50-80% → **flag for review** (might be in transition).
- Found in <50% → skip (not a convention).

### Step 5: Generate skills / rules

Compare findings against existing skills/rules files:

- Rule exists and matches code → no change.
- Rule in architecture doc but missing from skills → **add**.
- Pattern in code but not in architecture or skills → **add as draft** (mark with `[DRAFT]`).
- Rule in skills contradicts code → **flag for review**.

When generating path-scoped **rules** (`.claude/rules/*.md`), give each rule file frontmatter with a
`paths:` glob (the file types the rule governs) plus a tight body of Do/Don't bullets and, where
possible, the grep regex that detects each violation.

## Output format

For each skills/rules file updated, report:

\```

### <file.md>

#### Added (from architecture doc)

- [rule description] — source: architecture.md line X

#### Added [DRAFT] (from code analysis)

- [rule description] — found in: file1, file2, file3 (N/M files consistent)

#### Flagged for review

- [rule description] — conflict: architecture says X, code shows Y

#### No changes needed

- [existing rules that are correct]
  \```

## What NOT to put in skills/rules

Skills/rules should contain rules an agent cannot derive by reading the code at implementation time:

- Team decisions (style preferences, naming preferences).
- Prohibitions (no untyped escape hatches, no force-push, no inline styles).
- Workflow rules (commit format, PR process).
- Non-obvious conventions (test setup requirements, registration checklists).

Do NOT duplicate what the architecture document already covers — reference it instead:

- `See <docs-dir>/architecture.md "Adding a New Feature" for the full checklist`.

## References

- Architecture docs under `<docs-dir>`.
- Existing skills / rules.
- Existing agent definitions.

## Important

- Never modify the architecture document — it's maintained by the team.
- Mark all code-derived rules as `[DRAFT]` until confirmed by the user.
- Keep skills/rules concise — link to the architecture doc for details instead of duplicating.
- Group related rules together, don't scatter across files.
````

### 5.5 Commands

#### `.claude/commands/reflect.md`

```markdown
---
description: Consolidate the auto-memory store — find duplicate or contradictory memories and propose a cleanup as a diff, without writing anything automatically.
allowed-tools: Bash(ls:*), Bash(cat:*)
---

## Memory store

!`ls -la <memory-dir>`

## Instructions

Manual reflection pass over the auto-memory store. The goal is to keep signal high as memories
accumulate — NOT to auto-generate rules.

1. Read every file in `<memory-dir>`, including the index file.
2. Identify:
   - **Duplicates** — two memories asserting the same rule/fact.
   - **Contradictions** — memories that conflict (often because one went stale).
   - **Stale entries** — memories naming files/flags/functions that no longer exist (verify by
     grep/read before flagging).
   - **Index drift** — index lines pointing to missing files, or files with no index line.
3. Present findings as a **proposed diff** the user reviews — do NOT edit memory files in this
   command. Pre-existing memory is not automatically canon; the user decides what to consolidate.
4. If nothing needs changing, say so plainly.

Replace `<memory-dir>` with this environment's auto-memory directory before use (derive it the same
way the Stop hook does: `$HOME/.claude/projects/<cwd-with-slashes-as-dashes>/memory`).
```

#### `.claude/commands/review.md`

```markdown
---
description: Review the current branch — read the diff yourself, then run the code-reviewer subagent against the project's mandatory architecture rules.
argument-hint: "[optional: base branch, defaults to the main branch]"
allowed-tools: Bash(git diff:*), Bash(git status:*), Bash(git log:*)
---

## Changed files

!`git diff --stat ${1:-<main-branch>}...HEAD`

## Full diff

!`git diff ${1:-<main-branch>}...HEAD`

## Instructions

1. **Read the diff above yourself first.** This is a first-pass review, not a delegation — the
   code-reviewer subagent is verification, not your substitute. Note anything suspicious before
   step 2.
2. Invoke the **code-reviewer** subagent. In its prompt, explicitly reference the project's
   mandatory review baseline (its architecture/layering rules, data-access/DTO conventions, and
   HTTP-status semantics under `<docs-dir>`).
3. Treat every **Critical** finding as a merge blocker. Report findings grouped by severity.
4. If the reviewer flags one anti-pattern site, grep the touched files for analogous occurrences
   before reporting done.

Replace `<main-branch>` and `<docs-dir>` with this project's values before use.
```

### 5.6 Skills

#### `.claude/skills/migration/SKILL.md`

```markdown
---
description: Drive a multi-step migration or refactor against a plan file in `<repo>/.claude/tmp/<task>-plan.md`. Loads the active plan into context, walks the next pending step under the plan's invariants, marks completed steps. Trigger when the user says "start migration", "continue migration", "next migration step", or similar.
disable-model-invocation: false
---

## Active plan(s)

<!-- Path resolution: `${CLAUDE_SKILL_DIR%/skills/*}/tmp` strips `/skills/<name>` from this skill's directory to get `<repo>/.claude/`, then appends `/tmp`. Requires this SKILL.md to live at `<repo>/.claude/skills/migration/SKILL.md` — moving the directory breaks the resolver. -->

!`d="${CLAUDE_SKILL_DIR%/skills/*}/tmp"; if ls "$d"/*-plan.md >/dev/null 2>&1; then for f in "$d"/*-plan.md; do printf '\n=== %s ===\n' "$f"; cat "$f"; done; else echo "(no active plan in $d — create one first)"; fi`

## How to drive a migration

1. **If no plan is loaded above** — draft one from the decisions in the current conversation.
   Capture every committed invariant (numbered `Dn` style: scope, format, deviation policy,
   completion gate), plus a top-level `## Open questions` section recording every unresolved
   question raised by the user; it stays open until that question is explicitly closed. Save to
   `<repo>/.claude/tmp/<task>-plan.md`, show it to the user, and wait for explicit approval.
   Re-read the saved plan from disk before proposing the first step.

2. **If a plan is loaded above** — identify the next pending step from the checklist at the bottom
   of the plan. Re-read the affected source files (do NOT cite from memory). Open the diff preview
   with a compliance header that names which invariants are honoured — for example:
   `Plan check: D1, D4 — ok; D3 — n/a`. Each invariant touched must be either honoured or flagged
   as a **deviation** with rationale, awaiting explicit approval before the diff appears.

3. **After applying a step** — verify the actual diff against the approved preview (call this the
   D12 verify: run `git diff` or re-read the changed lines; a divergence in either direction must
   be surfaced and explicitly accepted before the step is marked done). Then mark its checklist
   entry as `[x]` in the plan file with a one-line note about what landed. Run any gate the plan
   specifies (e.g. a `grep` clean of old paths) before declaring the step done.

4. **When every step is checked off** — propose deleting the plan file, after confirming with the
   user that the migration is fully landed and verified.

Replace `<repo>` and any project-specific deviation label with your project's values before use.
```

#### `.claude/skills/mr-description/SKILL.md`

`````markdown
---
description: Draft a forge pull/merge request description for the current branch following a compact team template (what / scenarios / login / mock data). Use when the user asks to write, draft, or generate a PR/MR description for the current branch.
allowed-tools: Bash(git rev-parse:*), Bash(git log:*), Bash(git diff:*)
---

## Current branch state

- Branch: !`git rev-parse --abbrev-ref HEAD`
- Commits ahead of the main branch (origin first, local fallback):

!`git log origin/<main-branch>..HEAD --oneline 2>/dev/null | head -30 || git log <main-branch>..HEAD --oneline 2>/dev/null | head -30 || echo "(no upstream or local main branch found)"`

- Files changed (top 20):

!`git diff origin/<main-branch>...HEAD --stat --stat-count=20 2>/dev/null || git diff <main-branch>...HEAD --stat --stat-count=20 2>/dev/null || echo "(diff unavailable)"`

## Style rules

- "What" block ≤ 2 sentences. State user-visible behaviour and feature-flag gating; no
  implementation detail. If you need more than 2 sentences, the scope is too wide — split.
- "Scenarios" use imperative + arrow notation: `<action> → <expected>`. Not full sentences.
- State which backend/environment the reviewer should point their build at.
- Login credentials only if review requires login. Use the project's seeded test users and default
  test password (`<test-user>` / `<test-password>`) — do not paste real credentials.
- Mock specifics inline (e.g. mock OTP `<mock-otp>`, test tokens). Reviewer should not dig into
  seed files.
- Include whatever checkbox / tasks blocks the project's forge PR template requires.

## Critical — no inline tracker keys outside the Tasks block

If the project's tracker auto-scans PR bodies for ticket keys (`<ticket-id>` substrings) and
creates unwanted cross-ticket links, the Tasks block must be the ONLY place ticket keys appear.
Reference related/blocking work narratively ("tracked separately on the backend", "pending a
backend addition"). Same rule for commit messages. Code comments are exempt — automation doesn't
scan source files. (If your tracker doesn't auto-link, this rule is moot — drop it.)

## Delivery format

Wrap the entire PR body in a **single fenced code block** (use four backticks if the body itself
contains code fences). The user copies the block once; the forge renders markdown on paste. Do NOT
render markdown inline in the reply — bold/lists/headers won't survive the clipboard hop.

## Template

\````markdown
**What this PR does / why we need it:**

<One- or two-sentence summary. State user-visible behaviour and any feature flag gating.>

**Helpful for review process:**

Backend/env to use: <list the project's environments>

**Scenarios**

Login: `<email>` / `<password>` — drop for unauthenticated flows.
Mock OTP code: `<mock-otp>` — include only if 2FA/OTP is involved.

1. **<Scenario name>** — <action chain → expected outcome>.
2. **<Scenario name>** — <action chain → expected outcome>.

<-- Include the project forge PR template's checkbox + Tasks blocks here. -->

**Tasks**

- [<ticket-id>](<tracker-url>/<ticket-id>)
  \````

## When to deviate

- **Bug-fix PR:** add a "**Reproduction**" line above "Scenarios" listing exact repro steps, then
  scenarios verify the fix.
- **Pure refactor / chore:** drop "Scenarios"; replace with one line "No behaviour change — verify
  by running existing tests".
- **Backend-only PR:** drop "Login" + "Mock OTP" lines; reviewer hits the API directly.

Replace `<main-branch>`, `<test-user>`, `<test-password>`, `<mock-otp>`, `<ticket-id>`, and
`<tracker-url>` with this project's values, and align the template body to the project's forge PR
template, before use.
`````

#### `.claude/skills/ci-testing-patterns.md`

```markdown
# CI Testing Patterns

Validated knowledge from CI debugging sessions. This is a generic reference stub — replace the
examples with **your project's** test runner, browser-test tooling, and CI provider.

## Reference issues

Keep a list of upstream tool issues that bit this project's CI, with one-line summaries, so the
next debugging session starts from known causes rather than from scratch. (e.g. dependency
re-optimization mid-run causing cascading timeouts, duplicate setup files, monorepo root
detection breakage, parallelism decay, browser memory regressions.)

## Browser-mode test runner

Capture the non-obvious knobs your browser-mode runner needs on CI, for example:

- Worker-pool settings that are **no-ops** under browser mode (the runner uses browser tabs, not
  Node workers) — remove them to avoid confusion.
- Disable file-level parallelism when tab parallelism saturates RAM on CI.
- Disabling per-test isolation is safe only when tests are stateless (mocks + DI reset in a
  `beforeEach`).
- Raise the per-test timeout under CI contention with many tests in one job.
- Allow a small retry count (1) for infra flakes, not logic bugs — do not exceed 1.

## Dependency pre-bundling

For bundler-backed test addons, explicitly pre-bundle all heavy deps. Without an explicit include
list, the bundler re-optimizes mid-run, reloads the test runner, and causes cascading timeouts.
Include everything imported by the test preview/setup, test utilities, and heavy test deps.

## Sharding

Shard across CI nodes using the runner's shard + blob-report flags, then merge reports into a
single JUnit file. Most CI providers auto-set node-index / node-total env vars under a `parallel`
setting. Each shard pays the full boot cost — fix the pre-bundling/optimization issue first, then
shard.

## CI caching

Cache the bundler and test-tool caches, keyed by the lockfile + build config:

- the bundler's on-disk cache dir
- the test tool's cache dir

## Browser launch flags

Maintain a recommended launch-args set for headless browsers in containers (sandbox flags, GPU
disable, tab-throttling disable, startup reduction, false-kill prevention). Note flags that are
**counterproductive** (e.g. single-process mode crashing headless, capping renderer heap making
OOM worse). Prefer the slim headless browser build where the tool offers one, and pin away from
versions with known memory regressions.

## Rerun failed tests

- Watch mode: filter by substring, then trigger a focused rerun (some runners require an explicit
  project flag for the addon to honour the filter).
- Headless loop: first run with a JSON reporter to a file, extract failed test names, pass them
  back as a name filter.
- Name filters affect execution only, not collection — all files still load. Fix pre-bundling first.
- Know whether your runner has a "rerun only failures" flag; several do not.
```

#### `.claude/skills/repo-structure.md`

````markdown
# Repository Structure

Template for documenting this repo's layout so agents can locate code and respect package
boundaries. Fill the tables with **this project's** actual apps, packages, and tooling.

## Apps

| App     | Description  | Port        |
| ------- | ------------ | ----------- |
| `<app>` | <what it is> | <port or —> |

## Packages

| Package     | Purpose            |
| ----------- | ------------------ |
| `<package>` | <what it provides> |

Group packages by concern (core / UI / API & auth / testing / other) if the list is long.

## Dependency management

Document how internal and shared dependencies are declared, for example:

- Internal deps via the workspace protocol (`"<package>": "workspace:*"`).
- Shared/pinned versions via a central manifest (catalog, root `package.json`, version file).
- List the load-bearing pinned versions (framework, HTTP client, data layer, router) so agents
  don't assume the wrong major.

## Commands

\```bash
<build-all-packages> # build all packages in dependency order
<start-app> # start an app's dev server
<run-script-in-package> # run a script in one package
<run-script-everywhere> # run a script across all packages
\```

Use only this project's package manager — note which one and that the others are forbidden if the
project enforces that.

## Build order

If packages must be built before apps, document the one-liner:
\```bash
<build-packages> && <start-app>
\```
Note the build output layout (e.g. ES modules + type declarations) and that adding a new export to
a shared package requires rebuilding it before consumers see it.

## Key shared utilities/hooks

List the handful of shared hooks/utilities people reach for, with a one-line signature/summary
each, so agents reuse them instead of reinventing.
````

#### `.claude/skills/team-conventions.md`

```markdown
# Team Conventions

Fill each section with **this project's** actual rules. The structure below is the transferable
part; the values are placeholders.

## Commits

Format: `type(scope): message; <ticket-id>`

**Types**: feat, fix, chore, refactor, test, docs, style, perf, ci, build

**Scopes**: enumerate the allowed scopes (apps + packages) the project's commit linter accepts.

**Issue prefixes**: list the tracker key prefixes accepted (e.g. `<ticket-id>` schemes).

Note which parts the linter enforces as error vs. warning (e.g. scope required, issue reference
required).

## Branches

Pattern: `<ticket-id>-description-in-kebab-case`
Main branch: `<main-branch>`

## Pull / Merge Requests

- PR templates live under the forge's template dir (e.g. feature / bug-fix / maintenance).
- Requirements: self-review, before/after media for UI changes, issue reference in commits.
- Document any label workflow (e.g. `draft` → `ready-for-review` → `approved`).

## Git Hooks

- `pre-commit`: lint-staged (linters + formatter on staged files).
- `commit-msg`: commit-message linting.

## Import Order

If the project enforces import ordering, document the group order (side effects → builtins/runtime →
third-party → internal packages → relative → assets → styles).

## Code Style

Capture the load-bearing style rules, for example:

- Strict typing; the project's type-only-import convention.
- Method-signature style preference.
- Named exports only (no default exports for components), if enforced.
- Formatter settings (print width, indent, quotes, semicolons).
- CSS methodology / class-naming convention.

## Hard prohibitions

List the project's non-negotiables (e.g. never force-push, only the sanctioned package manager,
never edit generated files, no untyped escape hatches without justification).
```

### 5.7 Path-scoped rules — `.claude/rules/*.md`

**Rules are project-specific — generate them by running the pattern-scout subagent on this repo's
code/architecture docs; do not copy another project's rules.** Each rule file uses the frontmatter
template below: a `paths:` glob that scopes when the rule activates, then a tight body of Do/Don't
bullets, ideally each paired with the grep regex that detects a violation.

Rule frontmatter + body template (`.claude/rules/<rule-name>.md`):

```markdown
---
description: <one line — what this rule enforces and when it fires>
paths:
  - "<glob the rule governs, e.g. **/*.response.ts>"
  - "<additional glob if needed>"
---

# <Rule name>

## Do

- <machine-checkable convention> — detect: `<grep regex>` — severity: critical/warning/suggestion
- <convention 2>

## Don't

- <banned pattern> — detect: `<grep regex>` — severity: critical/warning/suggestion

## Why

<one or two lines: the failure mode this rule prevents, so the agent understands intent>
```

### 5.8 `CLAUDE.md`

Write the project body (overview, structure, critical rules, file naming, subagent delegation —
derived from this repo) **followed by these two sections verbatim**:

```markdown
## Multi-step migrations

Before any multi-file migration or refactor, write decision invariants to
`.claude/tmp/<task>-plan.md`. Re-read that plan from disk (not memory) immediately before composing
each diff preview, and open every diff preview with a compliance header — e.g.
`Plan check: D1 — ok; D3 — n/a`. Any deviation requires explicit user approval before the diff —
surface it as `ОТКЛОНЕНИЕ ОТ ПЛАНА` with rationale.

## Scope discipline

- **Debug budget for support machinery**: 2 iterations max. On the third, stop and propose to
  simplify or defer the mechanism rather than debug it further.
- **Nesting limit**: if work is more than 2 levels removed from the user's original task, stop and
  ask — continue / simplify / cut.
- **Cost/value framing**: when proposing a new support mechanism, lead with one line —
  cost / value / cost-of-not-implementing.
- **Plan starts with the goal**: the first line of any plan is the user's original goal verbatim; a
  sub-item that does not bring it closer is a candidate for cutting.
```

Also write `CODEMAP.md` at the repo root: a short map of where things live (apps, packages, entry
points, where new feature files go, where specs/docs live). Keep it scannable — it is the index the
agents consult for placement.

## 6. Verification

1. **Guards — forbidden vs allowed bash.** With the harness deployed, confirm a `git push` attempt
   is blocked (the guard prints "Blocked: 'git push' is manual-only" and the call is denied) and a
   forbidden-package-manager command (if `<PM>` is set) is blocked, while `git status` runs
   normally. Confirm editing a `.env` file triggers an "ask" prompt and editing a
   `*<GENERATED_FILE_GLOB>` file is blocked outright.
2. **LSP diagnostics.** Edit a source file to introduce a type error; confirm the language-server
   plugin surfaces a diagnostic. Revert.
3. **D12 verify hook.** Create a throwaway `.claude/tmp/x-plan.md`, then make any source edit;
   confirm the post-edit-verify hook fires and injects a "POST-APPLY VERIFY (D12)" context block.
   Delete the throwaway plan; confirm subsequent edits are silent again.
4. **Memory/reflect flag path.** Run `ls ~/.claude/projects/` and confirm a directory matching the
   cwd-derived slug exists with a `memory/` subdir; touch a file under it, end a turn, start a new
   session, and confirm the `💡 ... /reflect` notice appears (this proves the Stop hook's
   self-derived `MEM` path resolves). If it never appears, the slug derivation is off — adjust the
   `slug="${cwd//\//-}"` sanitization to match the actual directory name.
