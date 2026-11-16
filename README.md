![CI](https://github.com/pasajero0/Agent-stack/actions/workflows/ci.yml/badge.svg)

# agent-stack

CLI that deploys a **Claude Code harness** onto a repository and manages MCP servers. The harness is an
enforcement layer: deterministic hooks outside the model that gate a spec-driven workflow — no code
before the spec is merged, no skipped tests, no "done" without evidence — plus the skills and subagents
that drive that workflow. It is stack-agnostic: everything language-specific lives in one config file.

## Install

```bash
npx @pasajero_0/agent-stack init        # no install
# or
npm i -g @pasajero_0/agent-stack
```

The deployed hooks need `bash`, `git` and `jq` on PATH (`python3` for the migration verify hook).
GNU `timeout` is used when present (`gtimeout` on macOS with coreutils); without it hooks run unbounded.

## What it deploys

```
CLAUDE.md                  # project guide + workflow, report contract, modes, model routing (yours after generate)
CODEMAP.md                 # where things live — a stub to fill in (yours after generate)
.claude/
├── gates.json             # every stack-specific value the hooks read — human-edited (yours after generate)
├── settings.json          # hook registration + permission allow-list
├── settings.local.json    # read-deny for build/generated noise (yours after generate)
├── hooks/                 # deterministic shell hooks, run outside the model
│   ├── guard-bash.sh        # block git push (in any form), foreign package managers; installs: ask / deny
│   ├── guard-file.sh        # protect the harness itself, generated files, lockfiles, tasks.json; confirm .env
│   ├── spec-gate.sh         # the spec leads the code: first spec merged, later changes committed first
│   ├── cheat-guard.sh       # block edits that add .skip/.only, @ts-ignore, eslint-disable, any, …
│   ├── arch-guard.sh        # block new imports across layer boundaries set in gates.json
│   ├── evidence-gate.sh     # Stop: no "STATUS: DONE" while a task fails or without EVIDENCE
│   ├── post-edit-lint.sh    # run the configured linter on the edited file, surface errors + warnings
│   ├── session-start-context.sh  # git context, mode, active stage progress
│   ├── stop-flag-reflect.sh
│   └── gates-lib.sh         # shared helpers (not a hook)
├── bin/verify             # runs each task's verify command — the only writer of `passes`
├── bin/trace              # links spec criteria ↔ tests ("A0 AC-3: …"): missing tests, invented criteria
├── bin/health             # code-health SLIs on the branch's changes vs SLOs; time series in tmp/health.jsonl
├── agents/                # spec-reviewer, implementer, test-writer, code-reviewer, task-analyzer,
│                          # researcher, pattern-scout — each with a model and effort level
├── skills/                # grill, adr, spec, plan, migration, mr-description + reference docs
├── commands/              # /reflect, /review
└── rules/                 # EMPTY by design — generate per repo with pattern-scout
```

## The workflow it enforces

1. **`/grill`** — the agent interviews you in numbered rounds, each question with a recommended answer,
   until no decision is open. Decisions become ADRs (**`/adr`**), edge cases go into the spec.
2. **`/spec <stage>`** — `docs/specs/<stage>/SPEC.md` with EARS acceptance criteria (happy, unhappy, edge),
   reviewed by the **spec-reviewer** subagent. You push, review and **merge the MR — merged means approved**.
   Until then **spec-gate** blocks every code edit for the stage.
3. **`/plan <stage>`** on a branch named after the stage (`A0-ingest` — the gates read the stage from it):
   `.claude/tmp/<stage>/tasks.json`, every criterion → a task with a `verify` command and a tier (S/M/L)
   that picks the implementer's model.
   **Requirements change?** The spec changes first, in the same branch: a `spec: …` commit with a
   "## Changes" entry, then tests and code. spec-gate keeps code closed while the spec has uncommitted
   edits or an unexplained change — so history always shows the spec before the code it explains.
4. **Tests first**, named with criterion ids. **cheat-guard** blocks adding skipped tests or suppressed checks.
5. **One task at a time** by the **implementer** subagent; **`.claude/bin/verify`** is the only thing that
   marks a task as passing.
6. **Report** with STATUS / DONE / NOT DONE / EVIDENCE / RISKS / NEEDS HUMAN DECISION.
   **evidence-gate** blocks a "done" that the task results contradict.

## Drift — measured like a service

Tests catch a broken feature. Two more kinds of drift are measured the way you would monitor a server:

| Server | Here |
| --- | --- |
| SLI — a metric | file size, new dependencies, complexity of the code this branch changed; layer imports |
| SLO — a target | `slo` / `health[].max` in `gates.json`; `layers` boundaries |
| Breach → stop releases | `STATUS: DONE` blocked; fix it, or justify it in an ADR and the human raises the limit |
| Time series | `.claude/tmp/health.jsonl`, one line per `health` run |
| Trace | spec criterion → test (`trace`) → code, in commit order: `spec: …` before the code |

Only what the branch changed is measured, so old debt never blocks new work and new debt cannot slip in.

## Configuration — `.claude/gates.json`

Detected for node, python, go and rust (other stacks get empty defaults to fill in):

| Key | Meaning |
| --- | --- |
| `mode` | `interactive` (default: confirm each diff) or `autonomous` (no confirmations; installs denied, no push, commit per phase) |
| `baseBranch` | where merged specs are read from (`origin/<base>` if present, else local) |
| `specGate` | `strict` (no code without a merged spec) · `stage` (only on a stage branch) · `off` |
| `stagePattern` | regex on the branch name's last segment; group 1 is the stage (default: `A0-…` → `A0`) |
| `openPaths` | paths editable without a spec (docs, `*.md`, `.claude/`) |
| `protectedGlobs` | generated files and lockfiles — never hand-edited |
| `packageManager`, `forbiddenPackageManagers` | the one package manager, the blocked ones |
| `installPatterns`, `cheatPatterns` | what counts as an install / a cheat (POSIX regex) |
| `commands.test`, `commands.lint`, `lintMatch` | test command; per-file lint command with `{file}`; files to lint |
| `testGlobs` | where `trace` looks for tests that name criteria |
| `slo` | code-health limits on changed files: `maxFileLines` (400), `newDependencies` (null = report only) |
| `health` | project metrics: `[{"name": "complexity", "command": "… {files} …", "max": 0}]` — detected for ESLint and ruff |
| `layers` | architecture boundaries, empty until an ADR sets them: `[{"name": "domain stays pure", "files": ["src/domain/*"], "forbid": ["infra/"], "adr": "docs/adr/0003-layers.md"}]` |

The agent cannot edit `gates.json`, `settings*.json`, `hooks/` or `bin/` — guard-file blocks it.

## Commands

| Command | Description |
|---------|-------------|
| `agent-stack init` | Wizard: detect environment → deploy harness (skipped if `.claude/` exists) → optional MCP servers |
| `agent-stack generate` | Deploy the harness into the current repo (`--force` to overwrite an existing one) |
| `agent-stack update` | Refresh an existing harness; keeps your seed files (`CLAUDE.md`, `CODEMAP.md`, `gates.json`, `settings.local.json`), `rules/`, `tmp/`; `--dry-run` to preview |
| `agent-stack sync` | `detect`, then `generate` or `update` |
| `agent-stack usage` | What the harness did in this project, read from Claude Code's session logs: hook blocks and context, Stop-hook runs, subagents, skills, commands, `bin/` runs, tokens by agent and model, and installed parts that never acted. `--days <n>`, `--logs <dir>`, `--json`; `--save` keeps the summary in `.claude/tmp/usage/<date>.json`, since Claude Code deletes old logs. How to read it: [docs/usage-analytics.md](docs/usage-analytics.md) |
| `agent-stack detect` | Report project context + whether Claude Code is installed |
| `agent-stack mcp install` / `list` | MCP servers from the catalog |

## Limits — read before trusting it

- **Blocklists, not a sandbox.** Guards catch an agent's mistakes, not a determined bypass: a file written
  through Bash (`sed -i`, `>`) skips the Edit/Write gates, and command matching is regex-based (known false
  positive: `git push` quoted inside another command's argument is blocked). Put the same checks in CI for
  anything that must hold.
- **Hooks fail open** when they crash. Stop hooks can only nudge once per turn (`stop_hook_active`).
- `verify` runs commands from an agent-written plan; it is not allow-listed and refuses commands guard-bash
  would block. Review the plan table before implementation starts.
- **`usage` reads Claude Code's internal log format**, which can change between versions; lines it does not
  recognise are skipped. Logs are kept for `cleanupPeriodDays` (30 by default). It shows what was used, not
  whether it helped.
- **Hook output is a prompt-injection surface.** SessionStart injects branch names and commit messages, the
  lint hook quotes file content and runs repo-controlled config. Treat that text as data.

## After deploying

1. Review `.claude/gates.json`.
2. Exclude the harness from git if it is personal — add `/.claude/`, `/CLAUDE.md`, `/CODEMAP.md` to
   `.git/info/exclude`. Keep the leading `/`: on a case-insensitive filesystem an unanchored `CLAUDE.md` also
   hides `docs/claude.md`.
3. Generate rules with the **pattern-scout** subagent (`.claude/rules/` ships empty on purpose).

### Pair it with Claude Code plugins

agent-stack does not install these — LSP and service integrations are better served by official plugins:

```bash
claude plugin install typescript-lsp@claude-plugins-official   # needs typescript-language-server on PATH
claude plugin install github@claude-plugins-official
```

An old Claude Code rejects the current plugin marketplace — `claude update` first; plugins load on the next
session.

## Development

```bash
pnpm install      # pnpm only — npm/yarn/bun are not supported
pnpm build
pnpm test         # unit tests + hook tests (bash, jq, git) + end-to-end generate on fresh repos
pnpm typecheck    # the static gate (no linter yet)
```

Husky hooks from a GUI git client (VS Code, GitKraken) do not see an nvm-installed `pnpm` — add the node bin
to PATH in `~/.config/husky/init.sh`.

Release notes: [CHANGELOG.md](CHANGELOG.md).

## Conventions

[Conventional Commits](https://www.conventionalcommits.org/) enforced by commitlint + husky
(`commit-msg`). Default branch `main`; `git push` is manual. GitHub PRs (`gh`).

## License

MIT
