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
- **The driver from a chat (Leonid, 20/11/26).** A chat runs the driver and passes the human's answers; it
  does no step's work. `codeBy: "driver"` is opt-in and holds even with `specGate: "off"`. The chat may turn a
  clear worded reply into a gate key and says which key it sent; when the reply is unclear, it asks. It never
  runs `agent-stack update` itself: that changes its own guards. A run with no human (autonomous) from a chat
  waits for the sandbox of 0.5. The chat speaks English unless `language.chat` or the human says otherwise.

## Terms

Shared words are defined in [docs/GLOSSARY.md](../../GLOSSARY.md): stage, spec, plan, task, tier, verify,
driver, mode, size, gate, attempt, fuse, live run, driver call, test conflict. Below is only what this spec makes precise; a
word for this spec only is marked `(local)`.

- **Step**: one unit of the pipeline that the driver executes. Steps are clarify, spec, plan, base-check,
  implement, checks, review and commit. A gate is a step that waits for the human. A *stage* is the unit of
  work with a spec; never call a step a stage.
- **Run id** (local): `r-<yyyymmdd>-<hhmmss>`.
- **Run folder** (local): `.claude/tmp/runs/<run id>/`. It holds:
  - the run file `run.json`;
  - one file per Claude call, `calls/<n>-<role>.json`, with its argv (without the prompt), exit code and raw
    result;
  - `split.md` for an epic.
- **Lock** (local): `.claude/tmp/runs/lock`. It is created atomically and holds the run id and the driver's pid.
- **Live run**: status `running` and its lock pid is alive. A `running` run whose pid is dead is
  **interrupted**. A `waiting` run has no live process; its pid is ignored.
- **Valid plan** (local): `tasks.json` with a non-empty `tasks` array where each task has:
  - a unique `id` that is not `Q1` and does not start with `F`;
  - a non-empty `ac` array;
  - a `tier` of S, M or L;
  - a non-empty `verify` that can fail (AC-65);
  - `passes: false`.

  Every criterion id of the merged spec appears in some task.
- **Task diff** (local): changes since the task's base commit (HEAD when its first attempt started). It counts
  tracked changes plus untracked files, and always excludes `.claude/tmp/`.
- **Frozen tests** (local): the files matching `gates.json → testGlobs` that exist at the task's base commit. In
  each one the driver counts, over the whole text:
  - tests: `it(`, `test(` (also with a modifier: `it.skip(`, `test.each(`), `def test_`, `func Test`, `#[test]`;
  - assertions: `expect(`, `assert` (also `assert.x(`, `assert_eq!(`, `assert!(`, `debug_assert!(`,
    `assertEqual(`, `assertThat(`), `t.Error(`, `t.Fatal(` and their `f` forms;
  - skip marks: the forms in the one list `SKIP_MARKS` (`src/run/engine/skip-marks.ts`), which cheat-guard's seed
    patterns are built from too — `.skip`, `.only`, `.todo`, `.skipIf` after a test call; `xit(`, `fit(` and the
    like; `this.skip()`; pytest, unittest, Go and Rust marks. So `iter().skip(1)` or `this.skip(2)` is not one.

  A file that is no longer a regular file (a folder, a submodule) is "replaced"; a file with a NUL byte is not
  counted.

  Tests the task adds after its base are not frozen.
- **Check config** (local): a file that decides how checks run: `.github/workflows/*`, `.gitlab-ci.yml`,
  `vitest.config.*`, `vitest.workspace.*`, `jest.config.*`, `playwright.config.*`, `eslint.config.*`, `.eslintrc*`,
  `biome.json`, `biome.jsonc`, `pytest.ini`, `tox.ini`, `ruff.toml`, `.ruff.toml`, `.golangci.*`, `clippy.toml`,
  `pnpm-workspace.yaml`.
- **Package manifest** (local): a `package.json` at any depth. The driver compares three parts of it with the
  task's base: `scripts`, since a check command like `pnpm test` runs the script of that name; the dependency
  entries — `dependencies`, `devDependencies`, `optionalDependencies`, `peerDependencies`, `overrides`,
  `resolutions` and `pnpm.overrides`; and the check settings it holds — `jest`, `eslintConfig`, `mocha`, `ava`.
  A manifest the task adds compares with an empty one.
- **Diff lines** (local): added plus deleted lines of the task diff (`git diff --numstat`), plus all lines of each
  untracked file.
- **Clean tree** (local): `git status --porcelain`, excluding `.claude/tmp/`, is empty.
- **Lint files** (local): files in the task diff that still exist and match `gates.json → lintMatch`.
- **Lint prefix** (local): the lint command up to `{file}`.
- **Risk words** (local):
  - security, auth, authentication, authorization, permission, password, token, secret;
  - payment, money, billing;
  - migration, concurrency, race, lock.

  They match case-insensitively, as whole words.
- **Criterion text** (local): in the merged spec, the line starting `- **AC-n:**` and its continuation lines, up to
  the next criterion or heading. `.claude/bin/trace` counts a criterion only in this form too, so the driver and
  `trace` see the same criteria.
- **Driver call**: a Claude process the driver started, with `AGENT_STACK_RUN=<run id>` in its environment.
  Its hooks inherit that variable. A command the model runs cannot set the environment of a hook process.
- **Gate card**: what a gate shows, built once as data when the run reaches the gate and kept in the run file
  (`card`). The terminal prints it for a person (AC-68); `--status --json` gives the same card to a program
  (AC-69). Fields are in the Contract ("Gate card").
- **Operator chat**: a Claude Code chat that runs the driver for the human with `--answer` and `--status --json`,
  and does no step's work itself (AC-70, AC-71, AC-75).
- **Command name** (local): how a hint names the driver: `agent-stack` when an `agent-stack` is found on `PATH`
  and either is the same file as the running `cli.mjs` (symlinks followed) or prints the same version for
  `agent-stack --version` (a pnpm global install is a shell shim, not a symlink); otherwise `node "<the running
  cli.mjs path>"`. It is found once per process. A hint adds the subcommand: `<command name> run --resume <id>`,
  `<command name> update`.
- **Hint** (local): a line the driver prints with a command for the human to run.
- **Harness floor** (local): the lowest harness version this driver needs, a constant in the driver: **0.4.1**
  (the agent sections the driver reads, AC-67). It rises only when the driver needs a harness file or section
  that an older harness lacks. Versions compare as numbers, part by part: 0.10.0 is above 0.4.2.

## References

Glosses for references kept outside git.

