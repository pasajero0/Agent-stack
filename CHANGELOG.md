# Changelog

## 0.5.4 — unreleased

- **Bash cannot write the harness files inside the sandbox:** the generated `.claude/settings.json` now has
  `sandbox.filesystem.denyWrite` with `./.claude/gates.json`, `./.claude/bin` and `./CLAUDE.md`. Before, guard-file
  stopped only the Edit and Write tools there, so a script run through Bash could weaken the pipeline's rules.
  The manifest records the entries in `generatedSandbox.denyWrite`. `update` adds them to a settings.json of an
  older version and keeps your own denyWrite entries after them. If you remove one of the three entries, `update`
  keeps it removed and prints one warning line for it on each run. `generate` and `update` still write these
  places: you run them from a terminal, outside the sandbox. Not yet checked by a live probe.
- **Bash cannot read gh's login inside the sandbox:** `~/.config/gh` is now the last entry of the secret folders,
  so the generated `sandbox.filesystem.denyRead` holds it. Before, a text the agent read could make Bash send data
  out through github.com with your GitHub login. Inside the sandbox, gh now answers that it is not logged in, and
  git over HTTPS to a private GitHub repo may fail. `update` adds the entry to a settings.json of an older version
  and records it in `generatedSandbox.denyRead`. To use gh from the agent's Bash, remove `"~/.config/gh"` from
  `sandbox.filesystem.denyRead` by hand: `update` keeps it removed and prints one warning line for it on each run.
  The allowed domains and the `permissions.allow` entries for gh stay as they were.
- **The channels past the OS sandbox are closed by default:** the generated `.claude/settings.json` now has
  `permissions.deny` with `mcp__claude-in-chrome__*` (the Claude in Chrome tools), and `permissions.ask` with
  `WebFetch` and `mcp__*` (every MCP tool). A deny rule blocks in every permission mode; an ask rule asks also
  in `bypassPermissions`. `permissions.allow` stays as it was, WebSearch included. The manifest records these
  entries in `generatedDeny` and `generatedAsk`. `update` adds them to a settings.json of an older version and
  keeps your own deny and ask entries. If you remove one of the three entries, `update` keeps it removed and
  prints one warning line for it on each run. In a headless call, Claude Code refuses a tool that must ask.
