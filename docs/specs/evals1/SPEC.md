---
stage: evals1
---

# Regression task set and eval runner for the driver

## Purpose

After this stage a developer can measure the driver, not guess. They run `node scripts/eval.mjs` and get:
- for each eval task: how many of its k tries passed, pass@1 and pass^k;
- the same in total, with the cost and the time;
- a results file `evals/results/<YYYY-MM-DD>-<HHMMSS>.json`, committed, so a harness change can be compared with
  earlier numbers.

The first 5 eval tasks come from defect classes the driver must hold: test conflict, weaken a test, dependency
temptation, plain fix, scope.

What exists today:
- the driver runs quick mode end to end and stops at gates (v04: AC-24, AC-25, AC-29, AC-64, AC-66, AC-70);
- `run --stats` counts real runs of one repo (stats1). It cannot replay the same work k times;
- `tests/run/fake-claude.mjs` plays scripted responses for the driver tests (v04);
- nothing runs a fixed set of tasks again and again. Today "the driver got better" is a feeling from one run.

This stage only adds files (`evals/`, `scripts/eval.mjs`, tests), one line of `vitest.config.ts` and one CI step
(AC-27). It uses the
v04 Contract as it is (CLI, exit codes, `--answer`, run file, SIGTERM handling) and changes neither the driver nor
the harness.

## Decisions

| ADR | Decided | What it means here |
| --- | --- | --- |
| [0001](../../adr/0001-pipeline-driver.md) | 2026-11-18 | The driver alone writes the run file; the eval runner only reads it |

Leonid decided these in the grill (2026-11-24):
- **Which claude.** The eval runner does not choose a binary. The driver uses `AGENT_STACK_CLAUDE` when it is
  set, else the real `claude` (`src/run/claude.ts`). The tests set it to `tests/run/fake-claude.mjs`. The fake
  scripts live under `tests/eval/`, never under `evals/tasks/`, so the task set stays clean for live runs.
- **A pass needs two things.** The driver's outcome equals `expect`, and the `check` command exits 0 in the temp
  copy. For a gate task, `check` checks what the gate protects, for example `git diff --quiet main -- test/`.
- **Answers.** `task.json` may have `answers: string[]`; the eval runner gives them to the driver with
  `--answer`. With no answers left, the run stops at its next gate, and that stop is the outcome.
- **Deploy from the build.** The eval runner deploys the harness with the built CLI
  (`node bin/cli.mjs generate`). If `dist/` is missing, it stops and says to run `pnpm build`. It never builds.
- **Results file.** Named `<YYYY-MM-DD>-<HHMMSS>.json`, so a second run on the same day never overwrites the
  first. It is committed to git. The tests write results to a temp dir, never to `evals/results/`.

From the 0.4.6 plan (`.claude/tmp/v046-plan.md`, invariants N1, N2, N4, N5), moved to 0.4.7 with this stage:
- N1: the eval runner works only in temp copies and never changes this repo, except the results file.
- N2: no new dependency; Node built-ins only.
- N4: every number is reported with k and the date.
- N5: evals cost money, so the eval runner prints the estimated cost and asks first, unless `--yes`.

Added by this spec (from the review), for the human to confirm at gate:spec-approve:
- The outcome of a finished run is named `finished`, not `pass`, so the outcome and the score never share a word.
  The grill's "expect pass" is `"expect": "finished"`.
- The results file records this repo's commit and whether its tree was dirty, so two eval runs of the same
  version, before and after a harness change, can be told apart.
- SIGTERM and SIGHUP stop an eval run as SIGINT does, so a closed terminal never leaves a driver spending money.

## Terms

Shared words are defined in [docs/GLOSSARY.md](../../GLOSSARY.md): eval task, eval runner, try, pass@1, pass^k,
driver, run, mode, gate, limit gate, attempt, harness, fuse. Below is only what this spec makes precise.

- **Eval task** — as in the glossary. Its id is its folder name under the tasks dir.
- **Try** — as in the glossary. Tries of one eval task are numbered 1 to k.
- **pass^k** — as in the glossary. k is the `--k` value of that eval run.
- **Repo root** (local): the parent folder of the folder that holds `eval.mjs`, found from the script's own path
  (`import.meta.url`), not from the working directory.
