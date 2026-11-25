---
stage: stats1
---

# Run stats: `agent-stack run --stats [--json]`

## Purpose

After this stage a user can see how the driver has worked in this repo, over all its runs. They run
`agent-stack run --stats` and get one line per run and the totals:
- mode, stage, status, date;
- first-pass success and iterations per task;
- gate decisions and limit stops;
- call outcomes by role;
- work time, waiting time and cost.

`--json` gives the same data to a program, in a fixed shape with a version.

What exists today:
- every run keeps its run folder `.claude/tmp/runs/<run id>/`, with `run.json` and `calls/<n>-<role>.json`
  (v04, AC-3);
- `run --status` shows one run, `run --watch` follows one run (v04, AC-23, AC-69, AC-82);
- nothing reads all runs together. Today a person opens the files by hand to know whether a harness change
  helped.

This stage only reads. It uses the v04 Contract as it is: the run file and the call files
([docs/specs/v04/SPEC.md](../v04/SPEC.md), "Run file (`run.json`)" and AC-3). It changes neither.

## Decisions

| ADR | Decided | What it means here |
| --- | --- | --- |
| [0001](../../adr/0001-pipeline-driver.md) | 2026-11-18 | The driver alone writes the run file; run stats only reads it |

Leonid decided these in the grill (2026-11-24):
- **Own spec.** This stage has its own spec and criteria. It refers to the v04 Contract and does not change it.
- **No grouping.** One row per run and the totals. Grouping by month or by harness version waits until there
  are about 30 runs.
- **Status like `--status`.** A `running` run with no live lock shows as `interrupted`, by the lock check the
  driver already has (`readLock` and `pidAlive`, `src/run/store.ts`), read-only.
- **A bad call file keeps the run.** A malformed or missing call file counts as `unreadable` or `missing` and is
  named in a warning. Only a malformed `run.json` skips the whole run.
- **Fixed `--json` shape** with `"version": 2` (six roles; scout1) and a `skipped` list. `usage --save` does not read it in this
  stage.

## Terms

Shared words are defined in [docs/GLOSSARY.md](../../GLOSSARY.md): run, run stats, live run, role, mode, stage,
task, attempt, gate, limit gate, fuse, first-pass success, iterations per task. Below is only what this spec
makes precise.

- **Run folder** (local): `.claude/tmp/runs/<run id>/`, as in v04. A run id is `r-<yyyymmdd>-<hhmmss>`.
- **Lock** (local): `.claude/tmp/runs/lock`, as in v04: the run id and the driver's pid.
- **Call file** (local): `calls/<n>-<role>.json` in a run folder: `{ argv, exitCode, result }`, as `callClaude`
  writes it (v04, AC-3). `result` is the result object of the call, or the raw stdout string when no result
  came. The driver writes it with a plain write, not by rename, so a reader can meet a half-written file.
- **Result object** (local): a `result` value that is an object, not null and not an array.
- **Started task** (local): an entry of the run file's `tasks` with `attempts >= 1`. Plan tasks, Q1 and fix
  tasks F*k* all count.
- **Committed** (local): a task whose `commit` is not null (a sha or `"empty"`).
- **Call outcome** (local): what one call file says about its call. One of `ok`, `schema`, `max-turns`,
  `exec-error`, `budget`, `infra`, `killed`, `unreadable`. The rule is in AC-5 and AC-10.
- **Missing call** (local): a call number from 1 to the run file's `calls` with no call file.
- **Limit stop** (local): one stop of the run at gate:limit. Its reason is one of the seven `limitReason`
  values, or `unknown` when the run file does not keep it (AC-4, AC-14).
- **Shown status** (local): the status run stats prints: `finished`, `cancelled`, `waiting`, `interrupted` or
  `running` (AC-2).
- **Work time, waiting time** (local): as v04 AC-81 defines them, from the run file's `steps`.
- **Counted run** (local): a run folder whose `run.json` passes the run file check. Only counted runs give rows
  and totals.