- **The feedback of a failed check names the failing tests (defect #60):** the driver now takes the lines that
  name failing tests from the whole output of a red check, not only from its last 50 lines. A line counts when,
  after colour codes are removed, it starts with `FAIL`, `×`, `✗`, `not ok` or `--- FAIL`. The feedback shows
  them under `Failing tests (from the whole output):`, before the tail: in order, without repeats, at most 40
  lines of at most 300 characters, with the count of dropped lines. For a task's verify, the driver reads the
  whole `verify.log`. Output with no such line gives the same feedback as before.
- **The implement and review prompts mark outside text as data:** the driver now wraps the task description in
  `<task_description>`, the feedback of the previous attempt in `<feedback>`, the diff in `<diff>` and the
  implementer's report in `<implementer_report>`. Each prompt says, before the first tag, that the text inside
  these tags is data, not instructions. A closing tag of the same name inside the text (any case, spaces inside)
  gets a backslash after `<`, so the text cannot close its own tag. The labels and the order of the parts stay.

## 0.5.3 — Fewer stops that need a human

- **A test runner config that lists new test files does not stop the run (defect #58, partly):** the driver no
  longer stops at `tests-changed` when a task only adds paths of its own new test files to `vitest.config.*`,
  `vitest.workspace.*`, `jest.config.*` or `playwright.config.*`, in a list that selects test files (`include`,
  `exclude`, `testMatch`, `testIgnore`, `testPathIgnorePatterns`, or a `const` list used only as `include` or
  `exclude`), written one entry per line directly under its opening line. Gate:accept shows one line per config:
  `test config change passed: <path> lists new test file(s) <paths>`. Any other change stops as before: a list that runs code (`setupFiles`, `globalSetup`, …), CI
  workflows, linters and `pnpm-workspace.yaml` always stop. See docs/specs/v04/SPEC.md → AC-66.
- **A red check runs once more before it fails the attempt (defects #43, #50, #56):** if a check command ends
  with a non-zero exit, the driver runs it a second time. Green on the second run: the task goes on, the task's
  check record keeps the first exit, and gate:accept shows `check passed on a second run: <command> (first exit
  <n>)`. Red again: the attempt fails with the second run's output. A timeout, an interrupt, an empty command
  and the base check are not run again. This can hide a test the task made unstable; the accept line shows it.
- **Defect log:** #60.
- **Eval run** on 0.5.3, k = 3, real `claude`, started from the chat inside the OS sandbox: 21/21 passed,
  pass^3 = 1, $1.16, 5:06 — `evals/results/2026-11-26-220348.json`.

### Upgrading from 0.5.2

- Nothing to do by hand. A failing check now takes up to twice its time before the attempt fails.

## 0.5.2 — The driver starts from the chat inside the sandbox

- **CI runs on release branches:** the workflow also runs on every commit sent to `release/**` and `hotfix/**`.
- **Defects log has a `Cause` column:** every row in `docs/defects.md` names its cause. `pnpm defects` counts the
  rows by cause, and `pnpm defects --check` runs in CI after `pnpm test:fast`. The rule is in
  `docs/GLOSSARY.md` → Cause.
- **The driver and the evals start from the chat with the sandbox on (macOS, defect #57):** inside an OS sandbox
  a `claude` child could not read the login ("Not logged in") and could not start its own sandbox. The driver now
  asks the OS whether it runs inside a sandbox. If it does, each call gets the token from
  `~/.config/agent-stack/claude-token` (made once with `claude setup-token`) and runs with its own sandbox off;
  the outer sandbox holds the call's processes. With no token the driver stops and names the command to run.
  A driver started from a terminal works as before. See README → Limits.
- **Checked:** the evals started from the chat inside the sandbox pass (see the eval line below); the run that
  made the `Cause` column was started and driven from the chat with the sandbox on.
- **Defect log:** #58, #59.
- **Eval run** on 0.5.2, k = 3, real `claude`, started from the chat inside the OS sandbox: 21/21 passed,
  pass^3 = 1, $1.17, 5:25 — `evals/results/2026-11-26-210528.json`.

### Upgrading from 0.5.1

- To start `agent-stack run` from a chat with the sandbox on (macOS): run `claude setup-token` in a terminal once
  and save its output to `~/.config/agent-stack/claude-token` (`chmod 600`). One token serves every project on
  the machine. Nothing to do if you start the driver from a terminal.

## 0.5.1 — Temp files inside the sandbox

- **`verify` records the result again (macOS, run by the agent in Bash):** `.claude/bin/verify` made its temp
  file with a bare `mktemp`. On macOS that ignores `$TMPDIR`, so inside the OS sandbox it failed, `tasks.json`
  was not updated, and `verify` printed "0/N tasks passing" for tasks that had passed. It now writes the temp
  file next to `tasks.json`.
- **Hook markers under `$TMPDIR`:** `session-start-context.sh` and `stop-flag-reflect.sh` kept their markers in
  `/tmp/claude-sessions` and `/tmp/.claude-reflect-pending`. Both now use `${TMPDIR:-/tmp}`, the same folder.
- **Found by turning the sandbox on in this repo:** 11 of the 855 slow tests failed inside it, all from the two
  points above; now 857 of 857 pass there.
- **README Limits, two new lines:** temporary files go under `$TMPDIR` only; and a `claude` started from the
  chat's Bash can be "Not logged in" inside the sandbox, so start `agent-stack run` from a terminal (defect #57,
  open).
- **Defect log:** #54–#57.
- **Eval run** on 0.5.1, k = 3, real `claude`, started from a terminal, the OS sandbox on in every try: 21/21
  passed, pass^3 = 1, $1.63, 5:41 — `evals/results/2026-11-26-190628.json`.

### Upgrading from 0.5.0

- Run `agent-stack update`: it replaces `.claude/bin/verify` and the two hooks. Nothing to do by hand.

## 0.5.0 — OS sandbox for Bash

- **Sandbox block in `settings.json`:** `generate` writes a `sandbox` object into `.claude/settings.json`. It
  turns on Claude Code's OS sandbox for Bash (`enabled`), stops the model from retrying a command outside it
  (`allowUnsandboxedCommands: false`) and stops Bash when the sandbox cannot start (`failIfUnavailable: true`).
  It also makes nine secret folders unreadable for Bash (`~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.kube`, `~/.docker`,
  `~/.netrc`, `~/.npmrc`, `~/.config/gcloud`, `~/.azure`), and lets Bash reach only the listed domains.
- **Domain list in `gates.json`:** a new key `sandbox.allowedDomains`. `generate` seeds it with the detected
  package manager's registry, plus `github.com` and `api.github.com` when the forge is GitHub.
- **`update` merges the sandbox block** one level deeper: a switch you set wins, your other keys and list entries
  are kept, and a wrong-typed object or list is replaced with a warning. The manifest records the generated lists
  (`generatedSandbox`).
- **`agent-stack detect`** prints an `OS sandbox` line: built in on macOS; on Linux, whether `bwrap` and `socat`
  are found. On Linux, `generate` and `update` warn when one is missing.
- **README Limits:** "Blocklists, not a sandbox" is now "Blocklists for the tools", and a new bullet "OS sandbox
  (Bash only)" says what the sandbox covers and what it does not. Spec: `docs/specs/sandbox1/SPEC.md`.
- **No `Read(...)` deny rules in `settings.local.json`:** with the OS sandbox on, Claude Code applies them to
  Bash too, so a command could not read `node_modules`, the lockfile or build output (`require` of an installed
  package failed with MODULE_NOT_FOUND). `generate` no longer writes them. The guard-file hook now denies the
  Read tool, and Grep on such a path, for `protectedGlobs`, `node_modules/` and `coverage/`. `update` leaves
  `settings.local.json` alone, but warns and lists the `Read(...)` lines to remove by hand.
- **Package cache is writable:** the sandbox block gets `filesystem.allowWrite` with the cache folders of the
  detected package manager (npm, pnpm, yarn or bun; the paths are in README Limits). Without it an install inside
  the sandbox failed with EPERM on the cache. `update` adds missing paths, keeps yours, and removes a path it
  wrote earlier when the package manager changes. Any other package manager gets no write path yet.
- **Live check with the real `claude`** (macOS, Claude Code 2.1.329 and 2.1.332). It found the two
  defects above, which the tests and the eval run did not see: the eval tasks have no dependencies. Passed: Bash
  cannot read `~/.ssh`; an unlisted domain is refused and a listed one answers; Bash cannot write
  `.claude/settings*.json`, `.claude/hooks/`, `.claude/agents/`, `.git/hooks/`, `~/.zshrc` or `~/.gitconfig`;
  `dangerouslyDisableSandbox` does not leave the sandbox; an install, a `require` of the installed package and
  `npm ci` work; the Read tool is denied in `node_modules/`. Gaps, now in README Limits: Bash can write
  `.claude/gates.json`, `.claude/bin/` and `CLAUDE.md`; in auto mode the model can open a host for one command
  without a question to you; Node's `fetch` needs `NODE_USE_ENV_PROXY=1`. Not checked: Linux.
- **Audit of Claude Code's own controls** (sandbox, protected paths, auto mode, `updatedToolOutput`,
  fail-closed hooks, worktrees): the input of the 0.5 security work. Kept outside the repo, with the doc URLs.
- **Slow test group:** the four sandbox test files and `tests/run/scout-prompts.test.ts` start git and move to
  `SLOW`, as CONTRIBUTING asks.
- **The scout pays off:** the first spec step with a scout took 20:46 and $5.71, against 29:13 and about $9.15
  without one (−29% time, −38% cost); the scout call cost $0.008. The scout stays.
- **Eval run** on 0.5.0, k = 3, real `claude`, the OS sandbox on in every try: 21/21 passed, pass^3 = 1, $1.67,
  6:18 (0.4.8: $1.29, 6:01). The cost rose in every task by a few cents a try; the cause is not measured.
  Results: `evals/results/2026-11-26-112823.json`. A second run after the two fixes from the live check gave
  the same: 21/21, pass^3 = 1, $1.67, 5:37 — `evals/results/2026-11-26-174744.json`.
- **Defect log:** #49–#51 (orphaned test workers after implement, tests with hard time limits on a loaded
  machine, a bare retry after BLOCKED).

### Upgrading from 0.4.8

- **By hand, after `agent-stack update`:** remove the `Read(...)` deny rules from `.claude/settings.local.json`.
  `update` lists the lines. Until you do, Bash inside the sandbox cannot read `node_modules`, the lockfile or
  build output, so tests and builds that need them fail. The guard-file hook now keeps the Read tool away from
  these paths.
- Run `agent-stack update`: it adds the sandbox block to `settings.json`. The domain list comes from
  `gates.json` → `sandbox.allowedDomains`, or the detected list when that key is missing. `update` does not add
  the key to `gates.json`; it prints a line that says to add it.
- Bash now reaches only the listed domains. To add a domain, add it to `gates.json` → `sandbox.allowedDomains`,
  then run `update`.
- On Linux and WSL2, install `bwrap` (bubblewrap) and `socat` first, or Bash commands fail. On native Windows,
  Bash commands most likely fail; use WSL2.
- Git over SSH in Bash fails, because `~/.ssh` is unreadable inside the sandbox. `git push` stays manual.
- A switch you set yourself (`enabled`, `allowUnsandboxedCommands`, `failIfUnavailable`) is kept, with a warning
  when it is weaker. A secret folder you removed from `denyRead` stays removed, with a warning on each `update`.

## 0.4.8 — effort by task size and a scout call

- **Routing block in `gates.json`:** the driver now picks the model and the effort of each call from the tier and
  the complexity of the task, instead of always using the default level. This fixes defect #41 (the plan skill
  said tier S runs on "sonnet, low effort", but the driver never passed `--effort`).