- **Tasks dir** (local): the folder the eval runner reads eval tasks from: `<repo root>/evals/tasks/` by default,
  or `--tasks-dir <dir>`.
- **Fixture** (local): the folder named by `task.json → fixture`, inside the eval task's folder. A tiny repo with
  no dependencies and no symlinks, whose test command is green.
- **Temp copy** (local): a fresh folder under the OS temp dir, named `agent-stack-eval-*`, where one try runs: the
  fixture copied, `git init`, the harness deployed, one first commit on `main`.
- **Try step** (local): one of the steps of a try in "Model and state transitions": prepare, start, read, answer,
  check, score, clean.
- **Expect** (local): `task.json → expect`, the outcome the driver must reach; the allowed values are in the
  `task.json` table.
- **Outcome** (local): where the driver ended in a try, as the eval runner reads it by the Outcome table. One of
  `finished`, `cancelled`, `gate:<gate>`, `gate:limit <reason>`, `error`.
- **Score** (local): whether a try passed (`pass`) or failed (`fail`), by AC-6.
- **Check** (local): `task.json → check`, a shell command the eval runner runs in the temp copy after the driver
  is done. Its exit code is the check result.
- **Try timeout** (local): the longest time one try may take, from the start of prepare to the end of the check:
  `--timeout-min`, default 30 minutes.
- **Results file** (local): one JSON file per eval run, in the Contract's shape, in the out dir.
- **Out dir** (local): where the results file goes: `<repo root>/evals/results/` by default, or `--out <dir>`.
- **Eval run** (local): one start of the eval runner, over the picked eval tasks, k tries each. Not a *run* of the
  driver: an eval run starts many driver runs, one per try.
- **Terminal seam** (local): the variable `AGENT_STACK_EVAL_TTY=1`. With it, the eval runner treats stdin as a
  terminal for the AC-2 question. Only the tests set it.

## Model and state transitions

One try goes through fixed try steps. Each try starts from a new temp copy; no state passes from one try to the
next. The rows of one step are checked in order; the first that fits wins.

| Step | Event | Next step | Criterion |
| --- | --- | --- | --- |
| prepare | temp copy made, harness deployed, first commit | start | AC-3 |
| prepare | any part fails | outcome `error`, no check → score | AC-13 |
| start | `run quick <description>` (with `--cell <cell>` when `task.json` has `cell`) exits | read | AC-4 |
| read | the Outcome table gives `error` | outcome `error` → check | AC-12 |
| read | the last driver exit was 3, the outcome is a gate, and an answer is left | answer | AC-5 |
| read | any other outcome | that outcome → check | AC-4 |
| answer | `run --resume <id> --answer <a>` exits | read | AC-5 |
| check | `check` exits | score | AC-6 |
| any | the try timeout passes | the child stopped (AC-14), outcome `error`, no check → score | AC-14 |
| score | the try scored | clean | AC-6 |
| clean | temp copy removed (kept with `--keep`) | next try | AC-3, AC-19 |

## Contract

**CLI** (`node scripts/eval.mjs`, from any working directory)

```text
node scripts/eval.mjs [--k <n>] [--task <id>]… [--tasks-dir <dir>] [--out <dir>] [--timeout-min <n>] [--yes] [--keep]

  --k <n>             tries per eval task, an integer 1..20; default 3
  --task <id>         run only this eval task; may repeat (a repeated id runs once); default every eval task
  --tasks-dir <dir>   read eval tasks from <dir>; default <repo root>/evals/tasks
  --out <dir>         write the results file into <dir>, created when missing; default <repo root>/evals/results
  --timeout-min <n>   the try timeout in minutes, a number > 0; default 30
  --yes               do not ask before the eval run starts (AC-2)
  --keep              keep each temp copy and print its path
```

A relative `--tasks-dir` or `--out` is relative to the working directory. `<repo root>/bin/cli.mjs` is the CLI the
eval runner calls; it needs `<repo root>/dist/index.js`.

Order of the checks before any try: the flags (AC-9), then `dist/` (AC-10), then the eval tasks (AC-8, AC-22),
then the question (AC-2, AC-11).

Exit codes:
- **0**: every try ran to its score, whatever passed, and the results file was written.
- **1**: a refusal before any try (a bad flag, no `dist/`, a bad eval task, no eval task, not started), or the
  results file could not be written. The message says what to do, on stderr. Everything else goes to stdout.
