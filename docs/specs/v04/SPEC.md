---
stage: v04
---

# Pipeline driver, part 1: engine, gates, quick and task modes

## Purpose

After this stage a user can hand the pipeline to a program. They run `agent-stack run task "<what to build>"`,
or `agent-stack run quick "<small fix>"`.

The program:
- picks the next step;
- creates the branches and makes the commits;
- runs the checks itself;
- stops for the human at fixed gates.

The model only reads and edits files inside the step it was given. It can no longer skip `/plan`, and its
"done" is never taken on its word.

What exists today:
- hooks: spec-gate (which now also waits for `tasks.json`), cheat-guard, evidence-gate, guard-bash and
  guard-file;
- the skills `/spec` and `/plan`;
- `.claude/bin/verify`, the only thing that writes `passes`;
- the subagents `implementer`, `code-reviewer` and `spec-reviewer`.

Today the order of steps is kept by the skills, and the model may skip them. Later parts build on this engine:
part 2 adds bug and refactor modes, part 4 the baseline compare, part 5 the full review.

## Decisions

| ADR | Decided | What it means here |
| --- | --- | --- |
| [0001](../../adr/0001-pipeline-driver.md) | 2026-11-18 | A driver holds the step order in every mode, runs the checks itself and pauses for the human; hooks stay on |

Leonid decided these on 2026-11-18, in the grill and in two review rounds.

- **Quick mode** passes spec-gate only through the driver's own calls.
- **Review:** after every task, on that task's diff. It is simple in part 1.
- **Spec approval:** stop, merge, resume.
- **Epic:** the run proposes a split and stops.
- **Models:**
  - judgment roles run on Opus;
  - implementation follows the task tier;
  - a risky task runs on Opus;
  - a retry runs on Opus.
- **Size task:** a full spec with one or two tasks. The light spec stays for setup work.
- **Branches and commits** are the driver's. It commits after each task; the model only edits files.
- **Checks after a task:** its `verify` plus lint.
- **Every task ends green.** The test is written first *inside* the task, seen to fail, then the code
  makes it pass. There are no test-only tasks.
- **One run per repo.** A waiting or interrupted run blocks a new one; `--cancel` frees it.
- **The run fuse has three kinds.**
  - Calls: at most N Claude calls per run. This is the default, and it fits a subscription.
  - Dollars: for API billing. Every call also gets what is left as its `--max-budget-usd`.
  - Off.

  Turns per call, attempts per task and the review-loop stop apply whatever the kind.

## Terms

Shared words are defined in [docs/GLOSSARY.md](../../GLOSSARY.md): stage, spec, plan, task, tier, verify,
driver, mode, size, gate, attempt, fuse. Below is only what this spec makes precise.

- **Step**: one unit of the pipeline that the driver executes. Steps are clarify, spec, plan, base-check,
  implement, checks, review and commit. A gate is a step that waits for the human. A *stage* is the unit of
  work with a spec; never call a step a stage.
- **Run id**: `r-<yyyymmdd>-<hhmmss>`.
- **Run folder**: `.claude/tmp/runs/<run id>/`. It holds:
  - the run file `run.json`;
  - one file per Claude call, `calls/<n>-<role>.json`, with its argv (without the prompt), exit code and raw
    result;
  - `split.md` for an epic.
- **Lock**: `.claude/tmp/runs/lock`. It is created atomically and holds the run id and the driver's pid.
- **Live run**: status `running` and its lock pid is alive. A `running` run whose pid is dead is
  **interrupted**. A `waiting` run has no live process; its pid is ignored.
- **Valid plan**: `tasks.json` with a non-empty `tasks` array where each task has:
  - a unique `id` that is not `Q1` and does not start with `F`;
  - a non-empty `ac` array;
  - a `tier` of S, M or L;
  - a non-empty `verify`;
  - `passes: false`.

  Every criterion id of the merged spec appears in some task.
- **Task diff**: changes since the task's base commit (HEAD when its first attempt started). It counts
  tracked changes plus untracked files, and always excludes `.claude/tmp/`.
- **Diff lines**: added plus deleted lines of the task diff (`git diff --numstat`), plus all lines of each
  untracked file.
- **Clean tree**: `git status --porcelain`, excluding `.claude/tmp/`, is empty.
- **Lint files**: files in the task diff that still exist and match `gates.json → lintMatch`.
- **Lint prefix**: the lint command up to `{file}`.
- **Risk words**:
  - security, auth, authentication, authorization, permission, password, token, secret;
  - payment, money, billing;
  - migration, concurrency, race, lock.

  They match case-insensitively, as whole words.
- **Criterion text**: in the merged spec, the line starting `- **AC-n:**` and its continuation lines, up to
  the next criterion or heading.