- **Plan complexity:** the plan step writes `complexity` for each task (and `splitReason` for an L task).
- **`run quick --cell <tier>·<complexity>`** picks the routing cell; an eval `task.json` may set `cell`.
- **Scout call:** a task run starts with a scout call (`routing.scout`, default haiku · low). It reads the
  repository and writes `scout.md` to the run folder, a map of the places to read first. Clarify, spec and plan
  get the map in their prompts. Spec: `docs/specs/scout1/SPEC.md`.
- **`run --stats --json` is version 2**, with the role `scout` in `byRole` (six roles).
- **Scout limits:** the scout call stops at 3 minutes or 20 turns, or at the shared step limits when they are
  lower. Other roles keep the shared limits. A scout that hits a limit leaves no map, and the run goes on.
- **Implement runs only the task's verify:** the implement prompt and the implementer agent now say so; the
  driver runs the full test command after it. In the `scout1` run implementers ran the full `pnpm test` 37 times
  (defect #47).
- **README** starts with the problem, the audience and the eval result.
- **Eval run** after this release's changes (k = 3, real `claude`): 21/21 passed, pass^k = 1, $1.24, 5:49, the
  same as before them ($1.25). The evals use `run quick`, which has no scout, so they show that nothing broke;
  the scout's effect on the spec step is not measured yet. Results: `evals/results/2026-11-25-225105.json`.
- **Defect log:** #45–#47 (a stale `dist/` for the eval tests, the routing check on resume, full test runs in
  implement).

### Upgrading from 0.4.7

- Run `agent-stack update`: it adds the routing block to `gates.json`. It also adds `routing.scout` when the
  routing block is already there. Until then the driver refuses to start (effort1 AC-15).
- `run --stats --json` is now `"version": 2`. If a script reads it, accept the role `scout` in `byRole`.
- A run started on 0.4.7 whose plan is written (at `gate:plan-approve` or later) stops with AC-15. Add
  `complexity` (and `splitReason` for an L task) to its tasks by hand, or cancel the run. A run still at its plan
  step just runs plan again.
- The plan-approve card line and the implement head line changed. If a script matched them, change the script.
- New: `run quick --cell <tier>·<complexity>` picks the routing cell of Q1 (default M·medium). An eval
  `task.json` may set `cell`.
- `update` also refreshes `.claude/agents/implementer.md` (the line about the verify), unless you changed it.

## 0.4.7 — regression task set