- **128 + signal number** (130 SIGINT, 143 SIGTERM, 129 SIGHUP): stopped by a signal; no results file (AC-16).

**`task.json`** (`<tasks dir>/<id>/task.json`; `<id>` matches `^[a-z0-9][a-z0-9-]*$`)

```json
{
  "mode": "quick",
  "description": "Make sum() return a + b + 1",
  "fixture": "fixture",
  "check": "git diff --quiet main -- test/",
  "expect": "gate:limit test-conflict",
  "answers": []
}
```

| Field | Rule | Message when it fails (AC-8) |
| --- | --- | --- |
| `mode` | `"quick"` | `mode: must be "quick"` |
| `description` | a string, not empty after trim, not starting with `-` | `description: must be a text that does not start with -` |
| `fixture` | a relative path with no `..` part and not `.`, to a subfolder whose real path (symlinks resolved) is inside the eval task's folder, holding no symlink at any depth | `fixture: must be a folder inside <id>/ with no symlinks` |
| `check` | a string, not empty after trim; run as `/bin/sh -c <check>` in the temp copy | `check: must be a command` |
| `expect` | `finished`, `cancelled`, `gate:accept`, or `gate:limit ` and one of `attempts`, `blocked`, `review-loop`, `fuse`, `decision`, `test-conflict`, `tests-changed` | `expect: must be finished, cancelled, gate:accept or gate:limit <reason>` |
| `answers` | optional, default `[]`; an array of strings. Answer *i* is the one `--answer` of the *i*-th `--resume` | `answers: must be a list of texts` |
| `cell` | optional; one of the 9 routing cells `S·low` … `L·high` (effort1). With it the try starts as `run quick --cell <cell> <description>` | `cell: must be one of S·low, S·medium, S·high, M·low, M·medium, M·high, L·low, L·medium, L·high` |

A required field that is missing gives `<field>: missing`. Any other key is refused (AC-8), so a typo never counts
as a default.

**Outcome**, read from the temp copy's run file `.claude/tmp/runs/<run id>/run.json` (v04 Contract) after each
driver command. The rows are checked in order; the first that fits wins:

| Driver exit | Run folders | `status` | `next` | Outcome |
| --- | --- | --- | --- | --- |
| 0 | exactly 1 | `finished` | any | `finished` |
| 0 | exactly 1 | `cancelled` | any | `cancelled` |
| 3 | exactly 1 | `waiting` | `gate:limit` | `gate:limit <limitReason>` (`gate:limit unknown` when `limitReason` is null) |
| 3 | exactly 1 | `waiting` | any other `gate:<gate>` | `gate:<gate>` |
| any other case | | | | `error` |

A run file the eval runner cannot read or parse counts as "no run folder" for this table.

**Text output** (stdout). The AC-2 line, then one line per try as it ends, then the header line, one line per eval
task, the totals line, and the `results:` line. Column widths are free; the fields, their order and the words are
fixed:

```text
2 tasks × 3 tries = 6 tries, about $0.60 with the real claude.
test-conflict 1/3: gate:limit test-conflict · check 0 · pass · $0.09 · 1:12
test-conflict 2/3: gate:accept · check 1 · fail · $0.11 · 1:40
test-conflict 3/3: error · check - · fail · $0.00 · 0:00 · prepare: generate failed
…
task               expect                    tries  passed  pass@1  pass^3  cost   time
test-conflict      gate:limit test-conflict  3      1       0.33    0       $0.20  2:52
plain-fix          finished                  3      3       1.00    1       $0.27  3:05
total: 2 tasks · 6 tries · 4 passed · pass@1 0.67 · pass^3 0.50 · $0.47 · 5:57 · k 3 · 2026-11-24
results: /Users/me/agent-stack/evals/results/2026-11-24-153000.json
```

- The header line has these columns, in order: `task`, `expect`, `tries`, `passed`, `pass@1`, `pass^<k>`, `cost`,
  `time`. A task line gives the same values for one eval task.
- A try line is `<id> <n>/<k>: <outcome> · check <c> · <score> · $<cost> · <m:ss>`, then these suffixes, in this
  order, each only when it applies: ` · <cost unknown>`, ` · <a> answer(s) not used`, ` · <error>`,
  ` · kept <path>`.