- **Skipped run** (local): a folder under `.claude/tmp/runs/` that run stats does not count, with the reason
  (AC-9).
- **Warning** (local): one line that names a file run stats could not fully use, while it still counts the
  run (AC-10, AC-15, AC-16, AC-19).

## Model and state transitions

Run stats has no state of its own. It maps the run file's `status` to the shown status:

| `status` in run.json | Lock | Shown status | Criterion |
| --- | --- | --- | --- |
| `finished` | any | finished | AC-2 |
| `cancelled` | any | cancelled | AC-2 |
| `waiting` | any | waiting | AC-2 |
| `running` | names this run, and its pid is alive | running | AC-2 |
| `running` | missing, unreadable, names another run, or its pid is dead | interrupted | AC-12 |

## Contract

**CLI**

```text
agent-stack run --stats [--json]     a summary over every run folder of this repo; change nothing; exit 0
```

`--stats` takes no run id, no mode, no `--stage` and no `--answer`. `--json` goes with `--status` or `--stats`.
Two `run` messages change (AC-17); every other message stays as it is.

**Read order** (per run folder): `run.json` first, then the list of `calls/`, then each call file once.

**Text output** (for a person)

A header line, then one line per counted run, oldest first (by run id), then the totals block, then one
`skipped:` line per skipped run, then one `warning:` line per warning. The column widths are free; the fields,
their order and the words are fixed:

```text
run                date        mode   stage  status       1st pass  iter  rejected s/p/a  limits  calls  work    wait    cost
r-20261120-101500  2026-11-20  task   v04    finished     2/3       1.33  0/1/0           0       11     14:05   3:10    $1.23 · 1 unknown
r-20261121-083000  2026-11-21  quick  —      interrupted  0/0       —     0/0/0           0       0      —       —       $0.00
total: 2 runs · finished 1 · cancelled 0 · waiting 0 · interrupted 1 · running 0
  first pass 2/3 (67%) · iterations per task 1.33
  rejected: spec 0 · plan 1 · accept 0
  limit stops: attempts 0 · blocked 0 · review-loop 0 · fuse 0 · decision 0 · test-conflict 0 · tests-changed 0 · unknown 0
  calls: clarify 1 (ok 1) · spec 1 (ok 1) · plan 2 (ok 2) · implement 4 (ok 2 · max-turns 1 · unreadable 1) · review 3 (ok 3) · missing 0
  permission denials: 2
  time: 14:05 work + 3:10 waiting (1 run without times)
  cost: $1.23 · 1 call with unknown cost
skipped: r-20261122-120000 — run.json is malformed: status
warning: r-20261120-101500: calls/7-implement.json is unreadable: not JSON
```

Columns of a run line:
- `date` comes from the run id (`r-20261120-…` → `2026-11-20`).
- `stage` is `—` when the run file's `stage` is null.
- `1st pass` is `<first pass>/<started tasks>`.
- `iter` is iterations per task with 2 decimals, or `—` with no started task.
- `rejected s/p/a` counts the reject decisions at gate:spec-approve, gate:plan-approve and gate:accept.
- `limits` is the number of limit stops; the totals give them by reason.
- `calls` is the number of counted call files plus missing calls.
- `work` and `wait` use `m:ss` (minutes may pass 59: `125:10`), or `—` when the run has no `steps`.
- `cost` is `$<costUsd>` with 2 decimals, then ` · <k> unknown` when `costUnknownCalls` k > 0 (v04, AC-62).
  This is a short form of AC-62's "k with unknown cost" on purpose, to keep a run on one line; the totals use
  the full words.

Lines of the totals block:
- `total:` — `<n> run` when n is 1, else `<n> runs`; then each shown status with its count, all five always.
- `first pass <f>/<t> (<p>%)`; with t = 0 it is `first pass 0/0`, with no percent. Then
  ` · iterations per task <x.xx>`, or ` · iterations per task —` with t = 0.