- **D2**: push and merge are always manual.
- **2.W1–2.W7**: open worktree issues.
- **7.11**: browser check as a user.
- **7.12**: lessons between runs.
- **V9**: untrusted browser input.
- **README "Limits"**: known gaps, for example "Bash can write any file".
- **The sandbox of 0.5**: the planned OS sandbox for commands (release 0.5, security and isolation).

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
| spec | SPEC.md written in bounds, terms checked | driver commits → gate:spec-merge (exit 3) | AC-10, AC-59 |
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
| implement | TEST_CONFLICT | gate:limit (test conflict) | AC-64 |
| checks | frozen tests weakened, a check config or a package manifest changed | gate:limit (tests changed) | AC-66 |
| gate:limit (tests changed) | allow / retry with a comment | checks / implement (attempt + 1) | AC-66 |
| any | fuse reached | gate:limit (fuse) | AC-35 |
| any | infrastructure failure, or schema mismatch twice | unchanged, exit 1 | AC-36, AC-37 |
| spec / plan | output missing, out of bounds or (spec) terms failing twice | unchanged, exit 1 | AC-40, AC-44, AC-45, AC-59 |
| spec / plan | output missing and `needsHumanDecision` not empty | gate:limit (decision) | AC-57 |
| base-check | `test` exits non-zero | unchanged, exit 1 | AC-41 |
| commit | commit refused | implement (attempt + 1) | AC-42 |
| gate:limit | retry / raise fuse / cancel | `returnTo` (on Opus) / `returnTo` / cancelled | AC-31 |
| gate:limit (decision, test conflict) | retry with a comment | `returnTo`, no attempt, same model | AC-57, AC-64 |

## Contract

**CLI**

```text
agent-stack run task  [--stage <id>] "<description>"   start a task run
agent-stack run quick "<description>"                  start a quick run
agent-stack run --resume [<run id>] [--answer <text>]… continue a waiting or interrupted run (default: the locked one)
agent-stack run --status [<run id>] [--json]           print the run; change nothing
agent-stack run --cancel [<run id>]                    cancel a waiting or interrupted run
agent-stack run --watch [<run id>]                     show the run live until it ends; change nothing
```

`--answer` may repeat; each one is one line of gate input for the gate the run waits at, and only that gate
(AC-70). `--answer ""` is Enter. A key and what follows it go in one `--answer`, as at the terminal:

```text
--resume <id> --answer "" --answer "" --answer "no, split on spaces only" --answer "" --answer "" --answer "" --answer ""
                                     gate:answers: 5 questions, size, stage id (Enter keeps)
--resume <id> --answer a             gate:plan-approve or gate:accept: approve
--resume <id> --answer "r split T2 in two"    reject with a comment
--resume <id> --answer "f 60"        gate:limit, reason fuse: raise to 60
```

`--json` prints the run and its gate card as one JSON object (AC-69).

Exit codes:
- **0**: finished, cancelled, or `--status`.
- **3**: waiting at `gate:spec-merge`, or at any gate when no terminal is read (none is attached, or
  `--answer` was given).
- **1**: a refusal or an error, also an `--answer` the gate does not take (AC-70). The message says what to do.

`--stage <id>` fills in the stage id the gate proposes. The id is still validated (AC-7).

**Gate input**

The driver reads gate input from the terminal. When `--answer` is given, it reads those instead, in order, one
per prompt, and never the terminal; `--answer` wins over `AGENT_STACK_GATE_INPUT` (AC-70). When
`AGENT_STACK_GATE_INPUT` names a file, it reads the answers from that file, one line per prompt. That variable
is the test seam, and nothing else sets it. When the file runs out, the gate behaves as AC-29: it is recorded,
and the driver exits with code 3.

- **answers**:
  - per question: Enter accepts the recommended answer; text replaces it. Each question's prompt says so:
    `answer <n> (Enter = recommended, or type your own)>`;
  - size: Enter keeps it, or type `task` / `story` / `epic`;
  - stage id: Enter keeps it, or type a new one. A proposal that fails AC-7 is not offered: the prompt says
    why and offers a free id instead (AC-48);
  - `c` cancels.
- **plan-approve** and **accept**: `a` approve, `r` reject (a comment follows), `c` cancel.
- **limit**:
  - reasons attempts, blocked or review loop: `r` retry, `c` cancel;
  - reason decision: `r` retry (a comment follows), `c` cancel (AC-57);
  - reason test conflict: `r` retry (the answer for the implementer follows; its prompt says so:
    `answer for the implementer>`), `c` cancel (AC-64);
  - reason tests changed: `a` allow, `r` retry (a comment follows), `c` cancel (AC-66);
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

**`.claude/gates.json` → `codeBy`**

Optional, top level, read by spec-gate (AC-71): `"anyone"` (the default when the key is missing) or
`"driver"`. A seed key is not added by `update`, so a repo turns it on by hand.

**`.claude/gates.json` → `language`**

Optional, top level (AC-76): `{ "chat": "<code>", "terms": "<code>" }`, each a language code matching
`^[a-z]{2,3}(-[A-Za-z]{2}|-[0-9]{3})?$` (`en`, `ru`, `pt-BR`); both default to `en`. `chat` is the language the
operator chat speaks to the human. `terms` names the language the project's terms are written in: gate keys,
commands, ids and glossary words. The chat shows terms as they are and never translates them. The driver's own
terminal text stays English.

**Gate card** (in the run file as `card`, and in `--status --json`)

```json
{
  "gate": "plan-approve",
  "run": "r-20261119-232844",
  "stage": "A4",
  "title": "Plan A4: 2 tasks",
  "facts": ["T1  S · sonnet · AC-1,3,5,6,7   Write tests/count.test.js first, then src/count.js", "      verify: …",
            "full task text: .claude/tmp/A4/tasks.json"],
  "source": "sha256 of tasks.json when the card was built",
  "prompts": [
    { "text": "approve the plan", "default": null,
      "answers": [ { "key": "a", "follows": null, "label": "approve" },
                   { "key": "r", "follows": "text", "label": "reject" },
                   { "key": "c", "follows": null, "label": "cancel" } ] }
  ],
  "hint": "agent-stack run --resume r-20261119-232844"
}
```

- `gate`: `answers` | `spec-merge` | `plan-approve` | `limit` | `accept`; `stage`: string or null.
- `facts`: strings, in the order AC-68 prints them, never cut: the terminal print cuts, the data does not.
- `keep`: the indexes of the facts the terminal never cuts (AC-68).
- `source`: the sha256 of the inputs the gate decides on (gate:plan-approve: the sha256 of `tasks.json`; gate:accept: the HEAD commit id, plus a hash of the
  uncommitted changes when there are any);
  null for other gates.
- `prompts`: one per line of input the gate reads, in order. gate:answers has one per question, then the size
  (`answers`: `task`, `story`, `epic`, `c`), then the stage id; the stage-id prompt is read only when the size is
  task or story, so with epic a stage-id answer is an extra answer (AC-70). gate:spec-merge has none. `default`
  is what `--answer ""` (Enter) gives, or null when Enter is not an answer. An answer with `follows: null` is the
  key alone. With `"text"` or `"number"`, what follows comes after the key on the same line (`r split T2`), or,
  for `"text"`, as the next answer (`--answer r --answer "split T2"`). The question prompts of gate:answers take
  free text, so their `answers` list only `c`.
- `hint`: the command to continue, with the command name.
- The run file's `card` is set when the run reaches a gate and back to null when the gate decides.

**Run file (`run.json`)**