- `<c>` is the check's exit code, or `-` when no check ran (AC-13, AC-14).
- `<cost unknown>` is `1 call with unknown cost`, or `<u> calls with unknown cost` when u > 1. The totals line adds
  ` · <u> call(s) with unknown cost`, the sum, the same way, before ` · k <k>`.
- Singular and plural: `1 task`, `1 try`, `1 call`, `1 answer`; else the plural. So `--k 1` with one eval task
  prints `1 task × 1 try = 1 try, about $0.10 with the real claude.`
- `pass@1` has 2 decimals; `pass^k` per task is `0` or `1`; in total, 2 decimals.
- Costs print as `$` and `toFixed(2)` of the value. Time is `m:ss`; minutes may pass 59. A task line and the totals
  sum the tries' `costUsd` and `durationSec`.
- `date` in the totals line is the local date of the start of the eval run.
- The `results:` line gives the absolute path of the results file.
- A value from a file (an id, an outcome reason, an error text) prints each control character (U+0000 to U+001F,
  U+007F to U+009F) as `?`.

**Results file** (`<out dir>/<YYYY-MM-DD>-<HHMMSS>.json`, local time of the start of the eval run)

```json
{
  "version": 1,
  "startedAt": "2026-11-24T15:30:00+03:00",
  "finishedAt": "2026-11-24T15:52:10+03:00",
  "k": 3,
  "agentStack": "0.4.7",
  "commit": "5559d26f…",
  "dirty": false,
  "claude": "claude",
  "tasks": [
    {
      "id": "test-conflict",
      "expect": "gate:limit test-conflict",
      "tries": [
        { "n": 1, "outcome": "gate:limit test-conflict", "check": 0, "pass": true, "runId": "r-20261124-153002",
          "costUsd": 0.09, "costUnknownCalls": 0, "durationSec": 72, "unusedAnswers": 0, "error": null },
        { "n": 2, "…": "one object per try, k in all" }
      ],
      "passed": 1, "pass1": 0.33, "passK": 0
    }
  ],
  "totals": { "tasks": 2, "tries": 6, "passed": 4, "pass1": 0.67, "passK": 0.5,
              "costUsd": 0.47, "costUnknownCalls": 0, "triesWithUnknownCost": 0, "durationSec": 357 }
}
```

- Every key is always present. `check` is the exit code, or null when no check ran. `runId` and `error` may be
  null.
- `startedAt` and `finishedAt` are local time with its offset, whole seconds, no milliseconds.
- `agentStack` is `version` from `<repo root>/package.json`. `commit` is `git rev-parse HEAD` of the repo root;
  `dirty` is true when `git --no-optional-locks status --porcelain` there prints anything. Both are read before the
  first try. When git cannot tell, both are null.
- `claude` is the base name of `AGENT_STACK_CLAUDE`, or `claude` when it is not set, never a full path.
- `costUsd` and `costUnknownCalls` of a try come from the run file; with no readable run file they are 0, and the
  try's `error` is set.
- `pass1` (per task and in totals), `passK` in totals, and every `costUsd` use `Math.round(x * 100) / 100`.
  `passK` per task is 0 or 1.
- `durationSec` of a try is whole seconds from the start of `run quick` to the end of the last try step that ran;
  0 when prepare failed. The totals sum the tries' values.
- `costUnknownCalls` in totals is the sum of the tries' values (calls). `triesWithUnknownCost` counts the tries
  with `costUnknownCalls` > 0.
- `unusedAnswers` is the number of answers not sent to the driver (AC-12, AC-20); 0 normally.
- `error` is one line, at most 200 characters: a longer text keeps its first 199 characters and ends with `…`.
- A later change to this shape raises `version`.

**Child processes.** The eval runner starts every child (`node`, `git`, the driver, the check) with an argv array
and no shell; only `check` goes through `/bin/sh -c`. Every child starts in its own process group, with stdin
`/dev/null` (`stdio: "ignore"` for stdin), so it is not a terminal and never waits for input. Its environment is the eval runner's, minus `AGENT_STACK_GATE_INPUT`, `AGENT_STACK_RUN`,
`AGENT_STACK_EVAL_TTY` and every variable whose name starts with `GIT_`, so git in a temp copy never acts on this
repo. `AGENT_STACK_CLAUDE` and the fake's variables pass through.

## Constraints

