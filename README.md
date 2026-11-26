![CI](https://github.com/pasajero0/Agent-stack/actions/workflows/ci.yml/badge.svg)

# agent-stack

CLI that deploys a **Claude Code harness** onto a repository. The harness is an
enforcement layer: deterministic hooks outside the model that gate a spec-driven workflow — no code
before the spec is merged, no skipped tests, no "done" without evidence — plus the skills and subagents
that drive that workflow. It is stack-agnostic: everything language-specific lives in one config file.

- **Problem:** a coding agent writes code before the spec, weakens a test to make it pass, and says "done"
  without evidence.
- **For whom:** a developer who runs Claude Code on their own repository and wants a program, not the model, to
  keep the order of work. The pipeline driver (`agent-stack run`) is a fixed pipeline of agent steps with
  approval gates.
- **What is checked:** regression evals (7 tasks: 5 on known agent failure modes — a weakened test, a test
  conflict, an extra dependency, scope creep, a broken access check — and 2 plain ones; k = 3): 21/21 passed,
  pass^k = 1, $1.67, on 0.5.0 with the OS sandbox on, run of 2026-11-26 —
  [evals/results/2026-11-26-112823.json](evals/results/2026-11-26-112823.json).

Read [Limits](#limits--read-before-trusting-it) before you trust it.

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
├── settings.local.json    # your local permissions (yours after generate); no Read deny rules
├── hooks/                 # deterministic shell hooks, run outside the model
│   ├── guard-bash.sh        # block git push (in any form), foreign package managers; installs (also a bare
│   │                        #   `pnpm install`: use --frozen-lockfile), download-and-run (npx, dlx, curl | sh)
│   │                        #   and reading secrets: ask / deny
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
├── skills/                # grill, adr, spec (full + light template), plan, drive, migration, mr-description
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
   **Requirements change?** The spec changes first, in the same branch: a `docs(<stage>): spec — …` commit with a
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
| Trace | spec criterion → test (`trace`) → code, in commit order: `docs(<stage>): spec — …` before the code |

Only what the branch changed is measured, so old debt never blocks new work and new debt cannot slip in.

## Configuration — `.claude/gates.json`

Detected for node, python, go and rust (other stacks get empty defaults to fill in):

| Key | Meaning |
| --- | --- |
| `mode` | `interactive` (default: confirm each diff) or `autonomous` (no confirmations; installs denied, no push, commit per phase) |
| `baseBranch` | where merged specs are read from (`origin/<base>` if present, else local) |
| `specGate` | `strict` (no code without a merged spec) · `stage` (only on a stage branch) · `off` |
| `stagePattern` | bash regex on the **branch name** (its last `/` segment); capture group 1 is the stage id, and the spec lives at `<specsDir>/<group 1>/SPEC.md`. Default `^([A-Za-z]+[0-9]+)([-_.]\|$)`: branch `feat/A0-ingest` → `docs/specs/A0/SPEC.md`. To name specs after features, `^f-([a-z0-9]+(-[a-z0-9]+)*)$`: branch `f-request-review` → `docs/specs/request-review/SPEC.md`, and `fix-typo` is no stage. Stage ids with `-` cannot appear in Python test function names, so name such tests with a string (`pytest.mark.parametrize` ids, a docstring) or keep `A0`-style ids |
| `openPaths` | paths editable without a spec; the list is in the `gates.json` seed |
| `protectedGlobs` | generated files and lockfiles — never hand-edited |
| `packageManager`, `forbiddenPackageManagers` | the one package manager, the blocked ones |
| `installPatterns`, `cheatPatterns` | what counts as an install / a cheat (POSIX regex) |
| `commands.test`, `commands.lint`, `lintMatch` | test command; per-file lint command with `{file}`; files to lint |
| `testGlobs` | where `trace` looks for tests that name criteria; also the tests `agent-stack run` keeps frozen during a task |
| `glossary` | the glossary `trace` checks spec Terms against: each `- **Term**` in a spec's `## Terms` is a headword there or is marked `(local)`. Default `docs/GLOSSARY.md` when it exists; `""` turns the check off. Optional, not in the seed |
| `slo` | code-health limits on changed files: `maxFileLines` (400), `newDependencies` (null = report only) |
| `health` | project metrics: `[{"name": "complexity", "command": "… {files} …", "max": 0}]` — detected for ESLint and ruff |
| `docsLayout` | where Markdown files belong; `health` lists a changed `.md` outside these globs (a hint, never a block). Root-level `*.md` always fits. Set for a monorepo (see below), empty otherwise |
| `codeBy` | `"driver"`: only a live `agent-stack run` call may edit code; a chat runs the work with `/drive`. Default `"anyone"`. Optional, not in the seed |
| `specFlow` | how a human approves a spec: `"merge"` (default, for a team: the spec branch is merged into the base branch) or `"branch"` (one person: spec, plan and code in the current branch; the driver's gate:spec-approve is the approval, a later spec change is approved again). Optional, not in the seed |
| `language` | the operator chat's language: `{ "chat": "ru", "terms": "en" }`; both default to `en`. Optional, not in the seed |
| `sandbox` | `allowedDomains`: the domains Bash may reach inside the OS sandbox. `generate` seeds it from detection (the package manager's registry, plus `github.com` and `api.github.com` for GitHub); `update` reads it and writes it into `settings.json`. An empty list means Bash has no network. To add a domain, edit the list, then run `update` |
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
agent-stack run --resume [<run id>] [--answer <text>]… continue a waiting or interrupted run
agent-stack run --status [<run id>] [--json]           print the run; change nothing
agent-stack run --cancel [<run id>]                    cancel a waiting or interrupted run
agent-stack run --watch [<run id>]                     show the run live until it ends; change nothing
agent-stack run --stats [--json]                       sum up every run of this repo; change nothing
```

**Quick mode.** Creates `quick/<slug>` from HEAD, runs your test command on it (it must pass), then one
implement call. The driver runs the checks (the test command, plus lint on changed files). A diff above
`quickReviewLines` is also reviewed. Then the driver commits (`<type>(quick): <subject>`) and stops at the accept gate.

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

**Gates.** Each gate prints one short card: a title, the facts, what is needed from you and the answers it
takes. The run file keeps the card, and `--status --json` gives the same card to a program. At a terminal,
answers are read from the prompt; `c` cancels at any gate. With no terminal the run is recorded as waiting and
exits. A gate `limit` appears when attempts run out, a task is BLOCKED, the review
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
without a terminal or after `--answer`. `1`: a refusal or an error; the message says what to do.

**From a chat.** In Claude Code, `/drive <what to build>` makes the chat an operator: it starts the run, shows
you each gate card in your language, passes your answer with `--resume <id> --answer "<line>"` (`""` is Enter;
one `--resume` answers one gate, and extra or wrong answers apply nothing), and reports at the end. It does no
step's work itself. To hold that with a hook, set `"codeBy": "driver"` in `.claude/gates.json`: then only a live
driver call edits code (docs and `.claude/` stay open). The chat speaks English unless
`"language": { "chat": "ru", "terms": "en" }` says otherwise; terms, keys and commands are never translated.
To see a run while it works, open `agent-stack run --watch` in any terminal (also the one inside VSCode): each
step with its time, the step in progress with its last tool lines, and the gate it waits at. Each tool a role
starts also prints a line under its step (`· Read src/a.ts`,
`· Bash pnpm test`), the run folder keeps `now.json` and `progress.log`, and `.claude/bin/run-status` gives one
line for Claude Code's status line (`run <id> · implement:T1 · 1:35 · $0.46 · Edit src/a.ts`). The status line
shows in Claude Code in a terminal; the VS Code extension does not show a custom status line, so there use
`run --watch`. It is off by default, since a project status line would replace yours; turn it on in
`.claude/settings.local.json`:
`{ "statusLine": { "type": "command", "command": ".claude/bin/run-status" } }`.
To see how the driver has worked over time, run `agent-stack run --stats`: one line per run (status, tasks passed
on the first attempt, attempts per task, rejects at gates, limit stops, calls, work and waiting time, cost), then
the totals with call outcomes by role and permission denials. `--json` gives the same numbers for a program.
Spec: [docs/specs/stats1/SPEC.md](docs/specs/stats1/SPEC.md).
Hints print the command as you started it (`agent-stack run …`, or `node <path>/cli.mjs run …`). A run starts
only on a harness from 0.4.1 on; with an older one it says to run `update` first.

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

- **Blocklists for the tools.** Guards catch an agent's mistakes, not a determined bypass: a file written
  through Bash (`sed -i`, `>`) skips the Edit/Write gates, and command matching is regex-based (known false
  positive: `git push` quoted inside another command's argument is blocked, and so is a heredoc that writes a
  file containing `git push` or another package manager's command. Use the Edit or Write tool for such a file.
  The guard does not skip heredoc text, because a heredoc fed to a shell runs it). Put the same checks in CI
  for anything that must hold.
- **OS sandbox (Bash only).** The generated `.claude/settings.json` turns on Claude Code's OS sandbox (the
  sandbox block).
  - It covers Bash and its child processes only. Read, Edit, Write, WebFetch, WebSearch, MCP servers and hooks
    run outside it.
  - **Network:** for Bash, only the listed domains are reached without a question. The list is `gates.json` →
    `sandbox.allowedDomains`. WebFetch is not limited by it. Node's built-in `fetch` does not use the sandbox
    proxy, so it fails even for a listed domain. Set `NODE_USE_ENV_PROXY=1` for it (checked on Node 22.21).
  - **Package cache:** Bash may write to the cache folders of the detected package manager, so an install does
    not fail with EPERM. npm: `~/.npm`. pnpm: `~/Library/pnpm/store`, `~/Library/Caches/pnpm`,
    `~/.local/share/pnpm/store`, `~/.cache/pnpm`. yarn: `~/Library/Caches/Yarn`, `~/.cache/yarn`,
    `~/.yarn/berry/cache`. bun: `~/.bun/install/cache`. Any other package manager gets no write path.
    The harness writes both the macOS and the Linux paths on every OS.
    The list is `sandbox.filesystem.allowWrite` in `.claude/settings.json`; `update` adds missing paths and
    keeps yours.
  - **Secret folders:** Bash cannot read `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.docker`, `~/.netrc`,
    `~/.npmrc`, `~/.config/gcloud` and `~/.azure`. The Read tool is not covered; guard-file still handles it.
    `~/.config/gh` stays readable on purpose, so `gh` keeps its token. Git over SSH fails inside the sandbox,
    because `~/.ssh` is unreadable. If you remove a secret folder from `denyRead`, `update` keeps it removed and
    warns on each run.
  - **No `Read(...)` deny rules:** with the sandbox on, Claude Code applies them to Bash too, so a command
    could not read `node_modules`, the lockfile or build output. guard-file denies the Read tool (and Grep
    on such a path) for `gates.json` → `protectedGlobs`, `node_modules/` and `coverage/`. Bash can still
    read these. `update` warns when `settings.local.json` still has such rules; remove them by hand.
  - **The domain list is not a hard limit in every permission mode.** The model can pass a list of hosts with
    one Bash command. In the default mode Claude Code asks you. In auto mode its classifier decides and you are
    not asked. With `bypassPermissions` the host is reached without a question. The hard lock is
    `sandbox.network.allowManagedDomainsOnly`, and it works in managed settings only.
  - **Harness files Bash can still write:** `.claude/gates.json`, `.claude/bin/` and `CLAUDE.md`. guard-file
    stops the Edit and Write tools there, not a script run through Bash. The sandbox does deny Bash writes to
    `.claude/settings.json`, `.claude/settings.local.json`, `.claude/hooks/`, `.claude/agents/` and `.git/hooks/`
    (checked on macOS, Claude Code 2.1.329). A fix is planned.
  - `dangerouslyDisableSandbox` does not take a command out of the sandbox (checked: the read of `~/.ssh` still
    fails with it).
  - **Who wins:** a `false` in user settings, `--settings` or managed settings wins over the project value.
    Loosening entries in the repo's settings files are ignored only when managed settings or `--settings` set
    `allowUnsandboxedCommands: false`. For a lock the repo cannot loosen, put this block in managed settings, or
    pass it with `--settings`:
    `{"sandbox": {"enabled": true, "failIfUnavailable": true, "allowUnsandboxedCommands": false}}`.
  - `sandbox.excludedCommands` runs a command outside the sandbox.
  - **Linux and WSL2:** the sandbox needs `bwrap` and `socat`. Without them every Bash command fails
    (`failIfUnavailable`). `generate` and `update` warn when one is missing. `agent-stack detect` reports whether
    they are found, not whether the sandbox starts.
  - **Native Windows:** the sandbox is not documented there, so Bash commands most likely fail. Use WSL2.
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
  - irreversible commands (`rm -rf`, `git reset --hard`) are left to Claude Code's own permission prompt;
  - tool results (web pages, MCP output) are not checked for injected instructions;
  - agent prompts, skills, CI workflows and `package.json` scripts are editable without a prompt. A bare install or
    update typed in Bash (`pnpm install`, `pnpm -C x install`, `pnpm up`, `yarn`) asks first; a package script
    that runs one (`"setup": "pnpm install"`) is not caught. Under `agent-stack run` a changed script, a new
    dependency or a changed `jest`/`eslintConfig` setting stops the run; in a chat session the edit itself is not
    caught;
  - manifests other than `package.json` (`pyproject.toml`, `Cargo.toml`, `go.mod`) are not compared, and a
    lockfile edited through Bash is not caught.
- **The MCP catalog is not maintained:** most entries run `npx -y` without a pinned version, and
  `server-github` is archived upstream. Check an entry before `mcp install`.

## Experimental parts

The first trial (lex-poc, 10 chat sessions, before the driver) showed parts that never acted, or acted without
helping. Since 0.4 the pipeline driver calls several of them itself. The right column is from this repo: 13 driver
runs, 20–25/11 (`agent-stack run --stats`: 4 clarify, 7 spec, 4 plan, 73 implement and 51 review calls), and the
chat sessions of 18–25/11 (`agent-stack usage --days 7`). A part that stays unused across several weekly
`usage --save` summaries is removed in a later version.

| Part | First trial (chat, before the driver) | Now (driver and chat, this repo) |
| --- | --- | --- |
| `/plan` → `tasks.json` → `bin/verify` | no `tasks.json` written | the plan step follows `/plan` and writes `tasks.json` (4 plans); the driver runs `bin/verify` after each task and once at the end (32 runs) |
| `spec-reviewer` subagent | called once (~47k tokens), result discarded | the spec step follows `/spec`, which runs it: 20 runs |
| `/grill` skill | never called | the clarify step asks the grill questions (at most 5); the skill file itself is not loaded |
| `evidence-gate` hook | ran 218 times, stopped nothing | ran 580 times, output once — a candidate for removal |
| `cheat-guard` hook | never blocked | blocked 6 times; the driver also checks skip marks and frozen tests itself, from the same `cheatPatterns` |
| `arch-guard` hook | never blocked (no `layers` until an ADR sets them) | the same: this repo sets no `layers` |
| `bin/health` | never run in the project | 32 runs, inside task verifies; its 400-line limit failed tasks in the `evals1` and `effort1` runs |
| `post-edit-lint` hook | never reported (`lintMatch` empty) | still silent: this repo has no linter |
| `task-analyzer`, `pattern-scout` subagents | never called | never called; the driver does not use them |
| `/migration` skill | never called | never called |
| `/mr-description` skill | never called | used once by hand, for the 0.4.8 pull request |
| `/review`, `/reflect` commands, `stop-flag-reflect` hook | never called; the hook only raises a flag for `/reflect` | never called; the hook ran 580 times |

Proven in use: `guard-bash` (10 blocks in the last week), `guard-file` and `spec-gate` (proven in the first
trial; no event in the last week), `session-start-context`,
`bin/trace` (98 runs), `/spec`, `/adr`, `implementer` and `code-reviewer` (the driver's implement and review steps
take their rules), `test-writer`, `researcher`. `usage` counts a driver call as a main session, not as a subagent,
so it lists `implementer` as never acted. How to read the summaries:
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