| Field | Type |
| --- | --- |
| `id`, `description` | string |
| `mode` | `task` \| `quick` |
| `status` | `running` \| `waiting` \| `finished` \| `cancelled` |
| `next` | one of the values listed above |
| `returnTo` | the `next` value that gate:limit returns to, or null |
| `card` | the gate card of the gate the run waits at, or null (written when the run reaches the gate) |
| `steps` | `[{ "step": <next>, "start": <ISO>, "end": <ISO or null> }]`, one entry per step as it ran (AC-81) |
| `estimateSec` | the work time estimated at gate:plan-approve (task) or at start (quick), or null (AC-81) |
| `limitReason` | `attempts` \| `blocked` \| `review-loop` \| `fuse` \| `decision` \| `test-conflict` \| `tests-changed` \| null |
| `proposal` | clarify output (questions, size, stage, split), or null |
| `stage`, `size` | the confirmed values, or null |
| `stagePrefill` | the `--stage` id that gate:answers proposes, or null |
| `branch` | the branch the run expects to be on |
| `baseCommit` | sha, set when the run's work branch is created |
| `tasks` | `{ id, taskBase, attempts, blockingCount, lastFeedback, checks: {cmd, exit, skipped}[], notes: string[], commit: sha \| "empty" \| null }[]` |
| `createdBranches` | `string[]`, the branches this run created |
| `gates` | `{ gate, at, decision, comment }[]`; a plan-approve reject adds `planSha256`, a decision retry `asked` |
| `answers` | `{ question, answer }[]` |
| `humanDecisions` | `string[]`, shown at the next gate |
| `costUsd` | number, the sum of the known `total_cost_usd`; always recorded, whatever the fuse |
| `costUnknownCalls` | number of calls whose cost is unknown: killed (timeout, interrupt) or a result without `total_cost_usd`. A run file without it reads as 0 (AC-62) |
| `calls` | number of Claude calls made |
| `fuse` | `{ calls: n }` \| `{ usd: n }` \| `"off"`, copied from config at start; raised at gate:limit |

**How Claude Code is invoked**

The binary is `$AGENT_STACK_CLAUDE` when it is set (the fake in tests), otherwise `claude`. Every call:
- gets `-p --output-format stream-json --verbose --max-turns <maxTurns> --model <model> --json-schema <role
  schema>`, plus
  `--max-budget-usd <dollars left>` only with a dollar fuse;
- gets the role prompt on stdin;
- gets `AGENT_STACK_RUN` in its environment;
- loads only the project (AC-58):
  - `--strict-mcp-config --mcp-config <the project's .mcp.json, or {"mcpServers":{}}>`;
  - `--setting-sources project,local`, so no user plugins, permissions or hooks;
  - `--settings '{"claudeMdExcludes":["<user dir>/CLAUDE.md"]}'`, where the user dir is `$CLAUDE_CONFIG_DIR`
    when it is set, else `<home>/.claude`;
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

**One source of rules** (AC-67). A role's rules come from the project's skill or agent: spec from `/spec`, plan
from `/plan`, implement from the `implementer` agent, review from the `code-reviewer` agent. The driver's prompt adds only the step's data, its bounds
(what is done, what the role must not do) and the output it wants. It keeps no copy of a skill's or an agent's
rules, so an improved agent reaches the driver too.

- **clarify**:
  - ask at most 5 questions, each with a recommended answer;
  - size the work;
  - propose a stage id; for an epic, a split;
  - the stage-id rule, "letters then digits, like A1", and the ids already in use (spec folders on the base
    ref and `spec/*` branches), which the driver lists (AC-48).
- **spec**:
  - the full text of the `/spec` skill, with `$ARGUMENTS` = `<stage> <title>` and `${CLAUDE_SKILL_DIR}`
    filled in;
  - the description, and the answers marked "these are the grill";
  - "write a full spec; the branch exists; do not commit, branch or push";
  - "skip the step **Hand over** of the skill: the driver commits the spec and stops for the human's merge; do
    not ask about committing, merging or handing over". The step is named by its title, never by its number: a
    step added to the skill must not shift which step is skipped;
  - "the driver checks your `## Terms` with `trace --terms`: a word the project shares goes into the glossary
    in this change, a word for this spec only is marked `(local)`".
- **plan**:
  - the full text of the `/plan` skill, filled in;
  - "the spec is merged and the branch exists — skip the precondition and step 1; do not run verify,
    commit or implement";
  - "do not write `tasks.json`: return the tasks in your output; the program writes the file";
  - "**every task ends green**: its test is written first inside the task and its verify passes when the
    task is done; no test-only tasks".
- **implement**:
  - the body of `.claude/agents/implementer.md` (frontmatter removed), labelled as the rules, with "follow
    'Under the driver'" (AC-67). The agent says, among its rules:
    - "write the failing test first, see it fail, then the code; touch only this task; do not commit,
      branch or edit `tasks.json`";
    - "a change to documentation only (Markdown, comments, no behaviour) needs no test; say so in the report";
    - the test conflict rule (AC-64);
  - the task;
  - the text of its criteria;
  - the last feedback, labelled "FROM THE PROGRAM";
  - the shell commands it may run, built from the same list as its `--allowedTools`: "anything else is
    denied, so do not try it".
- **review**:
  - the body of `.claude/agents/code-reviewer.md` (frontmatter removed), labelled as the review rules (AC-67);
  - the task, its criteria and its verify command (`(none)` when empty);
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
  - `status`: `DONE` \| `BLOCKED` \| `TEST_CONFLICT`;
  - `conflict`: `{test, criterion, reason}`, required with `TEST_CONFLICT` and only then (AC-64);
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
- `total_cost_usd`, or unknown when it is missing or the call was killed (AC-62);
- `permission_denials`;
- `structured_output`.