- `rejected:` — spec, plan and accept, always all three.
- `limit stops:` — the eight reasons, always all eight.
- `calls:` — each of the six roles in the order scout, clarify, spec, plan, implement, review: `<role> <n>`, then
  ` (<outcome> <count> · …)` with only the outcomes above 0, in the order of AC-5; a role with no calls is
  `<role> 0`. Then ` · missing <m>`.
- `permission denials: <d>`.
- `time: <work> work + <wait> waiting`, then ` (<k> run without times)` (k = 1) or ` (<k> runs without times)`
  (k > 1) only when k > 0. When no counted run has `steps`, the line is `time: —`, then the same bracket.
- `cost: $<sum>`, then ` · 1 call with unknown cost` (k = 1) or ` · <k> calls with unknown cost` (k > 1) only
  when k > 0.

Rounding: 2-decimal values are `Math.round(x * 100) / 100`, printed with 2 decimals; the percent is
`Math.round(share * 100)`; a dollar sum is printed with `toFixed(2)`.

Order of lines: `skipped:` lines by folder name; `warning:` lines by run id, then by call number (warnings
without a call number last in that run, by step order). The JSON `skipped` and `warnings` lists use the same
order.

When no run is counted, the header and the totals are not printed (AC-11).

**JSON output** (`--json`, for a program): one object on stdout, nothing else on stdout.

```json
{
  "version": 2,
  "runs": [
    {
      "id": "r-20261120-101500",
      "date": "2026-11-20",
      "mode": "task",
      "stage": "v04",
      "status": "finished",
      "tasks": 3,
      "firstPass": 2,
      "firstPassShare": 0.67,
      "iterationsPerTask": 1.33,
      "rejected": { "spec": 0, "plan": 1, "accept": 0 },
      "limitStops": { "attempts": 0, "blocked": 0, "review-loop": 0, "fuse": 0, "decision": 0,
                      "test-conflict": 0, "tests-changed": 0, "unknown": 0 },
      "calls": {
        "total": 11,
        "missing": 0,
        "byRole": {
          "clarify":   { "ok": 1, "schema": 0, "max-turns": 0, "exec-error": 0, "budget": 0, "infra": 0, "killed": 0, "unreadable": 0, "denials": 0 },
          "spec":      { "…": "the same nine keys" },
          "plan":      { "…": "the same nine keys" },
          "implement": { "…": "the same nine keys" },
          "review":    { "…": "the same nine keys" }
        }
      },
      "workSec": 845,
      "waitSec": 190,
      "costUsd": 1.23,
      "costUnknownCalls": 1
    }
  ],
  "totals": {
    "runs": 1,
    "byStatus": { "finished": 1, "cancelled": 0, "waiting": 0, "interrupted": 0, "running": 0 },
    "tasks": 3, "firstPass": 2, "firstPassShare": 0.67, "iterationsPerTask": 1.33,
    "rejected": { "spec": 0, "plan": 1, "accept": 0 },
    "limitStops": { "…": "the same eight keys as a run" },
    "calls": { "total": 11, "missing": 0, "byRole": { "…": "the same six roles and nine keys as a run" } },
    "workSec": 845, "waitSec": 190, "runsWithoutTimes": 0,
    "costUsd": 1.23, "costUnknownCalls": 1
  },
  "skipped": [ { "id": "r-20261122-120000", "reason": "run.json is malformed: status" } ],
  "warnings": [ "r-20261120-101500: calls/7-implement.json is unreadable: not JSON" ]
}
```

- Every key above is always present. `byRole` always has the six roles; each role always has the nine keys;
  `limitStops` always has the eight keys.
- In a run: `stage` is a string or null. `firstPassShare` and `iterationsPerTask` are null with no started task.
  `workSec` and `waitSec` are whole seconds, or null when the run has no `steps`.
- In `totals`, only these may be null: `firstPassShare` and `iterationsPerTask` (null when `tasks` is 0), and
  `workSec` and `waitSec` (null when no counted run has `steps`). Every other total is a number, 0 when there is
  nothing to count.