- **Driver call**: a Claude process the driver started, with `AGENT_STACK_RUN=<run id>` in its environment.
  Its hooks inherit that variable. A command the model runs cannot set the environment of a hook process.

**Glosses for references kept outside git**
- **D2**: push and merge are always manual.
- **2.W1–2.W7**: open worktree issues.
- **7.11**: browser check as a user.
- **7.12**: lessons between runs.
- **V9**: untrusted browser input.
- **README "Limits"**: known gaps, for example "Bash can write any file".

## Model and state transitions

Run status moves `running` ⇄ `waiting` (at a gate), and ends `finished` | `cancelled`. `next` holds one of:
- `clarify`, `gate:answers`, `spec`, `gate:spec-merge`, `plan`, `gate:plan-approve`, `base-check`;
- `implement:<task>`, `checks:<task>`, `review:<task>`, `commit:<task>`;
- `gate:accept`, `gate:limit`.

**Task mode**

| `next` | Event | New `next` | Criterion |
| --- | --- | --- | --- |
| — | `run task "<d>"` | clarify | AC-5 |
| clarify | valid output | gate:answers | AC-6 |
| gate:answers | size task/story confirmed, stage id valid | spec (driver created `spec/<stage>`) | AC-7, AC-8 |
| gate:answers | size epic confirmed | run finished, `split.md` | AC-9 |
| spec | SPEC.md written in bounds | driver commits → gate:spec-merge (exit 3) | AC-10 |
| gate:spec-merge | `--resume`, spec on base ref | driver creates `<stage>-<slug>` → plan | AC-11 |
| plan | valid plan in bounds | gate:plan-approve | AC-12, AC-13 |
| gate:plan-approve | approve / reject + comment | base-check / plan (plan deleted first) | AC-14 |
| base-check | `test` exits 0 | implement:T1 | AC-15 |
| implement:T*n* | DONE | checks:T*n* | AC-16, AC-19 |
| checks:T*n* | all exit 0 | review:T*n* | AC-20 |
| review:T*n* | not blocking | commit:T*n* | AC-20 |
| commit:T*n* | committed (or empty diff) | implement:T*n+1*, or gate:accept after the last | AC-20, AC-21, AC-46 |
| gate:accept | accept | run finished | AC-22 |
| gate:accept | reject + comment | implement:F*k* → … → commit:F*k* → gate:accept | AC-22 |

**Quick mode**

| `next` | Event | New `next` | Criterion |
| --- | --- | --- | --- |
| — | `run quick "<d>"` | base-check (driver created `quick/<slug>`) | AC-24 |
| base-check | `test` exits 0 | implement:Q1 | AC-24 |
| checks:Q1 | green, diff lines ≤ `quickReviewLines` | commit:Q1 → gate:accept | AC-25 |
| checks:Q1 | green, diff lines > `quickReviewLines` | review:Q1 → commit:Q1 → gate:accept | AC-25 |

**From any step**

| `next` | Event | New `next` | Criterion |
| --- | --- | --- | --- |
| any gate | `c`, or `--cancel` | run cancelled | AC-28 |
| checks / review | red or blocking, attempts left | implement (attempt + 1) | AC-33, AC-34 |
| checks / review | red or blocking, attempts used | gate:limit (attempts) | AC-33, AC-34 |
| review | blocking count not lower than last time | gate:limit (review loop) | AC-39 |
| implement | BLOCKED | gate:limit (blocked) | AC-38 |
| any | fuse reached | gate:limit (fuse) | AC-35 |
| any | infrastructure failure, or schema mismatch twice | unchanged, exit 1 | AC-36, AC-37 |
| spec / plan | output missing or out of bounds twice | unchanged, exit 1 | AC-40, AC-44, AC-45 |
| base-check | `test` exits non-zero | unchanged, exit 1 | AC-41 |
| commit | commit refused | implement (attempt + 1) | AC-42 |
| gate:limit | retry / raise fuse / cancel | `returnTo` (on Opus) / `returnTo` / cancelled | AC-31 |

## Contract

**CLI**

```text
agent-stack run task  [--stage <id>] "<description>"   start a task run
agent-stack run quick "<description>"                  start a quick run
agent-stack run --resume [<run id>]                    continue a waiting or interrupted run (default: the locked one)
agent-stack run --status [<run id>]                    print the run; change nothing
agent-stack run --cancel [<run id>]                    cancel a waiting or interrupted run
```

Exit codes:
- **0**: finished, cancelled, or `--status`.
- **3**: waiting at `gate:spec-merge`, or at any gate when no terminal is attached.
- **1**: a refusal or an error. The message says what to do.

`--stage <id>` fills in the stage id the gate proposes. The id is still validated (AC-7).

**Gate input**