**Commits** (always the driver's):
- spec: `docs(<stage>): spec — <title>`;
- task: `<type>(<stage>): <subject>`;
- quick: `<type>(quick): <subject>`.

The driver stages exactly the paths of the task diff, or the spec's allowed paths. It never stages
`.claude/tmp/`.

Before committing, the driver normalises the header so that `@commitlint/config-conventional` accepts it:
- the scope is lowercased (`A0` → `a0`);
- a prefix the model repeated at the start of the subject is removed: the stage, alone or with a task id
  (`A2: …`, `A3 T2: …`), or a whole `<type>(<scope>): ` or `<type>: ` with a known type;
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
  - no branch `spec/<id>` exists, and none under `spec/<id>/` (git could not create `spec/<id>` then).
- **AC-8:** WHEN size task or story is confirmed, THE SYSTEM SHALL:
  - create `spec/<stage>` from the base ref;
  - run the spec role;
  - check that `<specsDir>/<stage>/SPEC.md` exists and that only `<specsDir>/<stage>/`, `<adrDir>/` and the
    glossary file changed (the glossary: `gates.json → glossary`, else `docs/GLOSSARY.md`; none when `""`);
  - check the spec's terms (AC-59);
  - commit those paths as `docs(<stage>): spec — <title>`.
- **AC-9:** WHEN size epic is confirmed, THE SYSTEM SHALL write `split.md` from `proposal.split` and print
  `<command name> run task --stage <id> "<goal>"` for each part (AC-73). It SHALL finish the run without writing code.
- **AC-10:** WHEN the spec is committed, THE SYSTEM SHALL stop at gate:spec-merge, print how to approve it,
  and exit with code 3.
  - With `origin/<base>`: push `spec/<stage>`, merge its pull request, then `git fetch`.
  - Without it: `git checkout <base> && git merge spec/<stage>`. The local merge is the approval, and the text
    says nothing about a push.
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
- **AC-63:** WHEN a plan task's first attempt starts, THE SYSTEM SHALL run that task's verify once, before the
  implement call, through `.claude/bin/verify --dry <task>`. That is the same guard-bash check and the same
  environment as verify, and it records nothing: no `passes`, no `verify.log`. `tasks.json` is re-read from disk,
  so a command a role rewrote is guarded, not run raw.
  - IF it exits 0, THEN THE SYSTEM SHALL add a note to the task: its verify passed before the task started, so
    it may not test the task. Gate:accept shows the note (AC-21). The run goes on.
  - A red result is the expected state; nothing is noted.
  - A timeout is AC-60. Quick mode's Q1, a fix task F*k* and a later attempt are not checked.
- **AC-17:** WHEN the plan role runs, THE SYSTEM SHALL embed the `/plan` skill (AC-4), which requires that every
  task end green: tests first inside a task, and no test-only tasks. The prompt SHALL NOT repeat the rule: the
  skill is its one source (One source of rules).
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
- **AC-67:** WHEN the review or the implement role runs, THE SYSTEM SHALL put the body of the project's agent
  (`.claude/agents/code-reviewer.md`, `.claude/agents/implementer.md`; frontmatter removed) into its prompt as
  the rules, and add no rules of its own (One source of rules).
  - The `implementer` agent SHALL have two sections, "In a chat" and "Under the driver". In a chat it reads
    the task from `tasks.json`, runs `.claude/bin/verify <id>` and reports in the contract, `TEST_CONFLICT`
    included. Under the driver it runs only the commands the prompt lists, never `.claude/bin/verify`, and
    answers in the caller's schema.
  - The `code-reviewer` agent's task review SHALL judge only the criteria the caller gives; another task's
    criteria are not a `fail`. With no criteria or no verify given, `verifyProves` is `true`.
  - IF the agent's body is empty, or `implementer.md` has no `## Under the driver` section, or
    `code-reviewer.md` has no "Task review" item, THEN THE SYSTEM SHALL keep `next` and exit with code 1:
    `agent <path> is out of date: no <what> (run agent-stack update --force, or add it)`. A file the user
    changed is kept by `update`, so an old copy must not run silently.
  - The `code-reviewer` agent SHALL say: when the caller gives a JSON schema, answer in it, with the same
    severities and the same need for evidence. For a task review it SHALL say what `spec`, `quality` and
    `verifyProves` mean, and give the check for `verifyProves`: imagine the line that does a criterion removed;
    if the task's verify would still pass, it proves nothing for that criterion.
  - IF the agent file is missing, THEN THE SYSTEM SHALL keep `next` and exit with code 1:
    `agent not found: <path> (run agent-stack update)`, as for a missing skill (`update` restores a missing
    harness file; `generate` refuses an existing harness).
- **AC-21:** WHEN the last task is committed, THE SYSTEM SHALL stop at gate:accept and show:
  - the diff stat from `baseCommit`;
  - each task's checks;
  - the review notes;
  - the skipped commands;
  - the test changes the human allowed (AC-66);
  - the human decisions;
  - the cost;
  - in task mode with more than one plan task, the **final check**: `.claude/bin/verify` with no task id, run
    once more right before the gate, so a later task that broke an earlier one shows up. It is skipped after a
    fix task F*k*, whose checks already are every task's verify (AC-22). When the tree has uncommitted changes
    outside `.claude/tmp/`, the gate says that the final check ran on them, so a hand fix is not taken for
    the committed state.
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
  `quickReviewLines`. It SHALL then commit as `<type>(quick): <subject>` and stop at gate:accept.
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
    driver keeps. A spec or plan call whose result is undone adds nothing, except at gate:limit (decision),
    which shows that call's items (AC-57).
  - A denial is one line: `permission denied: <tool> <file_path or command>`, cut to 120 characters.

### Unhappy path

- **AC-33:** IF any check exits non-zero, THEN THE SYSTEM SHALL record feedback and return to implement as a
  new attempt (partner of AC-19). A check that times out is AC-60, not a red check.
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
- **AC-61:** IF the final check exits non-zero, THEN THE SYSTEM SHALL mark it red at gate:accept and show its
  last 50 lines (partner of AC-21).
  - The gate SHALL say that `r` with a comment adds a fix task, and that `a` accepts a red result.
  - The human decides; the driver does not refuse `a`.
- **AC-62:** IF a call is killed, or its result has no `total_cost_usd`, THEN THE SYSTEM SHALL count its cost
  as unknown, not as $0 (partner of AC-35).
  - It SHALL add 1 to `costUnknownCalls` and nothing to `costUsd`.
  - Every place that shows the cost SHALL add "k with unknown cost" when k > 0.
  - With a `usd` fuse it SHALL also say that the fuse may count too little.
- **AC-60:** IF a check or base-check's `test` runs longer than `checkTimeoutMin`, THEN THE SYSTEM SHALL exit
  with code 1 and name the command and the limit (partner of AC-15, AC-19).
  - It SHALL count no attempt and keep `next` at that step, so `--resume` runs the checks again.
  - A hang is the environment's fault, for example a package manager waiting on the network. It is not a
    reason to send the code back to implement on Opus.
- **AC-59:** IF `.claude/bin/trace --terms <stage>` exits 1 after the spec role, THEN THE SYSTEM SHALL treat its
  output as a bounds problem (AC-40): undo, re-run the role once with that output as feedback, then exit with
  code 1 (partner of AC-8). A missing `trace`, or any other exit code, is no check.
- **AC-45:** IF the plan role's `tasks` are not a valid plan, THEN THE SYSTEM SHALL re-run it once with the
  error, then exit with code 1 (partner of AC-12).
- **AC-57:** IF the spec role ends without its SPEC.md, or the plan role without a valid plan, and its
  `needsHumanDecision` is not empty, THEN THE SYSTEM SHALL not re-run it. It SHALL go to gate:limit, reason
  "decision", and show the items (partner of AC-12, AC-44).
  - `r` retries the role with the comment that follows, labelled "FROM THE HUMAN"; `c` cancels.
  - The gate record keeps the items as `asked`. The retried role gets them with the answer: "FROM THE HUMAN:
    you asked: <items>; the answer: <comment>".
  - The attempts and the fuse are unchanged.
- **AC-64:** IF implement returns `TEST_CONFLICT`, THEN THE SYSTEM SHALL go to gate:limit, reason "test
  conflict", and show the conflict: the test, the criterion and the reason (partner of AC-16).
  - The `implementer` agent, which the implement prompt carries (AC-67), SHALL say: if an existing test, or
    the task's verify, contradicts a criterion, do not change it; return `TEST_CONFLICT`. Existing means not written in this attempt: another task's test,
    a test the repo had, or the verify command.
  - `r` retries implement with the comment that follows: the role gets the conflict and the answer, labelled
    "FROM THE HUMAN". The human may fix the test or the spec by hand before `r`. `c` cancels.
  - No attempt is counted, and the model stays as it was. The attempt's edits are kept.
  - The gate record keeps the reason, so the answer reaches only implement, never a spec or plan role (AC-57).
  - A commit or branch switch in the same call is AC-43 first: a failed attempt, and the conflict is not shown.
  - IF `TEST_CONFLICT` comes without `conflict`, or `conflict` comes with another status, THEN that is a
    schema mismatch (AC-37).
- **AC-65:** IF a task of the plan role has a verify that cannot fail, THEN THE SYSTEM SHALL treat the plan as
  not valid (AC-45), with the error `task <id>: verify cannot fail (<pattern>); remove it` (partner of AC-12).
  - A verify cannot fail when it holds `|| true`, `|| :`, `|| echo`, `|| exit 0`, `; true`, `; exit 0`,
    `set +e` or `set +o errexit`, pipes into `| tee` or `| cat`, or ends, after other lines, with a line that is
    only `true` or `exit 0`. A verify that is only `true` stays valid (a docs-only task). The match is on whole words, so `-t "true value"` is not one. It does not look inside quotes, so
    `grep "a; true" f` is refused too; rewrite such a command.
  - Only a new plan is checked. A plan approved earlier is read as it is, so a run in progress is not stopped.
  - The `/plan` skill SHALL say the same. `.claude/bin/verify` does not check it.
- **AC-66:** WHEN implement returns DONE, THE SYSTEM SHALL compare the task's frozen tests and the check configs
  with the task's base, before it runs the checks.
  - IF a frozen test file is gone, has fewer tests or fewer assertions, or more skip marks, or a check config that
    exists at the base has changed, THEN THE SYSTEM SHALL go to gate:limit, reason "tests changed", and list each
    change: `deleted test file a.test.ts`, `a.test.ts: assertions 12 → 10`, `changed check config vitest.config.ts
    (now 1a2b3c4)`, `deleted check config jest.config.js`. The run file keeps the list.
  - The same holds for a package manifest: a script of the base changed or removed, a dependency entry added or
    changed, a check setting added, changed or removed, or a manifest that is no longer valid JSON. The lines:
    `changed script test in package.json (now: node --test || true)`, `deleted script lint in package.json`, `new
    dependency left-pad in package.json (dependencies: ^1.3.0)`, `changed dependency vitest in package.json
    (devDependencies: ^2.0.0 → ^3.0.0)`, `changed setting jest in package.json (now 1a2b3c4)`, `package.json is not
    valid JSON (now 1a2b3c4)`. A shown value longer than 80 characters is cut and ends with its content hash, so a
    later edit is still a new line. A control character in a value, a name or a path is shown as a space, and the
    text ends with its hash, so a name cannot hide or fake a line. A new script and a removed dependency do not
    stop the run.
  - `a` allows exactly the changes listed, as the run file keeps them; the run goes on to the checks. A change that
    is not on the list stops again: one made while the gate waited, or a later edit of an allowed check config
    (its content hash differs). Gate:accept shows the allowed changes (AC-21).
  - `r` retries implement with the list and the comment that follows; this is a new attempt (on Opus). `c`
    cancels.
  - With `testGlobs` empty, only the check configs are compared. A test renamed or merged is a change too; the
    human allows it. A test the human weakened by hand at another gate is a change too.
  - It does not see a weaker assertion that keeps the count (`toBe(3)` → `toBeTruthy()`), nor manifests other
    than `package.json` (`pyproject.toml`, `Cargo.toml`, `go.mod`).
- **AC-46:** IF a task's checks pass with an empty task diff, THEN THE SYSTEM SHALL record `commit: "empty"`,
  make no commit, and show it at gate:accept (partner of AC-20).
- **AC-47:** IF `--resume` finds the spec missing on the base ref, THEN THE SYSTEM SHALL stay at
  gate:spec-merge, print the same steps as AC-10 and exit with code 3 (partner of AC-11).
- **AC-48:** IF a stage id fails AC-7, THEN THE SYSTEM SHALL say why and ask again at the same gate (partner
  of AC-7).
  - The reason SHALL be plain: "it must be letters then digits, like A1", not the pattern.
  - The failed id SHALL NOT stay the default. The gate SHALL offer clarify's proposal when it passes AC-7.
    Otherwise it SHALL offer a free id: the letters of the id in use with the highest number, and the next
    number, or `A1` when none is in use. The offered id passes AC-7.
  - This holds for clarify's proposal too.

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

### Gate cards and the operator chat

- **AC-68:** WHEN the run reaches a gate, THE SYSTEM SHALL build its gate card, write it to the run file, and
  print it:
  ```text
  ━━ <title> ━━
    <fact>
    <fact>
  Needed from you: <prompt text>
    <key> — <label> · <key> <text|number> — <label> · …
  ```
  - The facts are what the gate's criterion lists (AC-6 answers, AC-10 spec merge, AC-12 and AC-13 plan
    approval, AC-21 accept, AC-35 / AC-38 / AC-57 / AC-64 / AC-66 limit, AC-32 human decisions). The card
    changes the layout, not the content.
  - gate:answers: one fact per question with its recommended answer, then the size and the stage id; the
    prompts follow the card one by one (AC-48).
  - gate:plan-approve: each task is two lines: `<id>  <tier> · <model>[ · risky] · <criteria>   <description>`,
    then `      verify: <verify>`. `<criteria>` is the ids joined by `,` with the `AC-` prefix written once
    (`AC-1,3,5`). The last fact is `full task text: <path of tasks.json>`. A verify command is never cut, since
    the human approves it as written.
  - The terminal cuts a one-line fact longer than 100 characters to 100, the last of them `…`. It never cuts a
    verify, an AC-66 change line, an AC-32 line (cut at 120 by AC-32), the cost and time lines, the AC-77 note,
    or a multi-line output (the tails of
    AC-33 and AC-61, a BLOCKED report): those print as they are. The card data is never cut.
  - The waiting line of AC-29 and the steps of AC-10 follow the card; they are its `hint`. The waiting line
    reads `Waiting at <gate> for your answer (<keys>): <hint> --answer <answer>`, the keys from the card's first
    prompt (`a | r <text> | c`), so it does not read as an error.
  - A title names the gate and its subject, not the run id or the branch (both are facts or in the hint):
    `Plan <stage>: <n> task(s)`, `Accept: <stage or quick> · <n> task(s)`, `Stopped: <reason>`,
    `Spec <stage> is ready to review`, `Questions before the spec`.
  - gate:accept starts with one summary fact — `<n> task(s) · <k> commit(s) · checks green` (or `<r> red`), and
    `· final check green|RED` when there is one — then the time (AC-81) and the cost, then the branch, the diff
    stat and each task. A skipped command is named once, in `Skipped:`, not again in its task's checks.
  - The final check of gate:accept runs once, when the run reaches the gate; a resume at gate:accept shows the
    kept card and does not run it again. The card names the HEAD it ran on.
  - IF, when the gate decides, its inputs differ from the card's `source` (`tasks.json` was replaced, HEAD
    moved, or the uncommitted changes differ), THEN THE SYSTEM SHALL rebuild the card (at gate:accept: run the final check again), print it, and
    ask again at the terminal; under `--answer` it SHALL refuse with code 1: "the gate changed; read the card
    again". So the human approves only what the card showed. A gate:answers resume uses the card's `default`
    for the stage id; IF that id now fails AC-7, THEN AC-48 applies.