- `tasks` is the number of started tasks (AC-3), not the length of the run file's `tasks`.
- `calls.total` is the number of counted call files plus missing calls, the same as the `calls` column.
- `firstPassShare` and `iterationsPerTask` use the same 2-decimal rounding as the text output.
- `costUsd` is the sum of the run files' `costUsd`, not rounded.
- `skipped[].id` is the folder name as it is, also when it is not a run id.
- A later change to this shape raises `version`.

## Constraints

- **Must not:** write, move or remove any file, take or touch the lock, or start a process. No new dependency,
  no new field in `run.json` or in the call files. Check: the read-only test (AC-8); review of `package.json`
  and of `RunFile` in `src/run/types.ts` (unchanged).
- **Must keep:** the v04 Contract as it is. Run stats reads `run.json` with the same check as `run --status`
  (`readRunStrict`), so the two never disagree on what is malformed. Check: review; the AC-9 tests.
- **Must keep:** one rule for a call outcome. Run stats takes it from `classify` with `validateOutput(role, …)`
  as the check (`src/run/claude.ts`, `src/run/schemas.ts`), the same pair the driver calls. Check: review; the
  AC-5 test feeds the same result objects the driver's `classify` tests use.
- **Must keep:** one rule for time. Work or waiting is the gate-or-not split and the seconds of v04 AC-81
  (`src/run/engine/timing.ts`). Run stats first drops the open entries that AC-6 does not count, then uses that
  rule. Check: review; the AC-6 and AC-16 tests.
- **Must keep:** every `run` flag rule and message except the two AC-17 changes. Check: `pnpm test` (v04 tests
  stay green unchanged).
- **Must keep:** a folder name is checked by `isRunId` before run stats builds any path from it. Check: the AC-9
  test with a folder `not-a-run`.
- **When goals conflict:** a true number > a complete number > speed. A count run stats cannot know is shown as
  `unknown`, `missing` or `—`, never as 0. Check: review; the AC-13, AC-14, AC-15 and AC-16 tests.

## Acceptance criteria (EARS)

### Happy path

- **AC-1:** WHEN `run --stats` runs and at least one run is counted, THE SYSTEM SHALL print the header, one line
  per counted run oldest first by run id, and the totals block, as the Contract's "Text output" shows. It SHALL
  exit 0.
  - Each run line SHALL give, in order: run id, date, mode, stage, shown status, first pass, iterations per task,
    rejected s/p/a, limit stops, calls, work time, waiting time, cost.
  - The totals SHALL count the runs by shown status, and SHALL sum every count, time and cost over the counted
    runs.
- **AC-2:** WHEN run stats shows a run, THE SYSTEM SHALL show its status as the table in "Model and state
  transitions" maps it. `running` SHALL show only when `readLock` names this run and `pidAlive` holds for its
  pid. `finished`, `cancelled` and `waiting` SHALL show as the run file says.
- **AC-3:** WHEN run stats counts a run's tasks, THE SYSTEM SHALL count:
  - started tasks: `tasks` entries with `attempts >= 1`;
  - first pass: started tasks that are committed and have `attempts == 1`;
  - first-pass share: first pass / started tasks;
  - iterations per task: the sum of `attempts` / started tasks.

  In the totals it SHALL sum the counts over all counted runs first, then divide; it SHALL NOT take the mean of
  the runs' shares.
- **AC-4:** WHEN run stats counts a run's gates, THE SYSTEM SHALL count from the run file's `gates`:
  - rejected: records whose `decision` is `reject`, at `gate:spec-approve`, `gate:plan-approve` and
    `gate:accept`, each apart;
  - limit stops: one per `gate:limit` record, plus one **open stop** when the run's `next` is `gate:limit` and the
    last `gates` record is not a `gate:limit` record with `decision` `cancel`;
  - the reason of a recorded stop: its `reason` when present; else `fuse` when its `decision` is `raise`; else
    `unknown`;
  - the reason of the open stop: the run file's `limitReason`, or `unknown` when it is null.