The driver reads gate input from the terminal. When `AGENT_STACK_GATE_INPUT` names a file, it reads the
answers from that file instead, one line per prompt. That variable is the test seam, and nothing else sets it.
When the file runs out, the gate behaves as AC-29: it is recorded, and the driver exits with code 3.

- **answers**:
  - per question: Enter accepts the recommended answer; text replaces it;
  - size: Enter keeps it, or type `task` / `story` / `epic`;
  - stage id: Enter keeps it, or type a new one;
  - `c` cancels.
- **plan-approve** and **accept**: `a` approve, `r` reject (a comment follows), `c` cancel.
- **limit**:
  - reasons attempts, blocked or review loop: `r` retry, `c` cancel;
  - reason decision: `r` retry (a comment follows), `c` cancel (AC-57);
  - reason fuse: `f <n>` sets a new limit for this run, in the fuse's own unit (calls or dollars); it must be
    above what is used so far. `c` cancels.

**`.claude/gates.json` → `run`**

This key is optional. Its defaults are in code, because `update` never rewrites `gates.json`. Timeouts
accept fractions.

```json
{ "run": { "maxTurns": 60, "fuse": { "calls": 40 }, "stepTimeoutMin": 30, "checkTimeoutMin": 15, "quickReviewLines": 120 } }
```

`fuse` takes one of three forms:
- `{ "calls": <n> }`, the default with n = 40;
- `{ "usd": <n> }`;
- `"off"`.

Any other value is refused when a run starts, with code 1.

**Run file (`run.json`)**

| Field | Type |
| --- | --- |
| `id`, `description` | string |
| `mode` | `task` \| `quick` |
| `status` | `running` \| `waiting` \| `finished` \| `cancelled` |
| `next` | one of the values listed above |
| `returnTo` | the `next` value that gate:limit returns to, or null |
| `limitReason` | `attempts` \| `blocked` \| `review-loop` \| `fuse` \| null |
| `proposal` | clarify output (questions, size, stage, split), or null |
| `stage`, `size` | the confirmed values, or null |
| `stagePrefill` | the `--stage` id that gate:answers proposes, or null |
| `branch` | the branch the run expects to be on |
| `baseCommit` | sha, set when the run's work branch is created |
| `tasks` | `{ id, taskBase, attempts, blockingCount, lastFeedback, checks: {cmd, exit, skipped}[], notes: string[], commit: sha \| "empty" \| null }[]` |
| `createdBranches` | `string[]`, the branches this run created |
| `gates` | `{ gate, at, decision, comment }[]` |
| `answers` | `{ question, answer }[]` |
| `humanDecisions` | `string[]`, shown at the next gate |
| `costUsd` | number, the sum of `total_cost_usd`; always recorded, whatever the fuse |
| `calls` | number of Claude calls made |
| `fuse` | `{ calls: n }` \| `{ usd: n }` \| `"off"`, copied from config at start; raised at gate:limit |

**How Claude Code is invoked**

The binary is `$AGENT_STACK_CLAUDE` when it is set (the fake in tests), otherwise `claude`. Every call:
- gets `-p --output-format json --max-turns <maxTurns> --model <model> --json-schema <role schema>`, plus
  `--max-budget-usd <dollars left>` only with a dollar fuse;
- gets the role prompt on stdin;
- gets `AGENT_STACK_RUN` in its environment;
- loads only the project (AC-58):
  - `--strict-mcp-config --mcp-config <the project's .mcp.json, or {"mcpServers":{}}>`;
  - `--setting-sources project,local`, so no user plugins, permissions or hooks;
  - `--settings '{"claudeMdExcludes":["<home>/.claude/CLAUDE.md"]}'`;
  - env `ENABLE_CLAUDEAI_MCP_SERVERS=false`, `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1` and
    `CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS=1`;
- never gets `--bare`, `bypassPermissions`, `--dangerously-skip-permissions` or `disableAllHooks`.


| Role | Model | `--tools` | `--permission-mode` | `--allowedTools` |
| --- | --- | --- | --- | --- |
| clarify | opus | Read,Glob,Grep | default | — |
| spec | opus | Read,Glob,Grep,Write,Edit,Agent | acceptEdits | — |
| plan | opus | Read,Glob,Grep | default | — |
| implement | AC-16 | Read,Glob,Grep,Edit,Write,Bash | acceptEdits | `Bash(<test command>:*)`, `Bash(<lint prefix>:*)`, `Bash(git status:*)`, `Bash(git diff:*)`, `Bash(git log:*)`, `Bash(git show:*)`, and `Bash(<this task's verify command, verbatim>)` (human-approved at gate:plan-approve; never `.claude/bin/verify`, which writes `passes`); an entry whose command is empty is left out |
| review | opus | Read,Glob,Grep | default | — |