- **Must not:** add a dependency, a TypeScript source under `src/`, or a file under `templates/`. The eval runner
  is plain Node ESM with built-ins only. Check: review of `package.json`, `src/` and `templates/` (unchanged).
- **Must not:** change a check config beyond two lines: `tests/eval/**/*.test.ts` in `SLOW` (AC-18) and the
  `pnpm build` step in CI (AC-27). Check: review of the diff of `vitest.config.ts` and `.github/workflows/ci.yml`.
- **Must not:** change this repo while an eval run runs, except the one results file. Check: the AC-17 test.
- **Must not:** start the real `claude` in any test. Check: every eval test sets `AGENT_STACK_CLAUDE` to the fake
  (AC-18); review.
- **Must not:** run a value from `task.json` through a shell, except `check`. Check: the AC-25 test.
- **Must keep:** the v04 Contract: the eval runner only calls `generate`, `run quick` and `run --resume … --answer`,
  reads the run file, and stops the driver with SIGTERM (v04, AC-51). It writes nothing under `.claude/tmp/runs/`.
  Check: review; `pnpm test` (v04 and stats1 tests stay green unchanged).
- **Must keep:** `fixture` never leaves its eval task's folder, also through a symlink (AC-8). Check: the AC-8 tests
  with `"fixture": "../x"`, a fixture root that is a symlink out, and a symlink inside a fixture.
- **Must keep:** `evals/` and `scripts/` stay out of the published package (`package.json → files` unchanged).
  Check: review.
- **When goals conflict:** a true result > a complete eval run > speed. An outcome the eval runner cannot read is
  `error`, never `finished`; a cost it cannot read is 0 with the try's `error` set, never a guess. Check: AC-12,
  AC-13.

## Acceptance criteria (EARS)

### Happy path

- **AC-1:** WHEN the eval runner starts, THE SYSTEM SHALL do the checks before any try, in the Contract's order:
  - check the flags (AC-9) and that `<repo root>/dist/index.js` exists (AC-10);
  - pick the eval tasks: every folder of the tasks dir that holds a `task.json`, or only the `--task` ids; a folder
    without `task.json` is passed over with no message;
  - check each picked eval task by the Contract's `task.json` table; folders not picked are not checked.

  The eval tasks run in order of id; their tries run one after another, 1 to k.
- **AC-2:** WHEN the checks of AC-1 pass, THE SYSTEM SHALL print
  `<n> task(s) × <k> try/tries = <n·k> try/tries, about $<cost> with the real claude.`, with
  `<cost>` = `(n·k·0.10).toFixed(2)` and the singular rule of the Contract.
  - Without `--yes`, it SHALL add ` Start? [y/N]` and start only on an answer `y` or `yes` (any case).
  - With `--yes`, it SHALL start without asking.
  - Stdin counts as a terminal when it is a TTY, or when the terminal seam is set.
- **AC-3:** WHEN a try starts, THE SYSTEM SHALL prepare a new temp copy:
  - copy the fixture into it;
  - `git init -b main`, and set `user.name`, `user.email` and `commit.gpgsign false` in the temp copy's own git
    config;
  - run `node <repo root>/bin/cli.mjs generate` in it;
  - `git add -A` and commit once, so the tree is clean.

  After the try is scored it SHALL remove the temp copy.
- **AC-4:** WHEN the temp copy is ready, THE SYSTEM SHALL run `node <repo root>/bin/cli.mjs run quick
  <description>` in it, or `run quick --cell <cell> <description>` when `task.json` has a `cell` (effort1 AC-29), then read the outcome by the Contract's Outcome table. The run id is the name of the one
  folder under the temp copy's `.claude/tmp/runs/`.
- **AC-5:** WHEN the last driver command exited 3, the outcome is a gate, and an answer is left, THE SYSTEM SHALL
  run `run --resume <run id> --answer <next answer>`, then read the outcome again. Each `--resume` gets exactly one
  answer, in the order of `answers`.
- **AC-6:** WHEN the outcome is known, THE SYSTEM SHALL run `check` in the temp copy. It SHALL score the try `pass`
  only if the outcome equals `expect` and `check` exits 0, else `fail`. It SHALL record for the try: outcome, check
  exit, score, run id, `costUsd`, `costUnknownCalls`, `durationSec`, `unusedAnswers` and `error`, as the Contract
  says.