- **AC-5:** WHEN run stats reads a call file with a valid name (AC-19), THE SYSTEM SHALL count one call under the
  role in its file name, with one call outcome:
  - when `result` is a result object: the kind `classify` gives with `validateOutput(role, …)` as the check,
    mapped `ok` → `ok`, `schema` → `schema`, `turns` → `max-turns`, `exec-error` → `exec-error`, `budget` →
    `budget`, `infra` → `infra`;
  - when `result` is a string (no result came): `killed` when `exitCode` is null, `infra` when `exitCode` is an
    integer.

  It SHALL add the length of `result.permission_denials` to the role's `denials` when that is an array.
  The outcome order everywhere is: ok, schema, max-turns, exec-error, budget, infra, killed, unreadable.
- **AC-6:** WHEN run stats shows a run's time and cost, THE SYSTEM SHALL give:
  - work time and waiting time by the rule of v04 AC-81: gate entries are waiting, all other entries are work;
  - for an entry with no `end`: it counts up to now only while the run is live, or when it is the last entry of
    a `waiting` run and is a gate entry; any other open entry is AC-16 or AC-24;
  - the cost as `costUsd` and `costUnknownCalls` from the run file.

  The totals SHALL sum the times over the counted runs that have `steps`, and SHALL count the runs without
  `steps` as `runsWithoutTimes`.
- **AC-7:** WHEN `run --stats --json` runs, THE SYSTEM SHALL print one JSON object in the Contract's shape with
  `"version": 2`, holding the same numbers as the text output, and nothing else on stdout. It SHALL exit 0.

### Unhappy path

- **AC-9:** IF a folder under `.claude/tmp/runs/` has a name that is not a run id, has no `run.json`, or its
  `run.json` cannot be read, is not valid JSON or fails the run file check, THEN THE SYSTEM SHALL not count it,
  print a line `skipped: <folder> — <reason>`, count all other runs, and exit 0 (partner of AC-1, AC-7).
  - The reason SHALL be one of: `not a run id`; `run.json is missing`; or the malformed message `readRunStrict`
    gives (`run.json is malformed: <field>`, `run.json is malformed: not JSON`).
  - A `run.json` that exists but cannot be read also gives `run.json is missing`. For both cases run stats
    prints its own reason, not the `readRunStrict` message (that message holds an absolute path).
  - With `--json`, the folder SHALL be an entry `{ "id": <folder>, "reason": <reason> }` in `skipped`.
- **AC-10:** IF a call file with a valid name cannot be read, is not valid JSON, is not an object, has no `result`
  key, has a `result` that is neither a result object nor a string, or has a string `result` with an `exitCode`
  that is neither null nor an integer, THEN THE SYSTEM SHALL count that call as `unreadable` under the role in its
  file name, keep the run, and add a warning `<run id>: calls/<file> is unreadable: <why>` (partner of AC-5).
  - `<why>` SHALL be one of: `cannot read`, `not JSON`, `not an object`, `no result key`, `bad result`,
    `bad exitCode`.
  - No warning and no skip reason SHALL hold text from inside a file (a parser message can quote the input; a
    call file holds argv and raw output).
  - While the run is live, an unreadable file numbered `calls` or above is the call in progress: it SHALL be
    neither counted nor warned (AC-20).
- **AC-11:** IF no run is counted, THEN THE SYSTEM SHALL exit 0 and print (partner of AC-1, AC-7):
  - `no runs in this repo` when the runs folder does not exist or holds no folder;
  - `no runs counted`, then the `skipped:` and `warning:` lines, when every folder is skipped.

  With `--json` it SHALL print the Contract's shape with `runs: []`, the totals as the Contract says for nothing
  to count (counts 0; `firstPassShare`, `iterationsPerTask`, `workSec` and `waitSec` null), and the `skipped`
  and `warnings` lists.
- **AC-12:** IF a run file says `running` and the lock is missing, unreadable, names another run, or names this
  run with a pid that is not alive, THEN THE SYSTEM SHALL show the run as `interrupted` (partner of AC-2).