- **AC-69:** WHEN `--status --json` runs, THE SYSTEM SHALL print one JSON object, change nothing and exit 0:
  `{ "run": { …AC-23 fields: "id", "mode", "status", "next", "branch", "attempts" (task id → count), "calls",
  "costUsd", "costUnknownCalls" (AC-62), "fuse" }, "card": <gate card or null>, "language": { "chat", "terms" },
  "warnings": [ … ] }`.
  - `card` is the kept card only when the run is `waiting`; a live or interrupted run gives null, even while a
    terminal prompt is open.
  - IF there is no run, or the named run does not exist (AC-53), THEN it SHALL print `{"run": null, "card":
    null, …}` with the reason in `warnings`, and exit 0.
- **AC-70:** WHEN `--resume` runs with one or more `--answer <text>`, THE SYSTEM SHALL use them, in order, as
  the input of the gate the run waits at, and SHALL NOT read the terminal. Then the run goes on as usual: it stops
  at the next gate with code 3, or ends with its usual code (0 finished or cancelled, 1 an error).
  - IF the run is not `waiting` at a gate that reads input (it is interrupted, or waits at gate:spec-merge),
    THEN THE SYSTEM SHALL refuse with code 1 before anything runs.
  - IF an answer is not one the prompt takes, THEN THE SYSTEM SHALL refuse with code 1, say why, apply nothing,
    and keep the run waiting at the gate. For a stage id that fails AC-7, the message names the free id AC-48
    offers.
  - IF answers are left after the gate decides, THEN THE SYSTEM SHALL refuse with code 1, apply nothing, keep
    the run waiting, and name the extra answers. So one `--resume` can never answer two gates.
  - IF the answers run out before the gate decides, THEN THE SYSTEM SHALL apply nothing, keep the run waiting
    and exit 3; the next `--resume` starts at the gate's first prompt.
  - IF `--answer` comes without `--resume`, THEN THE SYSTEM SHALL refuse with code 1 and say it needs
    `--resume`.