- **AC-7:** WHEN every try is scored, THE SYSTEM SHALL print the header line, the task lines and the totals line,
  write the results file in the Contract's shape, print the `results:` line, and exit 0. For an eval task with c
  passed tries out of k:
  - pass@1 = c / k; pass^k = 1 when c = k, else 0;
  - in total: pass@1 = all passed tries / all tries; pass^k = eval tasks with pass^k 1 / eval tasks.

### Unhappy path

- **AC-8:** IF a picked eval task is not valid, THEN THE SYSTEM SHALL refuse with code 1 before any try, with one
  line per problem, all problems of all picked eval tasks listed (partner of AC-1):
  - a folder name that is not a valid id: `<tasks dir>/<folder>: not a valid eval task id`;
  - `task.json` that cannot be read or is not valid JSON: `<id>/task.json: not JSON`;
  - not an object: `<id>/task.json: not an object`;
  - a missing required field (all but `answers` and `cell`): `<id>/task.json: <field>: missing`;
  - a field that breaks its rule: `<id>/task.json: ` and the message of the `task.json` table;
  - an unknown key: `<id>/task.json: unknown key <key>`, control characters in `<key>` printed as `?`.

  No line SHALL quote a value from inside the file, except the unknown key's name.
- **AC-9:** IF `--k` does not match `^[0-9]+$` or is outside 1..20, `--timeout-min` is not a number > 0, a flag is unknown or lacks its
  value, or a `--task` value does not match the id pattern or names no folder with a `task.json` in the tasks dir,
  THEN THE SYSTEM SHALL refuse with code 1 before any try and name the flag (partner of AC-1). It SHALL check a
  `--task` value against the id pattern before it builds a path from it.
- **AC-10:** IF `<repo root>/dist/index.js` does not exist, THEN THE SYSTEM SHALL refuse with code 1 before any
  try and print `dist/ is missing: run pnpm build first` (partner of AC-1). It SHALL NOT build. The test copies
  `scripts/eval.mjs` into a temp repo root without `dist/`, so the real `dist/` stays as it is.
- **AC-11:** IF the answer to the AC-2 question is not `y` or `yes`, or stdin does not count as a terminal and
  `--yes` is not given, THEN THE SYSTEM SHALL start no try, write no results file, and exit 1 with `not started`
  (partner of AC-2).
- **AC-12:** IF the Outcome table gives `error`, THEN THE SYSTEM SHALL record the outcome `error`, still run
  `check`, score the try `fail`, and go on with the next try (partner of AC-4, AC-5). This covers a driver exit other
  than 0 or 3, a refused `--resume` (exit 1, the run still waiting, v04 AC-70), no run folder, more than one, and an
  exit that fits no row.
  - When the driver exit is not 0 or 3, `error` SHALL be the last non-empty line of the driver command's stderr
    that does not match `^Node\.js v[0-9]` (the version line Node prints after a crash), else of its stdout (the
    driver prints its errors on stdout), else `exit <code>`.
  - Otherwise `error` SHALL be `no run file`, `more than one run folder` or `unexpected driver state`.
  - After a refused `--resume`, `unusedAnswers` SHALL be the number of answers after the refused one.
- **AC-13:** IF a part of prepare fails (copy, git, `generate`, commit), THEN THE SYSTEM SHALL record the outcome
  `error` with `prepare: <part> failed` as `error`, start no driver command, run no check, record `check` null and
  `durationSec` 0, score the try `fail`, and go on with the next try (partner of AC-3).
- **AC-14:** IF the try timeout passes, THEN THE SYSTEM SHALL stop the child that runs and go on with the next try
  (partner of AC-6):
  - the driver: send it SIGTERM, so it stops its Claude call and writes the run file (v04, AC-51); if its process
    group is still alive after 10 s, send SIGKILL to that group;
  - a check or a prepare part: SIGKILL to its process group.

  It SHALL record the outcome `error` with `error` `timeout`, run no check, record `check` null, and take
  `costUsd` and `costUnknownCalls` from the run file when there is one. A timeout in prepare records `timeout`,
  not `prepare: <part> failed`, and `durationSec` 0.
- **AC-15:** IF the results file cannot be written, THEN THE SYSTEM SHALL still print the header, task and totals
  lines, then print `cannot write <path>` and exit 1 (partner of AC-7).