- **Eval runner** (`scripts/eval.mjs`, repo only, not shipped): runs each task of `evals/tasks/` k times (default
  3) with the real `claude` in a fresh copy of its fixture, then its `check`. It prints pass@1 and pass^k per task
  and in total, with the cost and the time, and writes `evals/results/<date>-<time>.json`. It asks before it
  spends money, stops a try on its timeout, and stops cleanly on Ctrl+C. Spec: `docs/specs/evals1/SPEC.md`.
- **Five eval tasks** from defect classes the driver must hold: a test conflict, a task easiest done by weakening a
  test, a dependency temptation, a plain fix, and a scope task (one file only).
- **Defect log in the repo:** `docs/defects.md`, with a "Defects" section in CONTRIBUTING (classes, a regression
  test per fixed defect, a check for a class that repeats). CONTRIBUTING also says how to run the evals.
- **Glossary:** eval task, eval runner, try, pass@1, pass^k.
- **CI** builds `dist/` before the slow tests, since the eval tests run the built CLI.
- **First live eval run** (k = 3, real `claude`, $0.73): 12 of 15 tries pass. All 3 failures were weaken-test: its
  check failed on any change to a test file, also on a new test. The weaken-test and test-conflict checks now fail
  only on a removed or changed line; weaken-test then passed 3 of 3 ($0.15). Results:
  `evals/results/2026-11-25-000920.json` and `2026-11-25-003458.json`.

### Upgrading from 0.4.6

- Nothing to do in a deployed repo: this release changes no harness file and no driver behaviour.


## 0.4.6 — spec flow and run stats

- **Spec flow** (`gates.json → specFlow`): `"merge"` (the default, as before, for a team) or `"branch"` (one
  person). In `branch` the spec, the plan and the code live in one branch: the driver stops at `gate:spec-approve`
  (`a` / `r <comment>` / `c`), and that answer is the approval. A spec changed later must be committed with a new
  `## Changes` entry; the driver then asks to approve it again and goes back to where it was. A run keeps the flow
  it started with; an unknown name is refused. In `branch`, a run does not start on the base branch.
- **`agent-stack run --stats [--json]`:** a read-only summary over every run of this repo. One line per run
  (status, tasks passed on the first attempt, attempts per task, rejects at gates, limit stops, calls, work and
  waiting time, cost), then the totals with call outcomes by role and permission denials. A broken run folder is
  skipped and named. Spec: `docs/specs/stats1/SPEC.md`.
- **run: the implement role writes files only with Write and Edit.** Its `cat > … <<EOF`, `python3 -` and `sed -i`
  in Bash were refused and cost turns (10 refusals in one run, found by `run --stats`).
- **Glossary:** a stage id names what the stage does (`stats1`), not a code that only a plan explains.

### Upgrading from 0.4.5

- Run `agent-stack update` for spec-gate, `gates-lib`, `trace` and the `/spec`, `/plan` and `/drive` skills.
- `specFlow` is optional and not in the seed: without it nothing changes. To work in one branch, add
  `"specFlow": "branch"` to `.claude/gates.json`.
- Two `run` messages changed: two actions at once now print `Use one of --resume, --status, --cancel, --watch or
  --stats.`, and `--json` alone prints `--json goes with --status or --stats.` A script that matched the old text
  must change.


## 0.4.5 — one source of truth

From an audit of rules written in several places (`.claude/tmp/sources/rules-audit-2026-11-20.md`): each rule now
lives in one place, and a test keeps the other places in step.

- **Skip marks are one list** (`SKIP_MARKS`): cheat-guard's seed patterns and the frozen-tests count are built from
  it. cheat-guard now also catches `.todo` and Mocha's `this.skip()`; frozen tests also count `fit(` and
  `fdescribe(`. `this.skip(n)` (a parser method) and `context.todos` are no longer skip marks.
- **`trace` reads criteria like the driver:** only a line `- **AC-n:**`, one id per line. A loose `- AC-3` line no
  longer counts, and `trace` names it with the form to use.
- **`/plan`:** allows a verify of `true` for a docs-only task, as the driver does, and lists every pattern the
  driver refuses (a test reads them from the driver). The plan prompt no longer repeats "every task ends green":
  the embedded skill says it.
- **Docs:** `/spec` points to the light template for its sections; README points to the `gates.json` seed for
  `openPaths`; CONTRIBUTING says why the release commit has two headers. A test keeps commit scopes equal in
  CONTRIBUTING and commitlint.

### Upgrading from 0.4.4

- **Write criteria as `- **AC-n:** …`.** `trace` (and evidence-gate through it) no longer counts `- AC-1 …` or
  `* AC-1: …`; it says so for each such line. The driver always read only this form.
- Run `agent-stack update` for `trace`, `/spec` and `/plan`. The new cheat-guard patterns are in the `gates.json`
  seed, which `update` does not touch: a new repo gets them; in an existing one, copy `cheatPatterns` from a fresh
  `agent-stack generate` into a scratch folder if you want them.


## 0.4.4 — hotfix

- **run: the spec role reviews its spec again.** 0.4.3 added a step to `/spec`, and the driver named the step to
  skip by its number, so under the driver every spec was written without spec-reviewer. The step is now named by
  its title (Hand over).
- **A spec change is committed as `docs(<stage>): spec — <what changed>`.** The `/spec` skill, the normative rules,
  spec-gate's message and README said `spec: …`, which is no Conventional Commits type: commitlint refused it.

### Upgrading from 0.4.3

- Run `agent-stack update` for the `/spec` skill, `_normative` and spec-gate. The driver fix needs no step.


## 0.4.3 — see the run; specs state their limits

