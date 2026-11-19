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
│   ├── spec-gate.sh         # the spec leads the code: first spec merged, later changes committed first, then /plan
│   ├── cheat-guard.sh       # block edits that add .skip/.only, @ts-ignore, eslint-disable, any, …
│   ├── arch-guard.sh        # block new imports across layer boundaries set in gates.json
│   ├── evidence-gate.sh     # Stop: no "STATUS: DONE" while a task fails or without EVIDENCE
│   ├── post-edit-lint.sh    # run the configured linter on the edited file, surface errors + warnings
│   ├── session-start-context.sh  # git context, mode, active stage progress; warns about hooks that never
│   │                        #   run (unregistered or not executable), missing jq, a repo with no commits
│   ├── stop-flag-reflect.sh # Stop: after a memory change, suggests /reflect next session
│   └── gates-lib.sh         # shared helpers (not a hook)
├── bin/verify             # runs each task's verify command — the only writer of `passes`
├── bin/trace              # links spec criteria ↔ tests ("A0 AC-3: …"): missing tests, invented criteria;
│                          #   and spec Terms ↔ glossary: a term not in it and not marked (local);
│                          #   --terms checks only the terms (before a spec has tests)
├── bin/health             # code-health SLIs on the branch's changes vs SLOs; time series in tmp/health.jsonl
├── agents/                # spec-reviewer, implementer, test-writer, code-reviewer, task-analyzer,
│                          # researcher, pattern-scout — each with a model and effort level
├── skills/                # grill, adr, spec (full + light template), plan, migration, mr-description
│                          # + reference docs to fill in (update keeps your edits)
├── commands/              # /reflect, /review
└── rules/                 # EMPTY by design — generate per repo with pattern-scout
```

## The workflow

Hooks enforce four points of it: no code before the spec is merged and the plan is written
(**spec-gate**), no skipped tests or suppressed checks (**cheat-guard**), no "done" without evidence or
against the task results (**evidence-gate**). The order of the other steps is kept by skills, which the model
may skip. Keeping the whole order outside the model is the job of the driver, `agent-stack run`
([ADR 0001](docs/adr/0001-pipeline-driver.md)); it exists as an experimental first part, see
[Driving the pipeline](#driving-the-pipeline-agent-stack-run-experimental).

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
   that picks the implementer's model. Until it exists **spec-gate** keeps code closed: in the first trial
   `/plan` was never called, and nothing checked the "done".
   **Requirements change?** The spec changes first, in the same branch: a `spec: …` commit with a
   "## Changes" entry, then tests and code. spec-gate keeps code closed while the spec has uncommitted
   edits or an unexplained change — so history always shows the spec before the code it explains.
4. **Tests first**, named with criterion ids. **cheat-guard** blocks adding skipped tests or suppressed checks.
5. **One task at a time** by the **implementer** subagent; **`.claude/bin/verify`** is the only thing that
   marks a task as passing.
6. **Report** with STATUS / DONE / NOT DONE / EVIDENCE / RISKS / NEEDS HUMAN DECISION.
   **evidence-gate** blocks a "done" without EVIDENCE (with or without a task list), and one that the task
   results contradict.

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
| `testGlobs` | where `trace` looks for tests that name criteria; also the tests `agent-stack run` keeps frozen during a task |
| `glossary` | the glossary `trace` checks spec Terms against: each `- **Term**` in a spec's `## Terms` is a headword there or is marked `(local)`. Default `docs/GLOSSARY.md` when it exists; `""` turns the check off. Optional, not in the seed |
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
| `agent-stack run` | Experimental pipeline driver: `quick` / `task` modes, `--resume`, `--status`, `--cancel`. See [Driving the pipeline](#driving-the-pipeline-agent-stack-run-experimental) |

## Driving the pipeline: `agent-stack run` (experimental)

A program holds the step order, so the model cannot skip `/plan`. The program creates the branches, makes
every commit, runs the checks itself and stops for you at fixed gates. The model only reads and edits files
inside the step it is given. Design: [ADR 0001](docs/adr/0001-pipeline-driver.md), spec:
[docs/specs/v04/SPEC.md](docs/specs/v04/SPEC.md), terms: [docs/GLOSSARY.md](docs/GLOSSARY.md).

```text
agent-stack run quick "<description>"                  a small fix
agent-stack run task [--stage <id>] "<description>"    a spec, a plan and one or two tasks
agent-stack run --resume [<run id>]                    continue a waiting or interrupted run
agent-stack run --status [<run id>]                    print the run; change nothing
agent-stack run --cancel [<run id>]                    cancel a waiting or interrupted run
```

**Quick mode.** Creates `quick/<slug>` from HEAD, runs your test command on it (it must pass), then one
implement call. The driver runs the checks (the test command, plus lint on changed files). A diff above
`quickReviewLines` is also reviewed. Then the driver commits (`<type>: <subject>`) and stops at the accept gate.

**Task mode.**
1. *Clarify* (Opus): up to 5 questions with recommended answers, a size (task, story, epic) and a stage id.
   **You decide** at gate `answers`: accept or change each answer, the size and the stage id. An epic ends
   here with a proposed split in `split.md`.
2. *Spec* (Opus) on a new `spec/<stage>` branch. The driver checks its terms (`trace --terms`; the role may add
   a shared word to the glossary in the same commit), commits it and stops with exit 3.
   **You decide** by reviewing and merging that branch into the base branch yourself.
3. `--resume` creates `<stage>-<slug>` and runs *plan* (Opus). The role returns the tasks and the driver writes
   `tasks.json`. **You decide** at gate `plan-approve`: approve, or reject with a comment (the plan is redone). Each task's `verify` command is allowed to the model
   as written, so read the plan table. A new plan with a `verify` that cannot fail (`|| true`, `; exit 0`,
   `| tee` and the like) is not valid: the plan role is run again with the pattern.
4. The driver runs your test command once, then per task: implement, checks (the task's `verify` plus lint),
   review on that task's diff, commit `<type>(<stage>): <subject>`. A red check or a blocking review goes
   back to implement with the feedback, up to the attempt limit. The implement and review roles take their
   rules from `.claude/agents/implementer.md` and `.claude/agents/code-reviewer.md`, so a change to an agent
   reaches the driver too.
5. **You decide** at gate `accept`: accept (the run finishes) or reject with a comment, which adds a fix task.

**Gates.** At a terminal, answers are read from the prompt; `c` cancels at any gate. With no terminal the run
is recorded as waiting and exits. A gate `limit` appears when attempts run out, a task is BLOCKED, the review
loop does not improve, or the fuse is reached: `r` retries, `f <n>` raises the fuse, `c` cancels. When the spec
or plan role asks you something instead of doing its job, gate `limit` (reason `decision`) shows the question:
`r` and your answer re-run the role with it.

**Tests are the contract.** If implement finds that an existing test or the task's `verify` contradicts a
criterion, it leaves the test alone: gate `limit` (reason `test-conflict`) shows the test, the criterion and the
reason, and `r` with your answer retries without counting an attempt. If a task deletes or weakens a test that was
there at its start (fewer tests or assertions, more skip marks, a changed CI or test config), gate `limit` (reason
`tests-changed`) lists the changes: `a` allows exactly those, `r` sends the task back, `c` cancels. A weaker
assertion that keeps the count (`toBe(3)` → `toBeTruthy()`) is not seen.

Before gate `accept`, a task run with more than one task runs every
task's verify once more and marks a red result.

**Exit codes.** `0`: finished, cancelled or `--status`. `3`: waiting at the spec-merge gate, or at any gate
without a terminal. `1`: a refusal or an error; the message says what to do.

**Config.** The optional `run` key of `.claude/gates.json` (defaults live in code, so `update` need not touch it):

```json
{ "run": { "maxTurns": 60, "fuse": { "calls": 40 }, "stepTimeoutMin": 30, "checkTimeoutMin": 15, "quickReviewLines": 120 } }
```

`fuse` is one of three kinds: `{ "calls": <n> }` (the default, 40; fits a subscription), `{ "usd": <n> }`
(for API billing; every call also gets what is left as its `--max-budget-usd`), or `"off"`.
Turns per call, attempts per task and the review-loop stop apply whatever the kind.
A call that was killed, or whose result has no cost, counts as unknown cost, and the gates name those calls.
A check that runs past `checkTimeoutMin` stops the run with exit 1 and counts no attempt: fix what hangs, then
`--resume`.

**Hooks stay on.** Claude is never started with `--bare`, `bypassPermissions` or `disableAllHooks`. Two hooks
step aside only for a live driver run on the run's own branch: spec-gate (quick mode) and evidence-gate.
**Nothing is pushed or merged**: you push, and you merge the spec yourself.
Each call is logged in `.claude/tmp/runs/<run id>/calls/` (argv, exit code, result; never the prompt).

**Only the project goes in.** Each call gets the project's `.mcp.json` only (`--strict-mcp-config`), project and
local settings only (no user plugins, permissions or hooks), and not your `~/.claude/CLAUDE.md`. Your
claude.ai connectors (Gmail, Drive and so on), auto-memory and the git status snapshot are switched off by env
vars. Besides privacy, this is the cost: the connectors alone added about 150k tokens to every turn.

**Limits of this part.**
- Experimental: five manual runs with the real `claude` (two quick fixes, two one-task stages, one two-task
  stage); the rest is tested with a fake `claude`.
- **`/plan` needs a person in a plain session.** Claude Code guards `.claude/` itself, even with an allow rule,
  so writing `tasks.json` asks for approval. With no one to approve (a headless or autonomous session), `/plan`
  cannot write it; use `agent-stack run task`, where the driver writes the plan.
- With a claude.ai login, Claude Code still puts the account email into the session context. No switch removes
  it short of `--bare`, which needs an API key and skips the hooks. It stays in the model's context; nothing
  writes it to the repo.
- One run per repo; a waiting or interrupted run blocks a new one until `--cancel`.
- Bug and refactor modes come later.
- Bash can forge the run file (known gap): a model that writes `.claude/tmp/runs/<id>/run.json` through Bash
  can make a hook believe a driver run is live. Do not run it on a repo you do not trust the model with.

## Limits — read before trusting it

- **Blocklists, not a sandbox.** Guards catch an agent's mistakes, not a determined bypass: a file written
  through Bash (`sed -i`, `>`) skips the Edit/Write gates, and command matching is regex-based (known false
  positive: `git push` quoted inside another command's argument is blocked, and so is a heredoc that writes a
  file containing `git push` or another package manager's command. Use the Edit or Write tool for such a file.
  The guard does not skip heredoc text, because a heredoc fed to a shell runs it). Put the same checks in CI
  for anything that must hold.
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
| `/plan` → `tasks.json` → `bin/verify` → `evidence-gate` | no `tasks.json` written; `evidence-gate` ran 218 times, stopped nothing. Since 0.4 spec-gate waits for `tasks.json`, so the chain is no longer optional |
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