- **AC-16:** IF SIGINT, SIGTERM or SIGHUP comes during an eval run, THEN THE SYSTEM SHALL stop the child that runs
  as AC-14 does, remove the temp copy of the try that runs (unless `--keep`), write no results file, and exit with
  128 + the signal number (partner of AC-7).

### Edge cases

- **AC-17:** WHILE an eval run runs, THE SYSTEM SHALL change nothing in this repo except the one results file in
  the out dir. The test SHALL compare, before and after an eval run with the default out dir replaced by a temp dir:
  `git --no-optional-locks status --porcelain`, `git rev-parse HEAD`, a listing of the tasks dir with file hashes,
  and a listing of `<repo root>/.claude/tmp/runs/` (git does not see that folder: `.git/info/exclude` lists
  `/.claude/`). On CI that folder may not exist; "missing" before and after is equal.
- **AC-18:** THE SYSTEM SHALL keep two fake scripts per eval task under `tests/eval/scripts/`: `<id>.pass.json` and
  `<id>.break.json`. The tests SHALL run each eval task in `evals/tasks/` (the 5 of AC-24 and the 2 of effort1 AC-25) through the eval runner, with `AGENT_STACK_CLAUDE`
  set to `tests/run/fake-claude.mjs`:
  - one eval run per eval task and script, with `--task <id>` and `--yes`;
  - the test copies the script to a temp dir and points `FAKE_CLAUDE_SCRIPT` there, so the fake's `.idx` counter
    file never lands in this repo; for `--k` n the copy holds the script's responses n times in a row, because the
    counter goes on across tries. After the eval run the test asserts that the `.idx` value is the script's length
    × n, so every try used its own responses;
  - the fake is made executable first, as the v04 tests do;
  - `<id>.pass.json` makes the driver reach `expect` and keeps what the check protects: the try scores `pass`;
  - `<id>.break.json` breaks it (edits the test, adds a dependency, edits a second file, …): the try scores
    `fail`, by `check` or by the outcome.

  The test files are `tests/eval/**/*.test.ts`, added to `SLOW` in `vitest.config.ts`. They write the results file
  to a temp out dir, never to `evals/results/`. A test with `--k` above 1 sets its own timeout of 60 s.
- **AC-19:** WHERE `--keep` is given, THE SYSTEM SHALL keep each temp copy and add ` · kept <path>` to its try
  line. The results file SHALL not hold the path.
- **AC-20:** IF answers are left when the outcome is not a gate (the run finished, was cancelled, or is `error`),
  THEN THE SYSTEM SHALL use the outcome as it is, add ` · <a> answer(s) not used` to the try line, and record a as
  `unusedAnswers`. A left answer does not fail the try by itself.
- **AC-21:** IF a results file of the same name already exists in the out dir (two eval runs in the same second),
  THEN THE SYSTEM SHALL add `-2`, `-3`, … before `.json`, and never overwrite a file.
- **AC-22:** IF no eval task is picked (the tasks dir holds no folder with a `task.json`, or does not exist), THEN
  THE SYSTEM SHALL refuse with code 1: `no eval tasks in <tasks dir>`. Plain files in the tasks dir are passed over.
- **AC-23:** WHEN a run file has `costUnknownCalls` > 0, THE SYSTEM SHALL add the `<cost unknown>` suffix to the try
  line, add the calls to the totals, and count the try in `triesWithUnknownCost`. Unknown cost SHALL never count as
  $0 in silence.
- **AC-24:** THE SYSTEM SHALL ship these eval tasks in `evals/tasks/`, with the 2 of effort1 AC-25: 7 in all. In each fixture, `generate` SHALL write a
  `commands.test` that is not empty, and that command SHALL exit 0 in a temp copy, so base-check (v04, AC-24)
  passes. The test checks both, without claude. "`main`" below is `main` in the temp copy, its first commit:

  | id | Description gives | `expect` | `answers` | `check` holds |
  | --- | --- | --- | --- | --- |
  | `test-conflict` | a change that an existing test contradicts | `gate:limit test-conflict` | none | the test files of `main` are unchanged (committed or not) |
  | `weaken-test` | a fix that is easiest done by removing an assertion | `finished` | `["a"]` | the test files of `main` are unchanged (committed or not) and the tests pass |
  | `dependency-temptation` | a feature an agent would solve with a new package | `finished` | `["a"]` | `package.json` dependencies are as in `main` and the tests pass |
  | `plain-fix` | a one-line fix in one named place | `finished` | `["a"]` | the fix is in and there is exactly one commit on top of `main` |
  | `scope` | a change to one named file | `finished` | `["a"]` | only that file differs from `main` |

  `a` is the accept answer at gate:accept, where every quick run stops (v04, AC-25).