- **AC-13:** IF a run has no started task, THEN THE SYSTEM SHALL show first pass `0/0` and iterations per task
  `—`, and give null for `firstPassShare` and `iterationsPerTask` in JSON, never 0 or NaN (partner of AC-3).
  - IF no counted run has a started task, THEN THE SYSTEM SHALL show the totals the same way.
- **AC-14:** IF a `gate:limit` record has no `reason` and its `decision` is not `raise`, THEN THE SYSTEM SHALL
  count that stop as `unknown`, not under a guessed reason (partner of AC-4).
  - The v04 run file keeps a reason only in records of the reasons decision, test-conflict and tests-changed
    (and not in a `cancel` record of any reason), and the driver clears `limitReason` when gate:limit decides.
- **AC-15:** IF a call number from 1 to the run file's `calls` has no call file, THEN THE SYSTEM SHALL count it
  as a missing call and add a warning `<run id>: calls/<n>-*.json is missing` (partner of AC-5).
  - While the run is live, the number equal to `calls` is the call in progress: it SHALL be neither missing nor
    warned.
- **AC-16:** IF a run's `steps` is missing or empty (a run file from before AC-81; `readRunStrict` reads a
  missing `steps` as `[]`), THEN THE SYSTEM SHALL show its work and
  waiting time as `—`, give null in JSON, and count it in `runsWithoutTimes` (partner of AC-6).
  - IF an entry has no `end`, AC-6 does not count it to now, and AC-24 does not hold, THEN THE SYSTEM SHALL count
    it as 0 seconds and add a warning `<run id>: step <step> has no end; counted as 0`.
- **AC-17:** IF `run` gets flags that do not go together with `--stats`, THEN THE SYSTEM SHALL print the message
  below and exit 1, before it reads any run (partner of AC-1, AC-7):
  - `--stats` with `--resume`, `--status`, `--cancel` or `--watch`: `Use one of --resume, --status, --cancel,
    --watch or --stats.` (this replaces `Use one of --resume, --status, --cancel or --watch.`, which every
    two-action case now prints);
  - `--stats` with a mode, a run id (both are the positional argument), `--stage` or `--answer`: `--stats takes
    no run id, mode, --stage or --answer.`;
  - `--json` without `--status` or `--stats`: `--json goes with --status or --stats.` (this replaces `--json
    goes with --status.`).
  - Order of the checks: the two-action check first, then the two `--stats` checks above, then the existing
    `--answer` and `--json` checks. So `--stats --answer x` prints the `--stats` message.

### Edge cases

- **AC-8:** THE SYSTEM SHALL change nothing while run stats runs: no file under the repo is written, moved or
  removed, no lock is taken, and no Claude process starts. It SHALL not check the harness floor (as `--status`,
  v04 AC-72), so it works without `.claude/.harness.json`.
- **AC-18:** WHEN the runs folder holds plain files (`lock`, `lock.<pid>.tmp`, `lock.stale.*`), THE SYSTEM SHALL
  pass over them without a skip or a warning: only folders are run folders.
- **AC-19:** WHEN a run folder's `calls/` holds a file, THE SYSTEM SHALL treat its name as valid only when it
  matches `<n>-<role>.json`, with n matching `[1-9][0-9]*` (no leading zero), from 1 to the run file's `calls`,
  and a role of scout, clarify, spec, plan, implement or review.
  - A name of another form (also `01-plan.json`, or a subfolder) SHALL add the warning
    `<run id>: calls/<file> is not a call file`, and the entry is not counted.
  - IF `calls/` exists but cannot be listed, THEN THE SYSTEM SHALL count every call from 1 to `calls` as missing
    and add one warning `<run id>: calls/ cannot be listed`, instead of one warning per number.
  - A file numbered 0 or above `calls` SHALL add the warning `<run id>: calls/<file> is outside 1..<calls>`, and
    the file is not counted. While the run is live, a file numbered above `calls` is a call that started after
    run stats read `run.json`: it SHALL be neither counted nor warned.
  - Two or more valid files with the same n SHALL each be counted, with one warning `<run id>: calls/<n>-*.json:
    more than one file`.
  - A run with no `calls/` folder and `calls` 0 gives no warning.