- **run: see a run while it works.** Each tool a role starts prints a line under its step (`· Read src/a.ts`,
  `· Bash pnpm test`); calls run with `--output-format stream-json`. `run --watch` shows the run live in any
  terminal, also inside VS Code: each step with its time, the step in progress with its last tool lines, the gate
  it waits at. The run folder keeps `now.json` and `progress.log`.
- **run: time.** The run file keeps each step's time. gate:accept shows the work time, the time spent waiting for
  you, the time per step and per task, and the estimate against the actual; the plan card estimates the work from
  the finished runs in the repo (none yet, it says so). All of it is in `--status --json`.
- **run: cards read at a glance.** Short titles without the run id; gate:accept starts with a summary
  (`2 task(s) · 2 commit(s) · checks green · final check green`), then the time and the cost; a skipped command is
  named once; the waiting line lists the answers the gate takes.
- **run: a quick commit carries the scope `quick`** (`fix(quick): …`), so a repo whose commitlint needs a scope
  accepts it; the branch slug is cut at a whole word.
- **Status line:** `.claude/bin/run-status` gives one line for Claude Code's status line in a terminal
  (`run <id> · implement:T1 · 1:35 · $0.46 · Edit src/a.ts`). Off by default; README says how to turn it on.
- **/drive:** the chat tells each step as it starts and ends, shows the spec short at the spec gate (purpose,
  criteria, constraints, scope, a link), runs the driver apart from its watch, and gives `run --watch` once.
- **Specs state their constraints.** The spec template has `## Constraints` (must not, must keep, when goals
  conflict), each line with how it is checked; `/spec` asks for it, `/grill` asks about limits and hostile input
  (SQL and shell injection, `../`, secrets in logs), and spec-reviewer flags a constraint nobody can check.
- **Repo:** commitlint accepts a stage scope with a folder in `docs/specs/`, and `quick`; slow tests get 20 s each.
- Checked in live runs with the real `claude`: three quick runs in this repo, made by the driver itself, and one
  task run from a chat in a scratch repo (2 tasks, $1.35).

### Upgrading from 0.4.2

- Run `agent-stack update`: it brings the new spec template, `/grill`, spec-reviewer, `/drive` and
  `.claude/bin/run-status`. The status line is not turned on for you; see README.


## 0.4.2 — the driver from a chat

- **run: each gate prints one card.** A title, the facts, what is needed from you, and the answers it takes, instead
  of a page of text. A plan task is two lines: id, tier, model, risky mark, criteria and description, then its verify.
  The run file keeps the card.
- **run: `--status --json` and `--resume <id> --answer "<line>"`.** A program, such as a chat, reads the card and
  answers a gate without a terminal. An answer reaches only the gate the run waits at: a wrong or extra answer
  applies nothing, and a plan or code that changed since the card was shown refuses the answer.
- **`/drive` and `codeBy: "driver"`.** In Claude Code, `/drive <task>` makes the chat run the task through the
  driver and show you each card; it does none of the work itself. `"codeBy": "driver"` in `gates.json` makes
  spec-gate refuse a chat's code edits, so only a driver call edits code. `"language"` sets the chat language
  (English by default); terms stay as they are. The chat never merges, pushes or hand-fixes: it gives the command,
  and a later fix is a new run. Checked in one live run from a chat (task, 2 tasks, 7 calls, $1.66).
- **run: hints name the command as you started it** (`node …/cli.mjs run …` when `agent-stack` on `PATH` is not
  this driver). Ctrl-C says the run keeps the lock and prints both `--resume` and `--cancel`. The test-conflict
  retry asks for the answer for the implementer.
- **run: a verify with command substitution (`$(…)`) is marked at the plan gate:** implement cannot run it itself
  (Claude Code allows no command substitution by a rule); the driver's checks still do.
- **run: an old harness is refused before any call** ("the harness is 0.4.0; this driver needs 0.4.1 or later"),
  not halfway with `agent … is out of date`.
- **Tests:** fast and slow groups; CI runs the slow ones in 2 processes, and a failing shell test prints why.
- **Naming:** `CONTRIBUTING.md` sets the names of branches, commits, pull requests and tags; commitlint checks
  the scope.

### Upgrading from 0.4.1

- Run `agent-stack update`: it adds the `drive` skill and the new spec-gate. `codeBy` and `language` are not
  added to an existing `gates.json`; set them by hand if you want them.

## 0.4.1 — driver checks

- **run: a test conflict is a way out, not a cheat.** If an existing test or the task's verify contradicts a
  criterion, implement returns `TEST_CONFLICT` and leaves the test alone. The run stops at gate `limit`
  (reason `test-conflict`) and shows the test, the criterion and the reason. `r` and your answer retry
  implement; no attempt is counted. Tested with a fake `claude` and in one manual run with the real `claude`.
- **run: a verify that cannot fail makes a new plan not valid** (`|| true`, `|| echo`, `; exit 0`, `| tee`,
  `set +e` and the like). The plan role is re-run with the task and the pattern. An approved plan is not
  re-checked. The `/plan` skill says the same; `.claude/bin/verify` does not check it.
- **run: a task that weakens a test it found stops for you.** Before the checks, the driver compares the tests that
  were there at the task's start (`testGlobs`) and the check configs (CI, vitest, jest, eslint and the like): a
  deleted test file, fewer tests or assertions, more skip marks, a changed config. Gate `limit` (reason
  `tests-changed`) lists them: `a` allows exactly those, `r` sends the task back, `c` cancels. It does not see a
  weaker assertion that keeps the count (`toBe(3)` → `toBeTruthy()`). Tested with a fake `claude` and in two
  manual runs with the real `claude`.