**Role prompts** (AC-4) start with what the driver has already done, and what the role must not do.

- **clarify**:
  - ask at most 5 questions, each with a recommended answer;
  - size the work;
  - propose a stage id; for an epic, a split.
- **spec**:
  - the full text of the `/spec` skill, with `$ARGUMENTS` = `<stage> <title>` and `${CLAUDE_SKILL_DIR}`
    filled in;
  - the description, and the answers marked "these are the grill";
  - "write a full spec; the branch exists; do not commit, branch or push".
- **plan**:
  - the full text of the `/plan` skill, filled in;
  - "the spec is merged and the branch exists — skip the precondition and step 1; do not run verify,
    commit or implement";
  - "do not write `tasks.json`: return the tasks in your output; the program writes the file";
  - "**every task ends green**: its test is written first inside the task and its verify passes when the
    task is done; no test-only tasks".
- **implement**:
  - the task;
  - the text of its criteria;
  - the last feedback, labelled "FROM THE PROGRAM";
  - "write the failing test first, see it fail, then the code; touch only this task; do not commit,
    branch or edit `tasks.json`".
- **review**:
  - the task and its criteria;
  - the task diff;
  - the implementer's report, labelled "UNVERIFIED CLAIMS FROM THE IMPLEMENTER";
  - "return two verdicts and whether the task's verify proves its criteria".

**Role outputs** come from the result's `structured_output`. Only the required fields are listed.

- **clarify**:
  - `questions`: `{text, recommended}[]`, at most 5;
  - `size`: `task` \| `story` \| `epic`;
  - `stage`: `{id, title}`;
  - `split`: `{id, goal}[]` when the size is epic.
- **spec**: `{ specPath, summary, needsHumanDecision: string[] }`.
- **plan**: `{ summary, tasks, needsHumanDecision: string[] }`. `tasks` holds the fields of a "Valid plan"
  task: `{id, ac, tier, desc, verify, passes: false}[]`. The driver, not the role, writes it to `tasks.json`.
- **implement**:
  - `status`: `DONE` \| `BLOCKED`;
  - `report`;
  - `commit`: `{type: feat|fix|refactor|test|docs|chore|perf, subject}`;
  - `needsHumanDecision`: `string[]`.
- **review**:
  - `spec`: `pass` \| `fail` \| `unclear`;
  - `quality`: `pass` \| `fail`;
  - `verifyProves`: boolean;
  - `findings`: `{severity: critical|warning|suggestion, text, file?, line?}[]`.

**Blocking review.** A review blocks when any of `spec: fail`, `quality: fail`, `verifyProves: false`, or a
`critical` finding holds.
- Its **blocking count** is the number of critical findings, plus 1 for each of those three flags that is set.
- `unclear`, warnings and suggestions go to the gate as notes.

**Result fields the driver reads:**
- `is_error`;
- `subtype`, one of `success`, `error_max_turns`, `error_max_budget_usd`, `error_during_execution`,
  `error_max_structured_output_retries` (check the list against the CLI version in use);
- `num_turns`;
- `total_cost_usd`;
- `permission_denials`;
- `structured_output`.