- **AC-71:** WHILE `gates.json → codeBy` is `"driver"`, spec-gate SHALL deny every Edit, Write, MultiEdit and
  NotebookEdit outside `openPaths`, unless the hook runs in a driver call of a live run, in any mode, on that
  run's branch. The message says to run the work through the driver (`/drive`).
  - Only three spec-gate exits come before it: no `gates.json`, no file path in the tool input, and a path
    outside the project. Then `openPaths`, then this check, then the rest: it holds with `specGate: "off"` or
    `"stage"`.
  - In a repo with no commits it does not apply, since a run needs a commit to branch from; spec-gate says that
    `codeBy` starts after the first commit.
  - With the key missing or `"anyone"`, or with no `gates.json`, nothing changes.
  - IF the key has any other value, THEN spec-gate SHALL act as for `"driver"` and say the value is unknown.
  - `openPaths` (for example docs, `*.md`, `.claude/`) stay open: the human may still write a spec through the
    chat; it still needs the merge (AC-10). A file written through Bash is not caught (README "Limits").
- **AC-72:** WHEN a run starts or resumes, THE SYSTEM SHALL read `templateVersion` from `.claude/.harness.json`,
  before any call. IF it is lower than the harness floor, THEN THE SYSTEM SHALL refuse with code 1:
  `the harness is <version>; this driver needs <floor> or later: run <command name> update, then commit .claude/`.
  - A missing file, a file that is not valid JSON, a missing key, or a version that is not `x.y.z` counts as
    "missing": the message then says `the harness is missing`.
  - `--status` and `--cancel` do not check it.
- **AC-73:** THE SYSTEM SHALL write every command it prints in a hint with the command name, including: AC-9's
  `run task --stage` lines, the steps of AC-10, the waiting line of AC-29, the lines of AC-50, the `update`
  hints of AC-67 and AC-72, the interrupted lines of AC-74, the "cancel it" and "resume" hints of the error
  messages, and the usage errors of `run`. No hint names `agent-stack` literally. A path with a space is quoted.
- **AC-74:** WHEN the driver stops on SIGINT or SIGTERM (AC-51), THE SYSTEM SHALL say that the run is kept and
  holds the lock, and print both the `--resume` and the `--cancel` command.
