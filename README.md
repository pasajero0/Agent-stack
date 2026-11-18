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

The deployed hooks need `bash` (3.2 is enough), `git` and `jq` on PATH; without `jq` every guard blocks,
and session start says so. GNU `timeout` is used when present (`gtimeout` on macOS with coreutils);
without it hooks run unbounded.

## What it deploys

```
CLAUDE.md                  # project guide + workflow, report contract, modes, model routing (yours after generate)
CODEMAP.md                 # where things live — a stub to fill in (yours after generate)
.claude/
├── gates.json             # every stack-specific value the hooks read — human-edited (yours after generate)
├── settings.json          # hook registration + permission allow-list
├── settings.local.json    # read-deny for build/generated noise (yours after generate)
├── hooks/                 # deterministic shell hooks, run outside the model
│   ├── guard-bash.sh        # block git push (in any form), foreign package managers; installs, download-
│   │                        #   and-run (npx, dlx, curl | sh) and reading secrets: ask / deny
│   ├── guard-file.sh        # protect the harness itself, generated files, lockfiles, tasks.json; confirm
│   │                        #   editing .env; reading env files and keys: ask / deny
│   ├── spec-gate.sh         # the spec leads the code: first spec merged, later changes committed first
│   ├── cheat-guard.sh       # block edits that add .skip/.only, @ts-ignore, eslint-disable, any, …
│   ├── arch-guard.sh        # block new imports across layer boundaries set in gates.json
│   ├── evidence-gate.sh     # Stop: no "STATUS: DONE" while a task fails or without EVIDENCE
│   ├── post-edit-lint.sh    # run the configured linter on the edited file, surface errors + warnings
│   ├── session-start-context.sh  # git context, mode, active stage progress; warns about hooks that never
│   │                        #   run (unregistered or not executable), missing jq, a repo with no commits
│   ├── stop-flag-reflect.sh # Stop: after a memory change, suggests /reflect next session
│   └── gates-lib.sh         # shared helpers (not a hook)
├── bin/verify             # runs each task's verify command — the only writer of `passes`
├── bin/trace              # links spec criteria ↔ tests ("A0 AC-3: …"): missing tests, invented criteria
├── bin/health             # code-health SLIs on the branch's changes vs SLOs; time series in tmp/health.jsonl
├── agents/                # spec-reviewer, implementer, test-writer, code-reviewer, task-analyzer,
│                          # researcher, pattern-scout — each with a model and effort level
├── skills/                # grill, adr, spec (full + light template), plan, migration, mr-description
│                          # + reference docs to fill in (update keeps your edits)
├── commands/              # /reflect, /review
└── rules/                 # EMPTY by design — generate per repo with pattern-scout
```

## The workflow

Hooks enforce three points of it: no code before the spec is merged (**spec-gate**), no skipped tests or
suppressed checks (**cheat-guard**), no "done" that the task results contradict (**evidence-gate**). The
order of the other steps is kept by skills, which the model may skip: in the first trial `/plan` was never
called. Keeping the whole order outside the model is the next step for this project.

1. **`/grill`** — the agent interviews you in numbered rounds, each question with a recommended answer,
   until no decision is open. Decisions become ADRs (**`/adr`**), edge cases go into the spec.
2. **`/spec <stage>`** — `docs/specs/<stage>/SPEC.md` with EARS acceptance criteria (happy, unhappy, edge),
   reviewed by the **spec-reviewer** subagent. Criteria cite the ADRs behind them, and each ADR lists the
   stages it applies to. You push, review and **merge the MR — merged means approved** (no remote: merge the
   `spec/<stage>` branch locally). Until then **spec-gate** blocks every code edit for the stage.
   Setup work with nothing to see — scaffold, tooling, CI — gets a **light spec** instead: a checklist, each
   item with the command that proves it; no review, not traced to tests.
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
| `stagePattern` | bash regex on the **branch name** (its last `/` segment); capture group 1 is the stage id, and the spec lives at `<specsDir>/<group 1>/SPEC.md`. Default `^([A-Za-z]+[0-9]+)([-_.]\|$)`: branch `feat/A0-ingest` → `docs/specs/A0/SPEC.md`. To name specs after features, `^f-([a-z0-9]+(-[a-z0-9]+)*)$`: branch `f-request-review` → `docs/specs/request-review/SPEC.md`, and `fix-typo` is no stage. Stage ids with `-` cannot appear in Python test function names, so name such tests with a string (`pytest.mark.parametrize` ids, a docstring) or keep `A0`-style ids |
| `openPaths` | paths editable without a spec (docs, `*.md`, `.claude/`) |
| `protectedGlobs` | generated files and lockfiles — never hand-edited |
| `packageManager`, `forbiddenPackageManagers` | the one package manager, the blocked ones |
| `installPatterns`, `cheatPatterns` | what counts as an install / a cheat (POSIX regex) |
| `commands.test`, `commands.lint`, `lintMatch` | test command; per-file lint command with `{file}`; files to lint |
| `testGlobs` | where `trace` looks for tests that name criteria |
| `slo` | code-health limits on changed files: `maxFileLines` (400), `newDependencies` (null = report only) |
| `health` | project metrics: `[{"name": "complexity", "command": "… {files} …", "max": 0}]` — detected for ESLint and ruff |
| `docsLayout` | where Markdown files belong; `health` lists a changed `.md` outside these globs (a hint, never a block). Root-level `*.md` always fits. Set for a monorepo (see below), empty otherwise |
| `layers` | architecture boundaries, empty until an ADR sets them: `[{"name": "domain stays pure", "files": ["src/domain/*"], "forbid": ["infra/"], "adr": "docs/adr/0003-layers.md"}]` |