**Commits** (always the driver's):
- spec: `docs(<stage>): spec — <title>`;
- task: `<type>(<stage>): <subject>`;
- quick: `<type>: <subject>`.

The driver stages exactly the paths of the task diff, or the spec's allowed paths. It never stages
`.claude/tmp/`.

Before committing, the driver normalises the header so that `@commitlint/config-conventional` accepts it:
- the scope is lowercased (`A0` → `a0`);
- the first letter of the subject is lowercased;
- a trailing period is removed;
- the header is cut to 100 characters.

## Acceptance criteria (EARS)

### Engine and invocation

- **AC-1:** WHEN a run starts, THE SYSTEM SHALL write the run folder and the run file first, and then create
  the lock atomically. If the lock already exists, it SHALL remove its own folder and refuse (AC-50).
  - The lock SHALL be removed when the run finishes or is cancelled.
  - It SHALL then execute the steps in the order of the transition tables, taking each next step from
  the run file and never from the model's output (ADR-0001).
- **AC-2:** THE SYSTEM SHALL start every Claude call as "How Claude Code is invoked" specifies. It SHALL
  never pass `--bare`, a bypass permission mode or `disableAllHooks` (ADR-0001).
- **AC-58:** THE SYSTEM SHALL start every Claude call with only the project's MCP servers, settings and
  CLAUDE.md, and with auto-memory, the git status snapshot and the claude.ai account connectors off, as
  "How Claude Code is invoked" lists.
- **AC-3:** THE SYSTEM SHALL write the run file atomically (temp file, then rename) after every step and gate
  decision. It SHALL keep every call's argv (without the prompt), exit code and raw result under `calls/`.
- **AC-4:** THE SYSTEM SHALL build each role's prompt as "Role prompts" specifies. For spec and plan, it
  SHALL read the deployed skill file (`.claude/skills/<name>/SKILL.md`) and embed it, rather than ask the
  model to invoke the skill.

### Task mode

- **AC-5:** WHEN `run task` starts on a clean tree, THE SYSTEM SHALL run clarify with the description.
- **AC-6:** WHEN clarify returns valid output, THE SYSTEM SHALL store it as `proposal` and stop at
  gate:answers with the input defined in the Contract.
- **AC-7:** WHEN a stage id is confirmed, THE SYSTEM SHALL accept it only if all three hold:
  - the default stage pattern maps `<id>-x` back to `<id>`;
  - `<specsDir>/<id>/` does not exist on the base ref;
  - no branch `spec/<id>` exists.
- **AC-8:** WHEN size task or story is confirmed, THE SYSTEM SHALL:
  - create `spec/<stage>` from the base ref;
  - run the spec role;
  - check that `<specsDir>/<stage>/SPEC.md` exists and that only `<specsDir>/<stage>/` and `<adrDir>/`
    changed;
  - commit those paths as `docs(<stage>): spec — <title>`.
- **AC-9:** WHEN size epic is confirmed, THE SYSTEM SHALL write `split.md` from `proposal.split` and print
  `agent-stack run task --stage <id> "<goal>"` for each part. It SHALL finish the run without writing code.
- **AC-10:** WHEN the spec is committed, THE SYSTEM SHALL stop at gate:spec-merge, print the branch to push
  and merge, and exit with code 3.
- **AC-11:** WHEN `--resume` runs at gate:spec-merge and the spec exists on the base ref (the check spec-gate
  makes), THE SYSTEM SHALL:
  - check out a new branch `<stage>-<slug>` from the base ref (the slug comes from the title, as in AC-24);
  - set `branch` and `baseCommit`;
  - run the plan role.
- **AC-12:** WHEN the plan role ends, THE SYSTEM SHALL check three things:
  - the output's `tasks` form a valid plan;
  - the branch is unchanged and no commit was made;
  - nothing in the tree changed (the role has no write tool).

  It SHALL then write the tasks to `.claude/tmp/<stage>/tasks.json` itself.

  It SHALL then stop at gate:plan-approve and show each task: id, criteria, tier, the model it will run on,
  and verify.
- **AC-13:** WHEN a task's tier is S or M and its description or one of its criterion texts contains a risk
  word, THE SYSTEM SHALL mark it "risky" at the gate and run it on Opus.
- **AC-14:** WHEN the human approves the plan, THE SYSTEM SHALL go to base-check. WHEN the human rejects it,
  THE SYSTEM SHALL delete the stage's `tasks.json` and `verify.log` and re-run plan with the comment.
- **AC-15:** WHEN base-check runs, THE SYSTEM SHALL run the `test` command on the clean tree and go on to
  the first task only if it exits 0.
- **AC-16:** WHEN implement starts for a task, THE SYSTEM SHALL record `taskBase` if this is its first
  attempt, and run a fresh session.
  - The model SHALL be Opus for tier L, for a risky task, for a fix task, and for every attempt after the
    first. Otherwise it SHALL be Sonnet.
- **AC-17:** WHEN the plan role runs, THE SYSTEM SHALL require in its prompt that every task end green.
  - The `/plan` skill SHALL say the same: tests first inside a task, and no test-only tasks.
  - Its "after two failed verify runs move one tier up" SHALL read "under the driver, a retry runs on Opus".
- **AC-18:** WHILE `AGENT_STACK_RUN` names a live run whose `branch` is the current branch, evidence-gate
  SHALL not block. The driver decides the result.
- **AC-19:** WHEN implement returns DONE, THE SYSTEM SHALL itself run `.claude/bin/verify <task>`, and the
  lint command on each lint file (`{file}` replaced), or once if the command has no `{file}`.
  - It SHALL decide by exit code only.
  - Each command gets `checkTimeoutMin`.
  - An empty command is skipped (AC-56).
  - The results SHALL be stored in the task's `checks`.
- **AC-20:** WHEN checks pass, THE SYSTEM SHALL run the review role on the task diff. WHEN the review does
  not block, THE SYSTEM SHALL commit the task diff as `<type>(<stage>): <subject>`, normalised as in
  "Commits", record the sha, and go on to the next task.
  - A run with stage `A0` SHALL produce a header that commitlint accepts.
  - The review's notes SHALL be stored in the task's `notes`.
- **AC-21:** WHEN the last task is committed, THE SYSTEM SHALL stop at gate:accept and show:
  - the diff stat from `baseCommit`;
  - each task's checks;
  - the review notes;
  - the skipped commands;
  - the human decisions;
  - the cost.
- **AC-22:** WHEN the human accepts, THE SYSTEM SHALL finish the run and SHALL NOT push or merge (D2).
  WHEN the human rejects with a comment, THE SYSTEM SHALL implement a fix task F*k* with the comment as
  feedback.
  - F*k*'s checks are every task's verify plus lint.
  - It SHALL then review and commit F*k*, and return to gate:accept.
- **AC-23:** WHEN `--status` runs, THE SYSTEM SHALL print:
  - the id, mode, status and `next`;
  - the branch;
  - the attempts per task;
  - the calls made, the cost, and the fuse.

  It SHALL change nothing and exit 0.

### Quick mode

- **AC-24:** WHEN `run quick` starts on a clean tree with a branch checked out, THE SYSTEM SHALL create
  `quick/<slug>` from HEAD, run base-check, then implement the description as task Q1.
  - The slug is lowercase `[a-z0-9-]`, at most 40 characters, taken from the description.
- **AC-25:** WHEN Q1's checks pass, THE SYSTEM SHALL review only if the diff lines exceed
  `quickReviewLines`. It SHALL then commit as `<type>: <subject>` and stop at gate:accept.
  - Q1's checks, and those of a quick fix task, are the `test` command plus lint.
  - A quick fix task follows the same review rule, and has 2 attempts.
- **AC-26:** WHILE `AGENT_STACK_RUN` names a live quick run whose `branch` is the current branch, spec-gate
  SHALL allow code edits without a stage spec or `tasks.json`.
  - This check SHALL come before the stage checks.
  - Without that variable there SHALL be no bypass.
- **AC-27:** THE SYSTEM SHALL make guard-file block Edit and Write to `.claude/tmp/runs/**`.

### Gates and resume

- **AC-28:** WHEN the human cancels at a gate, or runs `--cancel` on a waiting or interrupted run, THE SYSTEM
  SHALL mark the run cancelled and remove the lock. It SHALL keep the branches and commits, and print them.
- **AC-29:** WHILE stdin is not a terminal and `AGENT_STACK_GATE_INPUT` is not set, THE SYSTEM SHALL record
  every gate, print the `--resume` command and exit with code 3.
- **AC-30:** WHEN `--resume` runs on an interrupted run, THE SYSTEM SHALL take the lock, write its own pid,
  and re-run the interrupted step without counting a new attempt.
  - An interrupted implement SHALL get the feedback "continue from `git status`".
- **AC-31:** WHEN gate:limit is answered with retry, raise or cancel, THE SYSTEM SHALL act as follows:
  - retry and raise return to `returnTo`; a retry runs on Opus;
  - cancel cancels the run.
- **AC-32:** WHEN `humanDecisions` is not empty, THE SYSTEM SHALL show it at the next gate, then clear it.
  - The list collects `needsHumanDecision` and the `permission_denials` of every call whose result the
    driver keeps. A call that is undone or re-run adds nothing.
  - A denial is one line: `permission denied: <tool> <file_path or command>`, cut to 120 characters.

### Unhappy path

- **AC-33:** IF any check exits non-zero or times out, THEN THE SYSTEM SHALL record feedback and return to
  implement as a new attempt (partner of AC-19).
  - The feedback is the command, its exit code and the last 50 lines of its output; for verify, those lines
    come from `verify.log`.
  - A task that has used its attempts SHALL go to gate:limit, reason "attempts". Task mode and its fix tasks
    have 3 attempts; quick mode and its fix tasks have 2.
- **AC-34:** IF the review blocks, THEN THE SYSTEM SHALL return to implement with the blocking items as
  feedback, as a new attempt or gate:limit (partner of AC-20).
- **AC-35:** IF the fuse is reached, THEN THE SYSTEM SHALL go to gate:limit, reason "fuse", before any
  further call (partner of AC-2). The fuse is reached when:
  - with `calls`, `calls` equals the limit;
  - with `usd`, `costUsd` reaches the limit, or a call ends with `error_max_budget_usd`.

  With `"off"` there is no fuse step.
  - The interrupted step counts no attempt, and its edits stay for the step after the fuse is raised.
- **AC-36:** IF a call ends with no result JSON (and the driver did not kill it), or with `is_error` and
  `num_turns` 0, THEN THE SYSTEM SHALL
  keep `next`, count no attempt, print the error and exit with code 1. `--resume` retries the step (partner
  of AC-16).
- **AC-37:** IF a role's `structured_output` does not match its schema, or the call ends with
  `error_max_structured_output_retries`, THEN THE SYSTEM SHALL re-run the call once. On a second mismatch it SHALL keep `next` and exit with code 1 (partner of AC-6, AC-20).
- **AC-38:** IF implement returns BLOCKED, THEN THE SYSTEM SHALL go to gate:limit, reason "blocked", with
  the report (partner of AC-16).
  - IF a call ends with `error_max_turns`, or with `error_during_execution` after more than 0 turns, or is
    killed after `stepTimeoutMin`, THEN THE SYSTEM SHALL count a failed attempt with that reason as
    feedback. It SHALL keep the edits for the next attempt.
  - The same endings in clarify, spec, plan or review SHALL re-run that role once with the reason as
    feedback, then exit with code 1. Those roles have no attempts.
- **AC-39:** IF a task's blocking count is not lower than at its previous review, THEN THE SYSTEM SHALL go to
  gate:limit, reason "review loop" (partner of AC-34).
- **AC-40:** IF the spec or plan role changes paths outside its bounds (AC-8, AC-12), changes the branch, or
  commits, THEN THE SYSTEM SHALL undo it and re-run the role once with that feedback. On a second violation
  it SHALL exit with code 1 (partner of AC-8, AC-12).
  - Undoing means: reset to the commit before the role, and restore or remove the out-of-bounds paths.
- **AC-41:** IF base-check's `test` exits non-zero, THEN THE SYSTEM SHALL exit with code 1 and name the
  command, keeping `next` at base-check. The human fixes the base and resumes (partner of AC-15, AC-24).
- **AC-42:** IF a task commit is refused by a git hook, THEN THE SYSTEM SHALL return to implement with the
  hook's output as feedback, as a new attempt. IF the spec commit is refused, THEN THE SYSTEM SHALL exit
  with code 1 and show the hook's output (partner of AC-8, AC-20).
- **AC-43:** IF implement commits or changes the branch, THEN THE SYSTEM SHALL count a failed attempt.
  - It SHALL soft-reset to `taskBase`, keeping the edits, or return to `branch`, and give that as feedback.
  - It SHALL exit with code 1 if the branch cannot be restored without losing edits (partner of AC-16).
- **AC-44:** IF the spec role ends without `<specsDir>/<stage>/SPEC.md`, THEN THE SYSTEM SHALL re-run it once
  with that feedback, then exit with code 1 (partner of AC-8).
- **AC-45:** IF the plan role's `tasks` are not a valid plan, THEN THE SYSTEM SHALL re-run it once with the
  error, then exit with code 1 (partner of AC-12).
- **AC-57:** IF the spec role ends without its SPEC.md, or the plan role without a valid plan, and its
  `needsHumanDecision` is not empty, THEN THE SYSTEM SHALL not re-run it. It SHALL go to gate:limit, reason
  "decision", and show the items (partner of AC-12, AC-44).
  - `r` retries the role with the comment that follows, labelled "FROM THE HUMAN"; `c` cancels.
  - The attempts and the fuse are unchanged.
- **AC-46:** IF a task's checks pass with an empty task diff, THEN THE SYSTEM SHALL record `commit: "empty"`,
  make no commit, and show it at gate:accept (partner of AC-20).
- **AC-47:** IF `--resume` finds the spec missing on the base ref, THEN THE SYSTEM SHALL stay at
  gate:spec-merge, say what is missing (push, merge, `git fetch`) and exit with code 3 (partner of AC-11).
- **AC-48:** IF a stage id fails AC-7, THEN THE SYSTEM SHALL say why and ask again at the same gate (partner
  of AC-7).

### Edge cases

- **AC-49:** IF the tree is not clean at one of these points, THEN THE SYSTEM SHALL refuse with code 1 and
  list the changes:
  - when a run starts;
  - right before the driver creates `spec/<stage>`, `<stage>-<slug>` or `quick/<slug>`;
  - when a run resumes at gate:spec-merge, gate:plan-approve or base-check.

  When a run resumes at spec or plan, the tree SHALL be clean outside that role's bounds. At implement,
  checks, review, commit or gate:limit, changes outside `.claude/tmp/` are part of the current task's diff.
  The driver never removes changes it did not see a role make.
- **AC-50:** IF a lock exists, THEN THE SYSTEM SHALL refuse a new run with code 1, and name the locked run and
  its `--resume`, `--status` and `--cancel` commands. This applies whether the locked run is live, waiting
  or interrupted.
  - A `--resume` while the run is live SHALL be refused.
  - A `--cancel` of a live run SHALL be refused with "stop it first (Ctrl-C)".
- **AC-51:** WHEN the driver gets SIGINT or SIGTERM, THE SYSTEM SHALL stop the Claude child, write the run
  file, and exit with code 1. The run stays resumable as interrupted.
- **AC-52:** IF `--resume` finds that the current branch is not the run's `branch` (except at
  gate:spec-merge), THEN THE SYSTEM SHALL refuse with code 1 and name the branch.