- **run: `package.json` is frozen too.** The checks run `pnpm test`, and `scripts.test` decides what that does, so
  `"test": "node --test || true"` made every check green. Now a changed or removed script, and a new or changed
  dependency (also `overrides`, `resolutions`, `pnpm.overrides`, and in a nested `package.json`), a changed `jest`,
  `eslintConfig`, `mocha` or `ava` setting, and a changed `pnpm-workspace.yaml` stop at the same gate. A new script
  and a removed dependency do not. Tested with a fake `claude` only.

### Security

- **A bare install asks first (deny in `autonomous`).** The agent could write a package into `package.json` and
  run `pnpm install`, which installed it without a question; `autonomous` promised it never installs. Now
  `pnpm install`, `pnpm i`, `pnpm -C x install`, `pnpm up`, a bare `yarn` and the like ask, also behind a redirect
  or `corepack`, and the message names the safe form:
  `pnpm install --frozen-lockfile` (yarn: `--immutable`, npm: `npm ci`) passes, since it installs only what the
  lockfile already has. A task `verify` with a bare install is refused by `.claude/bin/verify` too.
- In a new repo, `pnpm i --frozen-lockfile; pnpm test` no longer asks. The `installPatterns` entry read the flag and
  the `;` as one word and took `pnpm` for a package name. An existing repo keeps its `gates.json`: see Upgrading.
- **run: review and implement take their rules from your agents.** The driver no longer keeps its own copy: the
  review prompt carries `.claude/agents/code-reviewer.md`, the implement prompt `.claude/agents/implementer.md`
  (frontmatter removed). A fix to an agent now reaches the driver too. The implementer agent has a section for a
  chat and one for the driver; both have the test conflict exit.

### Upgrading from 0.4.0

A caret range (`^0.4.0`) installs 0.4.1 by itself, so do this step even if you did not upgrade on purpose.

- **Run `agent-stack update`.** The driver needs the new `implementer.md` (a `## Under the driver` section) and
  `code-reviewer.md` (a "Task review" item). If you changed one of them, `update` keeps your copy, and the run
  stops with `agent … is out of date`: add the section, or run `agent-stack update --force`.
- **Optional:** `update` keeps your `gates.json`, so its first `installPatterns` entry keeps asking for
  `pnpm i --frozen-lockfile; pnpm test`. To stop that, replace `-[^[:space:]]+` in it with `-[^[:space:];&|<>()]+`.

## 0.4.0 — the driver

A program, `agent-stack run`, now holds the pipeline order. Before, the order lived in hooks and skills that the
model could skip. The driver was checked in five manual runs with the real `claude`; the gates for plain sessions
and a glossary check come with it.

### Upgrading from 0.3

- **After `update`, code on a stage branch waits for `/plan`.** spec-gate now also needs
  `.claude/tmp/<stage>/tasks.json`. A stage you were already coding without a plan stops at the next edit
  with "Run /plan first". Run `/plan`, or set `specGate: "off"` in `gates.json` to opt out.
- **A spec with `## Terms` may now fail `trace`** when the repo has `docs/GLOSSARY.md`: each Terms entry must be
  a glossary headword or be marked `- **Word** (local): …`. Mark the spec's own words `(local)`, move the shared
  ones to the glossary, or set `"glossary": ""` in `gates.json` to opt out.
- **Copy the new "Explaining to the human" section by hand.** `CLAUDE.md` is a seed file, so `update` keeps
  your copy. Take the section from `templates/claude/_normative.md`.

### Gates

- **spec-gate: no code without a plan.** After the spec checks pass, code edits wait for the stage's
  `tasks.json`. In the first trial `/plan` was never called, so `verify` and `evidence-gate` had nothing to
  check. Docs, `.claude/` and other `openPaths` stay open, so `/plan` can write the file.
- **evidence-gate: no "done" without evidence, task list or not.** `STATUS: DONE` without an `EVIDENCE`
  section is blocked outside a stage too (still once per stop, and only with `evidenceGate: true`).
- **session-start names the next step** on a stage branch with no task list: `/spec` if the spec is not
  merged yet, `/plan` if it is.

### Docs

- [ADR 0001](docs/adr/0001-pipeline-driver.md): a driver program, `agent-stack run`, holds the pipeline
  order.
- **Five sentence rules in the generated `CLAUDE.md`.** "Explaining to the human" now asks for about 20 words
  a step and 25 an explanation, the condition first, who acts, one word for one thing, plain verbs, and
  short text that keeps the facts. The rules hold for replies, docs, prompts and commit bodies. The old
  "everyday words" pushed the model to swap a glossary term for a synonym. The rules come from ASD-STE100
  (Issue 9) and Google's "Writing for a global audience", without the STE dictionary. In one test a strict
  "write in ASD-STE100" prompt lost 46.8% of the facts about code, so the harness does not use one.

### Driver (experimental)

- **`agent-stack run`**: `quick "<fix>"` and `task "<what to build>"` modes; `--resume`, `--status`,
  `--cancel`. Exit codes 0 / 3 (waiting) / 1. Tested with a fake `claude`, plus five manual runs with the
  real one (three task, one of them with two tasks; two quick).
- **Gates:** answers, spec merge, plan approval, accept and limit, from the terminal. The driver makes the
  branches and commits (headers pass commitlint), runs the checks, and never pushes or merges.