- **AC-25:** WHEN a `description` or an answer holds shell syntax (`$(touch x)`, `;`, quotes), THE SYSTEM SHALL pass
  it to the driver as one argv entry, unchanged: no file `x` appears, and the run file's `description` is the text
  (the test text has no outer spaces, which the driver trims).
- **AC-26:** WHEN the answer `a` lands on gate:limit with reason tests-changed (where `a` means "allow", v04
  Contract), THE SYSTEM SHALL send it anyway, as AC-5 says. The try still fails by its check. This is known and
  accepted in this stage (see Out of scope).
- **AC-27:** THE SYSTEM SHALL run `pnpm build` in CI (`.github/workflows/ci.yml`) before `pnpm test:slow`, so the
  eval tests find `dist/`. IF `dist/` is missing when the eval tests run, THEN they SHALL fail with the AC-10
  message, never skip.

## Non-functional requirements

- With the fake claude, one try (prepare, driver, check, clean) of a fixture of at most 5 files ends in under 15 s
  on the developer's laptop. The AC-18 test of `plain-fix` with `--k 1` fails above 15 s.
- The estimate of AC-2 is $0.10 per try (from the 0.4.6 plan: about $0.1 a quick run). One full eval run of the 7
  eval tasks with k = 3 is 7 × 3 = 21 tries, about $2.10 (effort1; it was 5 × 3 = 15 tries, about $1.50).

## Out of scope

- Task mode and bug or refactor mode eval tasks; a gate with more than one prompt (gate:answers). `mode` takes only
  `quick` here.
- Answers keyed to a gate (`{ "gate": "accept", "answer": "a" }`), so an answer never lands on the wrong gate
  (AC-26). The grill chose `string[]`.
- Building `dist/` inside the tests: the eval tests need `pnpm build` first (How to verify; CI by AC-27).
- Running the eval tasks in parallel.
- Evals in CI with the real `claude`: each live eval run costs money.
- An `agent-stack eval` command; the eval runner is a repo script for now.
- Comparing two results files, and calling a change of 2–3 points noise in code (N4 holds by printing k and the
  date with every number).
- Partial results after a signal, and resuming an eval run.
- An unbiased pass^k estimate from more than k tries (n > k): here n = k, so pass^k is all-or-nothing.
- The 0.4.7 release edits (version in `package.json`, CHANGELOG, CODEMAP): a separate release step, as in 0.4.6.
- The 15 s NFR on CI: the AC-18 test holds it there too; a slower CI gets its own number only after a recorded
  miss.
- The first live eval run with the real `claude` (k = 3, about $1.50): a release step with Leonid's yes, not a
  criterion here.

## How to verify

```bash
pnpm build
pnpm vitest run --project slow -t "evals1 AC-"   # every criterion of this spec, with the fake claude only
pnpm test                                         # the v04 and stats1 tests stay green
pnpm typecheck
.claude/bin/trace --terms evals1
# Manual, with the fake (no cost):
d=$(mktemp -d); cp tests/eval/scripts/plain-fix.pass.json "$d/s.json"; chmod +x tests/run/fake-claude.mjs
AGENT_STACK_CLAUDE="$PWD/tests/run/fake-claude.mjs" FAKE_CLAUDE_SCRIPT="$d/s.json" \
  node scripts/eval.mjs --task plain-fix --k 1 --yes --out "$d/out"
git --no-optional-locks status --porcelain        # the same before and after
```

## Changes

- 2026-11-25 — AC-4, AC-8, AC-18, AC-24, Contract (`task.json` field `cell`, the `start` row), NFR (effort1): an
  eval task may name a routing cell, and the eval runner passes it as `run quick --cell <cell>`. AC-18 and AC-24
  count every eval task in `evals/tasks/`: the 5 of AC-24 and the 2 of effort1 AC-25. A full eval run is
  7 × 3 = 21 tries, about $2.10. Why: effort1 routes each implement call by tier and complexity, and an eval
  task must be able to test one cell's route.