- **AC-53:** IF a named run does not exist, there is no run, or the run is finished or cancelled, THEN THE
  SYSTEM SHALL say so. `--resume` and `--cancel` SHALL exit with code 1; `--status` SHALL print the run and
  exit 0.
- **AC-54:** IF any of the following holds, THEN THE SYSTEM SHALL refuse with code 1 and say what to change:
  - the mode is unknown;
  - the description is empty;
  - HEAD is detached;
  - `quick/<slug>` or `<stage>-<slug>` already exists and this run did not create it;
  - `gates.json` sets a non-default `stagePattern` for a task run.

- **AC-55:** WHEN `--resume` repeats a step that a kill interrupted after its git side effect, THE SYSTEM
  SHALL finish that step without repeating the side effect:
  - a branch in `createdBranches` that already exists SHALL be checked out, not created again;
  - in commit:T*n*, a HEAD whose header matches the expected one SHALL be recorded as the task's commit;
  - `--cancel` SHALL remove a lock whose run folder is missing.
- **AC-56:** WHEN a test or lint command is empty, THE SYSTEM SHALL skip it in base-check and in checks, and
  show the skip at the next gate.

## Non-functional requirements

- **Engine speed:** with the fake `claude` and `AGENT_STACK_GATE_INPUT`, the whole task path (AC-5 to AC-22)
  finishes in under 10 s on the CI runner (GitHub `ubuntu-latest`). The driver makes no model calls of its
  own.