**Default doc layout for a monorepo** (workspaces — pnpm, npm/yarn, `go.work`, Cargo — or an `apps/` or
`packages/` folder; e.g. api + web + contracts): project docs (specs, ADRs, guides) under `docs/`, a
`README.md` in each app or package, package `CHANGELOG.md`s, plus `.claude/` and `.github/`. Keep docs next to the code instead? Change `docsLayout` and record the decision in an ADR.

The agent cannot edit `gates.json`, `settings*.json`, `hooks/` or `bin/` — guard-file blocks it.

## Commands

| Command | Description |
|---------|-------------|
| `agent-stack init` | Wizard: detect environment → deploy harness (skipped if `.claude/` exists) → optional MCP servers |
| `agent-stack generate` | Deploy the harness into the current repo (`--force` to overwrite an existing one) |
| `agent-stack update` | Refresh an existing harness; keeps your seed files (`CLAUDE.md`, `CODEMAP.md`, `gates.json`, `settings.local.json`), `rules/`, `tmp/`, any harness file you changed since it was deployed (`--force` overwrites those), and your own hooks, permissions and other keys in `settings.json`. Deletes harness files a newer version no longer ships, unless you changed them. `--dry-run` to preview |
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
- **Secrets:** reading an env file or a private key (Read, Grep, or `cat`/`grep`/`source` in Bash) asks first,
  but a command that does not name the file (`cat $(ls -a | grep env)`, a script) is not caught.
- **Known gaps** (security review of 0.3, fixes planned):
  - the network is not restricted (`curl`, `gh gist`, WebFetch) — turn on Claude Code's `/sandbox`;
  - irreversible commands (`rm -rf`, `git reset --hard`) are left to Claude Code's own permission prompt;
  - tool results (web pages, MCP output) are not checked for injected instructions;
  - agent prompts, skills, CI workflows and `package.json` scripts are editable without a prompt.
- **The MCP catalog is not maintained:** most entries run `npx -y` without a pinned version, and
  `server-github` is archived upstream. Check an entry before `mcp install`.

## Experimental parts

In the first trial (lex-poc, 10 sessions) these never acted, or acted without helping. They stay for now;
`agent-stack usage --save` records whether they are used, and a part that stays unused across several
weekly summaries is removed in a later version.

| Part | What the trial showed |
| --- | --- |
| `/plan` → `tasks.json` → `bin/verify` → `evidence-gate` | no `tasks.json` written; `evidence-gate` ran 218 times, stopped nothing |
| `task-analyzer`, `pattern-scout` subagents | never called |
| `spec-reviewer` subagent | called once (~47k tokens), result discarded |
| `/grill`, `/migration`, `/mr-description` skills | never called |
| `/review`, `/reflect` commands, `stop-flag-reflect` hook | never called; the hook only raises a flag for `/reflect` |
| `cheat-guard`, `arch-guard` hooks | never blocked (`arch-guard` has no `layers` until an ADR sets them) |
| `post-edit-lint` hook | never reported (`lintMatch` empty; the IDE reports errors anyway) |
| `bin/health` | never run in the project (its `misplacedDocs` report is new in this version, also experimental) |

Proven in use: `guard-bash`, `guard-file`, `spec-gate`, `session-start-context`, `bin/trace`, `/spec`, `/adr`,
`implementer`, `test-writer`, `code-reviewer`, `researcher`. How to read the summaries:
[docs/usage-analytics.md](docs/usage-analytics.md).

## After deploying

1. Review `.claude/gates.json`.
2. Exclude the harness from git if it is personal — add `/.claude/` and `/CLAUDE.md` to `.git/info/exclude`.
   Keep `CODEMAP.md` tracked: it is the project's map. Keep the leading `/`: on a case-insensitive filesystem an unanchored `CLAUDE.md` also
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