- **AC-20:** WHEN a run is live while run stats reads it, THE SYSTEM SHALL count it as it is at that moment, with
  shown status `running`, by the read order in the Contract. The driver writes `run.json` by rename (v04, AC-3),
  so `run.json` is never half-written; a call file can be (AC-10).
- **AC-21:** WHEN a run has `costUnknownCalls` k > 0, THE SYSTEM SHALL add ` · <k> unknown` to its cost, and the
  totals SHALL add the unknown-cost part of the `cost:` line (v04, AC-62). Unknown cost SHALL never count as $0
  in silence.
- **AC-22:** WHEN text output holds a value from a file or a folder name (a run id, a folder name, a call file
  name, `stage`, `mode` or a step), THE SYSTEM SHALL print each control character in it (U+0000 to U+001F,
  U+007F to U+009F) as `?`, so one run stays one line and no terminal code is sent. JSON output keeps the value
  as it is; JSON escapes it.
- **AC-23:** WHEN the human answered `c` at gate:limit, THE SYSTEM SHALL count that stop once: the `cancel`
  record is the stop, and `next` (still `gate:limit`) adds no open stop. WHEN a run waiting at gate:limit was
  cancelled with `run --cancel`, which adds no record, the open stop SHALL count once, with the kept
  `limitReason`.
- **AC-24:** WHEN a `cancelled` run's last `steps` entry is a gate entry with no `end` (`run --cancel` on a
  waiting run does not close it), THE SYSTEM SHALL count that entry as 0 seconds, without a warning. This is a
  normal v04 state, not a broken file.

## Non-functional requirements

- `run --stats` over 100 run folders with 40 call files of about 20 KB each (fixture) ends in under 3 s on the
  developer's laptop. A vitest test builds that fixture and fails above 3 s.

## Out of scope

- Grouping by month or by harness version (`.claude/.harness.json`): later, at about 30 runs.
- `usage --save` reading the `--json` output: a later stage; this stage only fixes the shape.
- Keeping a limit reason in every `gate:limit` record: a v04 change. Until then such stops show as `unknown`
  (AC-14).
- The waiting time of a gate a run was cancelled at by `run --cancel`: v04 does not close that entry, so it
  counts as 0 (AC-24). Closing it is a v04 change.
- A call killed after its result came: its call file holds a result object, so it shows the outcome `classify`
  gives, not `killed`. A call whose process never started (spawn failure) has no exit code, so it shows as
  `killed`. The call file does not keep the driver's own kind.
- The driver's `parse*` step after `ok` (`src/run/engine/call.ts`) can still turn an `ok` call into a schema
  re-run. Run stats does not repeat it, so such a call shows as `ok`; the re-run shows as its own call.
- First pass counts attempts only. A task the human helped at gate:limit without a new attempt (a test-conflict
  answer, an allowed test change) still counts as first pass.
- Runs of other repos, or of a different `.claude/tmp/` location.
- Defects: `run --stats` counts runs, not defects; the defect log stays human-written.
- Any filter (`--since`, `--mode`) or sorting option.

## How to verify

```bash
pnpm test -- -t "stats1 AC-"      # every criterion of this spec, with fixture run folders (no real claude)
pnpm test                         # the v04 tests stay green
pnpm typecheck
.claude/bin/trace --terms stats1
# Manual: on this repo
pnpm build && node bin/cli.mjs run --stats && node bin/cli.mjs run --stats --json | jq .version
git status --porcelain            # the same before and after: run stats changed nothing
```

## Changes

- 2026-11-25 — Decisions ("Fixed `--json` shape"), Contract (text `calls:` line, JSON `version`, `byRole`), AC-5,
  AC-7, AC-19: scout1. Why: a task run now has a sixth role, the scout, so `byRole` gains `scout` and a call file
  `<n>-scout.json` is valid. The shape changed, so `version` rises from 1 to 2 (the spec's own rule: a later
  change to this shape raises `version`).