- **Turns:** each call is capped at `maxTurns` (default 60).
- **Fuse:** by default 40 Claude calls per run. A dollar fuse counts by `total_cost_usd`, and each call gets
  what is left. `"off"` leaves only the per-call turns and the per-task attempts.
- **Crash safety:** a kill at any point leaves a run that `--resume` continues (AC-3, AC-30, AC-51).
- **No new runtime dependencies:** only Node's standard library and the existing `execa` wrapper
  (`src/utils/shell.ts`). The wrapper is extended with stdin, a timeout and kill.

## Out of scope

- **Later modes:** bug and refactor (part 2), and "auto" mode selection.
- **Baseline compare and flaky-test probing** (part 4). Until then a red `test` at the base stops the run
  (AC-41). Base-check does not run lint: lint covers only the files a task touches.
- **The full review of part 5:** the diff as a file, re-review of the fix diff only, minor findings to a
  log, and a 5-round limit.
- **"Accept as is"** at gate:limit.
- **A custom `stagePattern` in task mode** (AC-54).
- **The account email in the session context.** Claude Code adds it for a subscription login, and no
  switch removes it short of `--bare`, which needs an API key and skips hooks (AC-2). README "Limits" says so.
- **Worktree per run and parallel runs.** They wait for 2.W1–2.W7.
- **The browser check** (7.11, with V9) **and lessons after a run** (7.12).
- **Push, PR, merge and `git fetch`:** these are the human's (D2).
- **Bash forging the run file:** this is the known guard-file gap (README "Limits"). Both bypasses (AC-18,
  AC-26) also need `AGENT_STACK_RUN` and a live run on the current branch.
  - Caveat: while a run is live, a nested `AGENT_STACK_RUN=<id> claude -p …` started from Bash gets the
    bypass in that nested process. This is within the known Bash gap.