- **AC-75:** THE SYSTEM SHALL ship a `drive` skill (`templates/claude/skills/drive/SKILL.md`, deployed by
  `generate` and `update` to `.claude/skills/drive/SKILL.md`) that tells the operator chat to:
  - start a run with `run task` or `run quick` for the human's request, and run every `--resume … --answer` too,
    in the background, and wait for it: a step takes minutes, and a killed command interrupts the run (AC-51);
  - at each stop, read `--status --json` and show the card in `language.chat`: what happened, what is needed,
    its recommendation; gate keys, commands and ids stay as they are;
  - pass the answer with `--resume <id> --answer …`: a key the human typed as it is; a clear worded reply as
    the key it means, saying which key it sent; an unclear reply is asked again; Enter is `--answer ""`; a free
    answer that is exactly `c` is sent only when the human means cancel;
  - never do a step's work itself, while a run is open (waiting, interrupted or live) or after it: no code, spec
    or plan edits; a later fix is a new run;
  - never merge, push or open a pull request itself, also when the human agrees: at gate:spec-merge it gives the
    merge command and resumes when the human says it is done;
  - at gate:spec-merge, show the spec short in the chat — its purpose, each criterion in one line, the
    constraints and what is out of scope — and a link to the spec file, so the human decides without reading the
    file in a terminal;
  - run the driver as its own background job and follow its output file; never run the driver inside the watch
    command, since stopping the watch would stop the run;
  - while a driver command runs, follow its output (Claude Code's Monitor) and tell the human in one line when a
    step starts and when it ends (`implement:T1 started`, `ok in 90s`), not each tool;
  - at the end, report what was done, the commits (sha and subject as they are), the cost, and what the human
    should check.
  - IF a driver command exits 1 (a dirty tree, a red base, an old harness, a lock), THEN the skill SHALL tell
    the chat to show the message and its hint, change nothing, and ask the human; it SHALL NOT run
    `agent-stack update` or fix code to get past it.
- **AC-77:** WHEN a plan task's verify holds command substitution (`$(` or a backtick), THE SYSTEM SHALL add a
  fact under that task at gate:plan-approve: `note: implement cannot run this verify itself (Claude Code does not
  allow command substitution by a rule); the driver's checks still run it`. The plan stays valid.
### Seeing a run

- **AC-78:** WHILE a Claude call runs, THE SYSTEM SHALL print one line for each tool the role starts, under the
  step's `->` line: `   · <tool> <target>`, where the target is the file path, the command or the pattern,
  cut to 80 characters with `…`; a tool with none of them prints its name only. It SHALL take the call's
  result from the last event of type `result` in the stream; the `calls/` file keeps that result as before
  (AC-3), not the whole stream.
  - IF a stream line is not JSON, or no `result` event comes, THEN THE SYSTEM SHALL skip the line, and treat the
    call as AC-36 treats a call with no result JSON.
- **AC-79:** WHEN a step starts, a tool starts (AC-78) or a step ends, THE SYSTEM SHALL write
  `<run folder>/now.json`: `{ "step": <next>, "since": <ISO time the step started>, "last": <the last line
  printed> }`, by temp file and rename, and append the line with its time to `<run folder>/progress.log`.
- **AC-80:** THE SYSTEM SHALL ship `.claude/bin/run-status` (bash 3.2 and jq) that prints one line for Claude
  Code's status line: `run <id> · <step> · <m:ss in the step> · $<cost> · <last>` while a run holds the lock and
  is live; `run <id> · waiting at <gate>` while it waits; nothing when no run holds the lock. It reads the lock,
  `run.json` and `now.json`, and changes nothing. It is not turned on by `generate` or `update`: a project
  `statusLine` would replace the user's own. README says how to turn it on in `settings.local.json`.
  - IF any of those files is missing or not valid JSON, THEN it SHALL print nothing and exit 0.
- **AC-81:** THE SYSTEM SHALL keep the time of every step in the run file (`steps`): a step's entry starts when
  the step starts and ends when it ends; a gate's entry ends when the gate decides, in whichever process. A step
  interrupted (AC-51) ends at the interrupt; its resume adds a new entry.
  - **Work time** is the sum of the entries of steps that are not gates; **waiting time** is the sum of the gate
    entries (the human's time).
  - WHEN the run reaches gate:plan-approve (task) or starts (quick), THE SYSTEM SHALL estimate the work time
    from the finished runs in this repo: the mean time of each step kind (base-check, implement, checks, review,
    commit) over their entries, times the steps this run will take (base-check once, then each plan task's four).
    It SHALL keep it as `estimateSec` and show `estimate: ≈ <m> min of work (from <n> earlier runs)` on the plan
    card. IF no finished run has entries for those kinds, THEN `estimateSec` is null and the card says
    `estimate: none yet (no earlier runs)`.
  - gate:accept SHALL show `time: <m:ss> work + <m:ss> waiting for you`, the time per step kind and per task,
    and, when there is an estimate, `estimate <m:ss> → actual <m:ss>`. `--status --json` SHALL give `workSec`,
    `waitSec` and `estimateSec` in `run`.
  - A run file from before this field reads with `steps: []` and `estimateSec: null`.
- **AC-82:** WHEN `run --watch [<id>]` runs, THE SYSTEM SHALL show the run (the locked one by default), read
  only from its run folder, and change nothing:
  ```text
  run <id> · <mode> · <status> · <work m:ss> work · $<cost>
    ✓ <step>   <m:ss>              each ended step, in order (AC-81)
    ▶ <step>   <m:ss>              the step in progress (now.json), with its last 5 lines of progress.log
    ⏸ waiting at <gate> — answer: <hint>    when the run waits
  ```
  - At a terminal it SHALL redraw at most once a second until the run is finished or cancelled, then print the
    last view and exit 0; Ctrl-C exits 0.
  - Without a terminal it SHALL print the view once and exit 0.
  - IF no run holds the lock and no id is given, or the run does not exist, THEN it SHALL say so and exit 0.
- **AC-76:** THE SYSTEM SHALL read `gates.json → language` and give it in `--status --json` (AC-69), so the
  operator chat speaks `language.chat` and keeps terms in `language.terms`. With the key missing, both are `en`.
  - IF a value does not match the pattern in the Contract, or `language` is not an object, THEN THE SYSTEM SHALL
    use `en` for that value (for both, when it is not an object) and add a warning.
  - WHEN the human asks the chat for another language, the skill SHALL tell the chat to switch for that chat
    and to say that `language.chat` in `gates.json` makes it the default; the chat does not edit `gates.json`.

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
- **The operator chat answering a gate on its own:** it passes the human's answer; a recommendation is only
  shown. A run without a human (autonomous) from a chat waits for the sandbox of 0.5.
- **Buttons for gate answers in a chat:** the human answers in words.
- **The driver's own terminal text in another language:** it stays English; only the operator chat speaks
  `language.chat`.
- **Bash forging the run file:** this is the known guard-file gap (README "Limits"). The three bypasses (AC-18,
  AC-26, AC-71) also need `AGENT_STACK_RUN` and a live run on the current branch.
  - Caveat: while a run is live, a nested `AGENT_STACK_RUN=<id> claude -p …` started from Bash gets the
    bypass in that nested process. This is within the known Bash gap.

## How to verify

```bash
pnpm vitest run -t "v04 AC-"     # engine + e2e with the fake claude; hook tests for AC-18, AC-26, AC-27, AC-71 carry the same prefix
pnpm typecheck
```

Manual check, once, with the real `claude` on a scratch repo:

1. `agent-stack run quick "add a README line"`. At gate:accept, accept. Expect one commit, no push, and a
   `calls/` file per call with its argv.
2. `agent-stack run task "<a small feature>"` up to gate:plan-approve. Expect:
   - the spec committed on `spec/<stage>`;
   - after a local merge and `--resume`, a plan in which every task ends green;
   - the embedded skills followed: a spec-reviewer pass, EARS criteria.
3. In a Claude Code chat with `codeBy: "driver"`: `/drive <a small feature>`. Expect the chat to start the run,
   show each card, pass the answers with `--answer`, and finish; no Edit or Write of code by the chat itself.

## Changes

- 2026-11-20 — Frozen tests (0.4.5, from review): the skip marks are one list in code, `SKIP_MARKS`, from which
  both the frozen-tests count and cheat-guard's seed patterns are built; the Term points to it instead of copying
  it. `fit(`/`fdescribe(` now count, `this.skip` only without arguments (Mocha's form).

- 2026-11-20 — AC-17, Criterion text (0.4.5, one source of truth): the plan prompt no longer repeats "every task
  ends green" — the embedded `/plan` skill is its source; `trace` reads criterion lines in the driver's strict
  form (`- **AC-n:**`), since a looser form let the two count different criteria.

- 2026-11-20 — AC-4 (spec prompt), hotfix 0.4.4: the prompt named the skipped step by number ("step 7"). 0.4.3
  added a step to `/spec`, so step 7 became Review and the spec role was told to skip spec-reviewer. The step is
  now named by its title. A spec change is committed as `docs(<stage>): spec — <what changed>`: `spec:` is no
  Conventional Commits type, so commitlint refused it.

- 2026-11-20 — AC-75, AC-68 (from the live task run): the chat shows the spec short at gate:spec-merge (Leonid:
  reading every spec in `less` is no way to work), and runs the driver apart from its watch (a stopped watch
  killed a run); the time lines and the AC-77 note are never cut.

- 2026-11-20 — AC-68 (layout): short titles without the run id, gate:accept starts with a summary, then time and
  cost; a skipped command named once; a waiting line that does not read as an error. From the first live look at
  a card (Leonid asked for a pass over the cards).

- 2026-11-20 — AC-82 (new), CLI `--watch`: a live view of the run in any terminal. In Claude Code inside VSCode
  the status line is not shown, and the role calls are not the chat's subagents, so the run looked detached.

- 2026-11-20 — AC-81 (new), run file `steps`, `estimateSec`: the time of each step, the work and waiting time, an
  estimate from earlier runs and its check at gate:accept. Leonid: "estimated time и фактическое время … в
  метрике, это нам очень поможет для анализа". Only `at` of gate records and `duration_ms` of calls existed.

- 2026-11-20 — AC-78–AC-80 (new), "How Claude Code is invoked" (`stream-json --verbose`), AC-75 (the chat follows
  the run): a run was a blind spot. Leonid: "Ты ждёшь, а я ничего не вижу". The driver printed only the step and
  "ok in 90s"; the chat said nothing until the next gate.

- 2026-11-20 — AC-25, Commits: a quick commit is `<type>(quick): <subject>`, not `<type>: <subject>`. A repo
  whose commitlint requires a scope (this one, since 0.4.2) refused every quick commit.

- 2026-11-20 — AC-68–AC-76 (new), Decisions (the driver from a chat), Terms (Gate card, Operator chat, Command
  name, Hint, Harness floor), Contract (CLI `--answer` and `--json`, exit codes, gate input, `codeBy`,
  `language`, the Gate card schema, run file `card`): the driver can be run from a chat. Leonid: a task given in a chat must go through the
  driver, not be done by the chat on its own. The gates were hard to read in a terminal ("ужасно нечитаемо"),
  hints named `agent-stack` when it was started through `node …/cli.mjs`, Ctrl-C did not say the lock stays,
  and an old harness stopped a run halfway (`agent … is out of date`). The test-conflict retry prompt asks for
  the answer for the implementer, not "What should change?". From the live check (20/11): the chat merged the
  spec branch itself and offered a hand fix after the run, so AC-75 now forbids both; the implementer was denied
  a verify with `$(…)`, so AC-77 marks such a verify at the plan gate. The chat speaks English unless `language.chat`
  says otherwise (Leonid: the chat language and the terms language may differ). From review: answers reach only
  the gate the run waits at; a card that went stale is rebuilt before a decision.
- 2026-11-20 — AC-66, Package manifest (new term): the frozen check also compares `package.json`. The driver's
  checks run `pnpm test`, and `scripts.test` decides what that does, so `"test": "node --test || true"` made every
  check green without touching a test. A new dependency stops too: under the driver the human saw it only in the
  diff at gate:accept. From review: the check settings `package.json` holds (`jest`, `eslintConfig`, `mocha`,
  `ava`) and `pnpm-workspace.yaml` (overrides, catalog versions) are compared too; a control character in a name
  or a path is cleaned, as in a value, since it could hide a line the human then allows.
- 2026-11-19 — AC-67, Role prompts (review), from review: an empty or out-of-date agent file exits 1 instead of
  running silently; the review gets the task's verify; the task review judges only the given criteria; the
  missing-file hint says `update`, since `generate` refuses an existing harness.
- 2026-11-19 — AC-67, AC-64, Role prompts (implement): the implement role takes its rules from the
  `implementer` agent too. The agent gets a mode for the driver (no `verify`, the schema) and the test conflict
  exit in a chat as well.
- 2026-11-19 — AC-67 (new), One source of rules, Role prompts (review): the review role takes its rules from
  the `code-reviewer` agent. The driver had its own short copy, and the agent's later fixes (less noise, every
  issue with evidence) never reached it. The agent says `quality: fail` needs a critical issue with evidence;
  "Blocking review" is unchanged, the engine still blocks on any `quality: fail`.
- 2026-11-19 — AC-66 (new), Frozen tests, Check config: the driver stops when a task weakens a test it found, or
  changes a check config. With TEST_CONFLICT (AC-64) the role has a legal way out; this checks it was not
  bypassed. It stops at a gate, not as a failed attempt, because a legal rename would only use up the attempts.
  From review: skip marks only after a test call; more assertion forms; `a` allows the listed changes, and a
  check config is keyed by its content.
- 2026-11-19 — AC-64 (new): implement may return `TEST_CONFLICT`. With only DONE or BLOCKED, a role that met
  a wrong test could only change it; a legal way out cuts test cheating (ImpossibleBench: 54 % → 9 %).
- 2026-11-19 — AC-65 (new), Valid plan: a verify that cannot fail (`|| true`) makes a new plan not valid. Such
  a verify passes whatever the code does. Only the driver checks it; `.claude/bin/verify` does not. From review:
  `2>/dev/null ||` is dropped (`test -f x 2>/dev/null || exit 1` can fail); `| tee`, `| cat`, `set +o errexit`
  and a last line `true` or `exit 0` are added.
- 2026-11-19 — AC-4 (implement prompt): it lists the allowed shell commands; the role tried
  `node --test <file>`, which is not on the list, and lost a turn.
- 2026-11-19 — AC-57: the retried role gets the questions it asked with the answer; a short "yes" meant
  nothing to a fresh session.
- 2026-11-19 — Gate input (answers): each prompt says what Enter does; an answer meant for the stage id was
  typed over two recommended answers.
- 2026-11-19 — AC-4 (spec prompt): skip the skill's hand-over step; the role asked whether to commit.
- 2026-11-19 — Commits: a stage or type prefix the model repeated in the subject is removed
  (`feat(a2): a2: …`).
- 2026-11-19 — Commits: the stage with a task id (`A3 T2: …`) is also dropped from the subject (third manual
  run).
- 2026-11-19 — AC-63: the start check goes through `verify --dry`, not a raw `bash -c`. The raw run skipped
  guard-bash, and a role could rewrite a later task's verify in `tasks.json` (from review).
- 2026-11-19 — AC-63 (new): the start check. In the first build a verify passed with its test file still
  missing (vitest skipped it), and only a hand check caught it.
- 2026-11-19 — AC-58: the user CLAUDE.md to exclude follows `$CLAUDE_CONFIG_DIR`.
- 2026-11-19 — AC-7: a branch under `spec/<id>/` also takes the id (from review).
- 2026-11-19 — AC-48, Gate input, clarify and implement prompts: clarify gets the stage-id rule and the
  ids in use; a failed id is never the default, so Enter no longer loops; a docs-only change needs no test.
  From the first manual run (`greet` as the stage id, a test for a README line).
- 2026-11-19 — AC-21: the gate names a final check that ran on uncommitted changes (from review).
- 2026-11-19 — AC-62 (new), run file `costUnknownCalls`: a killed call or a result with no cost is unknown,
  not $0, so a dollar fuse does not count too little without saying so.
- 2026-11-19 — AC-21, AC-61 (new): the final check before gate:accept. A later task could break an earlier
  one's verify, and the gate still showed the earlier green.
- 2026-11-19 — AC-33, AC-60 (new): a check timeout exits 1 with no attempt counted, not a red check. A hung
  `pnpm` had sent a task back to implement on Opus (found in the Compound V check).
- 2026-11-19 — AC-8, AC-59 (new), spec prompt: the glossary is in the spec role's bounds, and the driver checks
  the spec's terms with `trace --terms` after the role. A term check that first fails at implement would sink
  every attempt for a word in the spec.
- 2026-11-19 — Terms: spec-only words marked `(local)`; Live run and Driver call moved to the glossary; the
  glosses for outside references moved to their own section. No criterion changed.
- 2026-11-19 — AC-10, AC-47: without a remote, the spec-merge gate prints the local merge commands, not a push.
- 2026-11-19 — from the manual check with the real `claude`:
  - **AC-12, AC-45, role table, role outputs:** the plan role returns its tasks and the driver writes
    `tasks.json`. Claude Code guards `.claude/` even under acceptEdits, so a headless plan could not write it.
  - **AC-57 (new):** a spec or plan role that asks for a decision stops at gate:limit instead of a blind re-run.
  - **AC-32:** a denial is one short line, and calls that are undone or re-run add nothing.
  - **AC-58 (new), "How Claude Code is invoked":** each call loads only the project. The account's
    connectors cost about 150k tokens a turn, and the user's own instructions, memory and plugins do not
    belong in a project's run.

First version.