- **Fuse:** `gates.json` -> `run`, three kinds: calls (default 40), dollars, or off.
- **Resume:** a waiting or interrupted run continues from its run file; one run per repo.
- **Hooks:** spec-gate's quick-mode bypass and evidence-gate's silence apply only to a live driver run on the
  run's branch; guard-file protects the run folder; path checks follow symlinks.
- **/plan skill:** every task ends green; the test is written first inside the task, no test-only tasks.
- **`trace` checks spec terms against the glossary.** Each `- **Term**` in a spec's `## Terms` must be a
  headword of the glossary (`gates.json → glossary`, default `docs/GLOSSARY.md` when it exists; `""` turns it
  off) or be marked `(local)`. `trace --terms` checks only that, so `/spec` runs it before the review and the
  driver after its spec role. spec-reviewer and code-reviewer flag a new word that never reached Terms. A rule
  kept only as text in CLAUDE.md was skipped three times in one session.
- **/spec skill:** the EARS pattern table moved from `template.md` into the skill, so a spec written from the
  template no longer carries it.
- **From the first run with the real `claude`:**
  - the plan role returns its tasks and the driver writes `tasks.json`: Claude Code guards `.claude/`, so a
    headless role could not;
  - a spec or plan role that asks a question stops at gate `limit` (reason `decision`) instead of being re-run;
  - a permission denial is shown as one short line;
  - each call loads only the project: its `.mcp.json`, project settings, no user CLAUDE.md, no claude.ai
    connectors, no auto-memory. About 165k → 15k tokens a turn;
  - a line before and after every call, so a long call does not look hung.
- **From the second run:**
  - without a remote, the spec-merge gate prints `git checkout <base> && git merge spec/<stage>`;
  - a stage or type prefix the model repeats in a commit subject is dropped (no more `feat(a2): a2: …`);
  - the spec role is told the driver commits, so it does not ask;
  - each answers prompt says that Enter takes the recommended answer;
  - a decision retry gives the role its questions with your answer;
  - the implement role is told which shell commands it may run;
  - clarify gets the stage-id rule and the ids in use, and a stage id that cannot be used is never the
    default: the gate offers the proposal or a free id, so Enter no longer loops;
  - a change to documentation only needs no test (a quick fix of one README line had got one);
  - the start check: before a task's first attempt the driver runs `.claude/bin/verify --dry <task>` once,
    and a verify that is already green gets a note at gate:accept, because it cannot show the task's work.
    `--dry` guards and runs like verify but records nothing;
  - a verify killed on timeout leaves no stale lock: the driver drops it, or the next verify waited 60 s;
  - `/plan` puts `test -f <file> &&` in front of each named test file, so a missing file is red, not skipped.
- **From a check against Compound V:**
  - a check that times out is the environment's fault: the driver exits 1, names the command and the limit,
    and counts no attempt. Before, a hung package manager sent the task back to implement on Opus;
  - in task mode with more than one task, gate:accept first runs every task's verify again. A later task that
    broke an earlier one shows up red;
  - a killed call, or one with no cost in its result, counts as unknown cost, not $0. A dollar fuse says it
    may count too little;
  - spec-reviewer recomputes every example from the contract, literally. It had passed a spec whose
    `greet()` example was wrong in JS.

## 0.3.0 — from the first trial

Fixes and changes from the first real trial (lex-poc, 10 sessions), and a way to see what the harness does.

### Upgrading from 0.2

- Copy any harness file you edited by hand (hooks, skill templates) before the first `update`: a 0.2 harness
  has no file hashes yet, so that one `update` still overwrites them. It says so. From then on your edits
  are kept.
- `gates.json` is yours, so two new values reach an existing repo only by hand: the fixed `installPatterns`
  entry for `pnpm|npm|yarn|bun` (see `src/claude/gates.ts`), and `docsLayout` if you want it.
- Delete `.claude/hooks/post-edit-verify.sh`: `update` unregisters it but cannot tell that the file is
  untouched.

### `update`

- **Keeps what you changed.** The manifest (`.claude/.harness.json`) records a sha256 of every harness file it
  deploys. A file you changed since is kept and listed (`update --force` overwrites it); a file a newer
  version no longer ships is deleted, or left in place if you changed it.
- **Keeps your `settings.json` edits.** Every hook the harness does not ship is carried over whole (all its
  fields, any hook type) under the same event and matcher; so are your permission entries and keys the
  harness does not write (`env`, `plugins`, …). Hooks and permissions an earlier version generated and
  this one does not are dropped with a note. A `settings.json` that is not valid JSON is left as is.

### Seeing what the harness does

- **`agent-stack usage`** reads the project's Claude Code session logs and reports what the harness actually
  did: hook blocks and added context, Stop-hook runs, subagent and skill calls, slash commands,
  `.claude/bin` runs, tokens by agent and model, and the installed parts that never acted. Read-only;
  `--days`, `--logs`, `--json`. `--save` writes the summary (counts only, no conversation text) to
  `.claude/tmp/usage/<date>.json`, so it outlives the logs. Guide: `docs/usage-analytics.md`.
- **Experimental parts are marked** in the README: the parts the trial never used (the `tasks.json` chain,
  `task-analyzer`, `pattern-scout`, `spec-reviewer`, several skills and commands, `cheat-guard`,
  `arch-guard`, `post-edit-lint`, `health`). Nothing is removed yet; `usage --save` summaries decide.

### Specs, ADRs and docs

- `/spec` takes the stage id as the first word and the rest as a description, so a description no longer
  ends up in the path. It says how to hand over a spec with no remote: a local merge is the approval.