## How to verify

```bash
pnpm vitest run -t "v04 AC-"     # engine + e2e with the fake claude; hook tests for AC-18, AC-26, AC-27 carry the same prefix
pnpm typecheck
```

Manual check, once, with the real `claude` on a scratch repo:

1. `agent-stack run quick "add a README line"`. At gate:accept, accept. Expect one commit, no push, and a
   `calls/` file per call with its argv.
2. `agent-stack run task "<a small feature>"` up to gate:plan-approve. Expect:
   - the spec committed on `spec/<stage>`;
   - after a local merge and `--resume`, a plan in which every task ends green;
   - the embedded skills followed: a spec-reviewer pass, EARS criteria.

## Changes

- 2026-11-19 — from the manual check with the real `claude`:
  - **AC-12, AC-45, role table, role outputs:** the plan role returns its tasks and the driver writes
    `tasks.json`. Claude Code guards `.claude/` even under acceptEdits, so a headless plan could not write it.
  - **AC-57 (new):** a spec or plan role that asks for a decision stops at gate:limit instead of a blind re-run.
  - **AC-32:** a denial is one short line, and calls that are undone or re-run add nothing.
  - **AC-58 (new), "How Claude Code is invoked":** each call loads only the project. The account's
    connectors cost about 150k tokens a turn, and the user's own instructions, memory and plugins do not
    belong in a project's run.

First version.