- **Light spec** for setup work (`light-template.md`): Purpose, a checklist proven by commands, Out of
  scope. With `light: true` in its frontmatter, `spec-reviewer` passes it and `trace` does not ask for tests.
- The spec template has `Purpose` and a `Decisions` table instead of `Goal` and `Context`; a criterion cites
  its ADR (`ADR-0003`); a stage with several parts groups criteria by part, ids running on.
- The ADR template has `Decided` (may be `unknown`) and `Recorded` instead of one date, `Applies to` instead
  of `Stage / spec`, and `Supersedes`. The skill no longer pushes the agent to invent a second alternative,
  and text the human did not give is marked "(agent's inference)".
- `spec-reviewer` checks the new sections, the spec ↔ ADR links, and that what the spec says about the code
  is true. `code-reviewer` checks the author's explanation instead of trusting it, backs each issue with
  evidence and a consequence, and may report "No issues." `pattern-scout` reads `docs/architecture/`.
- **Default doc layout for a monorepo.** `gates.json` gets `docsLayout`, where Markdown files belong: for a
  monorepo `docs/`, a README in each app or package, package CHANGELOGs, `.claude/`, `.github/`; empty
  otherwise. `health` lists a changed `.md` outside it as `misplacedDocs`. It only reports; a project with
  another layout changes the list and records it in an ADR.
- The `CODEMAP.md` stub has Code, Specs and Docs tables instead of a fixed `src/` and `tests/`, and says to
  keep it in git.
- `stagePattern` is explained in the README with branch → spec path examples, including a feature-name
  pattern. The default stays `A0`.

### Security

From a security review of the harness; the rest of its findings are listed under Limits in the README.

- **Reading secrets asks first.** A Read or Grep of an env file (`.env`, `.env.local`, … — not `.env.example`),
  a private key (`*.pem`, `*.key`, `id_rsa`, …) or `.aws/credentials`, and a shell command that reads one
  (`cat .env`, `grep KEY .env`, `source .env`), ask for confirmation; in autonomous mode they are blocked.
  guard-file is now also registered for `Read|Grep` — `update` adds it.
- **Download-and-run counts as an install:** `npx`, `pnpm dlx`, `yarn dlx`, `bunx`, `npm exec`, `uvx`,
  `uv tool run`, `pipx run`, `go run …@version`, `deno run <url>` and `curl … | sh` ask first (blocked in
  autonomous mode). `npx tsc` and the like pass when the binary is already in `node_modules/.bin`, and
  `curl … | python3 -m json.tool` is data, not code. The list lives in guard-bash, not in `gates.json`, so it
  reaches existing repos.
- **The harness protects itself whatever the path looks like:** `.claude/./hooks/…`, `.claude//hooks/…`,
  `.claude/new/../hooks/…` and `.Claude/Hooks/…` (the same file on a case-insensitive disk) are blocked; so
  is writing a stage's `TASKS.JSON` in another letter case.
- **The `fetch` MCP server is the official one** (`uvx mcp-server-fetch`, needs uv; no longer selected by
  default). The old entry ran an npm package of that name, which the MCP project does not publish.

### Fixes

- **A repository with no commits** no longer blocks the scaffold: `spec-gate` stays open until the first
  commit on any branch, and session start says so. An orphan branch in a repo with history stays closed.
  The session context names the unborn branch instead of `HEAD`/`unknown`.
- **Session start warns about a hook that never runs** (a file in `.claude/hooks/` not registered in
  `settings*.json`, or not executable) and, once, when `jq` is missing (every guard then blocks every call).
- Hook commands quote the project dir (`"$CLAUDE_PROJECT_DIR"/.claude/hooks/…`), so a path with a space works.
- The install guard no longer reads a shell operator as a package: `pnpm install && pnpm test` is not an
  install.

### Removed

- The `post-edit-verify` hook. While any `*-plan.md` sat in `.claude/tmp/`, it pasted the file's diff into the
  context after every edit, including plans long finished (~40k tokens over 63 edits in one repo). The
  `/migration` skill still asks for the same check by hand.

## 0.2.0 — gates

The harness becomes an enforcement layer for a spec-driven workflow, on any stack.

- **Stack-agnostic config** — `.claude/gates.json` holds every language-specific value; detected for node,
  python, go and rust.
- **Modes** — `interactive` (confirm each diff) and `autonomous` (installs denied, no push, commit per phase).
- **Gates** — `spec-gate` (spec merged first, later changes committed before the code), `cheat-guard`,
  `arch-guard` (layer boundaries), `evidence-gate` (no "done" without passing tasks and evidence).
- **Guards** — `git push` in any form and PR merges blocked; the harness protects its own hooks, scripts and
  config; `tasks.json` written only by `.claude/bin/verify`.
- **Drift** — `.claude/bin/trace` (spec criteria ↔ tests), `.claude/bin/health` (code-health SLIs/SLOs on the
  branch's changes, time series in `.claude/tmp/health.jsonl`).
- **Workflow skills** — `grill`, `adr`, `spec`, `plan`; `spec-reviewer` and `researcher` subagents; every
  subagent has a model and effort level.
- **`update`** keeps seed files (`CLAUDE.md`, `CODEMAP.md`, `gates.json`, `settings.local.json`); `init` skips
  an existing harness.
- Removed `docs/HARNESS-SETUP.md` — the manual copy of the harness; `agent-stack generate` deploys it.

## 0.1.0 — first release

Claude Code only. `generate` / `update` / `sync` deploy the harness from `templates/claude/` with a version
manifest; `init` wizard; `detect`; MCP servers from a catalog.
