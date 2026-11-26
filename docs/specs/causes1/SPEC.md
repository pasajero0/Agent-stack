---
stage: causes1
---

# The defect log counts defects by cause

## Purpose

After this stage the maintainer runs `pnpm defects` and sees which causes of defects repeat, how often, and
whether a test guards them. CI fails when a cause has 3 or more rows with no test and no planned check.

What exists today:
- `docs/defects.md` has one table of 57 rows (`docs/defects.md:15-73`) with a `Class` column of six wide classes
  (`dup`, `unverified`, `slip`, `design`, `env`, `process`);
- a class hides repeats: #43 (`env`), #50 (`env`) and #56 (`design (driver)`) have one cause, the driver counting an
  unrelated red test as a failed attempt; #56 itself says "Third time for this cause". The `env` summary
  (`docs/defects.md:90-112`) found six rows of one cause only by hand, after they were logged under `design`;
- CONTRIBUTING → Defects says "A class that repeats gets a check", and nothing counts the repeats;
- nothing in CI reads the log.

This stage adds a `Cause` column, a script that counts it, the rule in the glossary entry Cause, a short pointer to
it in CONTRIBUTING, and a CI step.

## Decisions

No ADR: the change is a project document, a dev script and one CI step. The maintainer decided these in the grill
(2026-11-26):
- **One cause per row:** the cause that repeats in different places, not the place that broke (the human,
  after the first draft). For #43, #50 and #56 it is `driver-counts-unrelated-red`. A second cause stays as words
  in the row's text, as now.
- **A tested row:** its `Test` cell is not `—` and does not start with `planned` in any letter case. A **planned check** is written in
  the `Test` cell as `planned: <version>` (`planned: 0.5.3`). For `--check` it closes the cause; it is not counted
  as a test. Writing `planned: …` is the only change this stage makes to an old cell, and only where the cell is `—` now.
- **CI runs `pnpm defects --check`**, as a step after `pnpm test:fast`. A cause that fails `--check` on the day of
  this change gets `planned: 0.5.3` in the `Test` cell of its newest row. `.claude/tmp/roadmap-plan.md` is not
  changed: the maintainer keeps it.
- **`docs/defects.md` is the one log.** `.claude/tmp/defects.md` (gitignored; today a 3-line stub that points to
  `docs/defects.md`) is not changed; the maintainer may delete it by hand.
- **The old summaries stay** (the sections "## Summary (20/11, 22 defects)" and "## The `env` class …") as history,
  unchanged. The header gets one
  paragraph `**Cause:**` that explains the column and names `pnpm defects`.
- **The word Cause is in `docs/GLOSSARY.md` → Ideas**, with the rule "a cause that repeats gets a check".
- **The rule lives in one place: the glossary entry Cause** (the human, after the first draft). It holds the one
  cause per row, the 2-row and 3-row steps, the form of a planned check, and the two sentences on why the log
  counts causes. CONTRIBUTING → Defects only points to that entry and names `pnpm defects`; it does not repeat the
  rule. The CONTRIBUTING bullet "A class that repeats gets a check, not more text" is removed: the glossary entry
  replaces it, and keeping both would write one rule in two places (`rule-in-two-places`).
- **#50 is `driver-counts-unrelated-red`** (the human): #56 already calls itself the third case of this cause. So
  this cause has 3 rows (#43, #50, #56) and no tested row, and #56, its newest row, gets `planned: 0.5.3` in its
  `Test` cell (now `—`). No other cause fails `--check` today, so no other cell gets `planned`.
- **#54, #55 and #57 are `harness-part-not-tested-with-sandbox`** (the human): the cause that repeats, not the
  place that broke. The name `temp-file-outside-tmpdir` is not used. No earlier row of the log has this cause: the
  two earlier cases that #54 and #57 name (the `Read(...)` rules and the package cache) have no row in the log.
- **A `Test` cell that says "no test" in a wrong form is a row error, exit 2** (the human): empty, a bare `-`, an en
  dash `–` (U+2013), `no` or `n/a` (AC-16). The one form of "no test" is `—` (U+2014).
- **The first paragraph of `docs/defects.md`** ("One line per defect … a defect that comes back is a missing
  check.") stays as it is (the human).

From the task description:
- Use these names where they fit: `test-depends-on-machine`, `driver-counts-unrelated-red`,
  `harness-part-not-tested-with-sandbox`, `guard-bash-false-positive`, `rule-in-two-places`. New causes get new
  names; many different causes never share one wide name. (`temp-file-outside-tmpdir`, also in the description,
  is dropped by the human's decision above.)
- `Class` and every other cell stay as they are.

Added by this spec (for the human to confirm):
- **The cause of every row** is in the table under Contract → "Causes of the existing rows". The spec writer read
  every row. `guard-bash-false-positive` fits no row today, so it is not used.
- **`<version>`** in a planned check is three numbers, `^[0-9]+\.[0-9]+\.[0-9]+$`. A `Test` cell that starts with
  `planned` in any letter case and has any other form is an error (AC-16), so a typo of `planned` never counts as a
  test. Other text (`yes`, `yes (text)`, a file path, any other words) counts as tested; review catches a wrong one.
- **The output has a `planned` column** next to `tested`, so the maintainer sees which cause is open only on a
  planned check.
- **Exit codes:** 0 ok, 1 a `--check` failure, 2 the log cannot be read or counted.
- **`--file <path>`** reads another log; the tests use it with fixtures.

## Terms

Shared words are defined in [docs/GLOSSARY.md](../../GLOSSARY.md): cause. Below is only what this spec
makes precise.

- **Cause** — as in the glossary: one kebab-case name per row of the defect log.
- **Defect log** (local): `docs/defects.md`, and in it only the first table whose header row has the columns `#`,
  `Date`, `Cause` and `Test`. The other tables of the file are not read.
- **Release plan** (local): the list of work for the next release. The maintainer keeps it; today it is
  `.claude/tmp/roadmap-plan.md`, which is not in git. Not a *plan* of the glossary (`tasks.json`).
- **Row** (local): one line of the defect log's table after the header and the separator line.
- **Tested row** (local): a row whose `Test` cell, trimmed, is not `—` (U+2014) and does not start with `planned` in any
  letter case. (A cell that is empty, `-`, `–`, `no` or `n/a`, or a malformed `planned` cell, is an error, AC-16.)
- **Planned check** (local): a `Test` cell of the form `planned: <version>`, `<version>` matching
  `^[0-9]+\.[0-9]+\.[0-9]+$`, e.g. `planned: 0.5.3`.
- **Failing cause** (local): a cause with 3 or more rows, no tested row and no row with a planned check.

## Model and state transitions

A cause's state, by its rows (`docs/GLOSSARY.md` → Cause holds the rule):

| State | Event | New state | Criterion |
| --- | --- | --- | --- |
| 1 row | a new row with the same cause | 2 rows: a check goes into the release plan | AC-20, AC-23 |
| 2 rows, no tested row, no planned check | a third row | failing: `--check` exits 1 | AC-9 |
| failing | a row gets a test, or a `Test` cell `—` becomes `planned: <version>` | closed: `--check` exits 0 | AC-10 |

## Contract

### `docs/defects.md`

- The table header becomes
  `| # | Date | Defect | Found by | Class | Cause | Escaped? | Closed by | Test |`: `Cause` right after `Class`.
- Every row gets its cause in that column, from the table below. No other cell changes, except one: the `Test`
  cell of row #56 changes from `—` to `planned: 0.5.3` (Decisions). The first paragraph of the file and the two
  summary sections stay as they are.
- One new paragraph after the `**Found by:**` paragraph, exactly (wrapped like the paragraphs around it):

  ```markdown
  **Cause:** why the defect happened, as a short kebab-case name (see `docs/GLOSSARY.md` → Cause); the same name
  for every row with that cause. `pnpm defects` counts the rows by cause.
  ```

### Causes of the existing rows

| Cause | Rows | Tested rows |
| --- | --- | --- |
| `rule-in-two-places` | 8, 15, 16, 18, 19, 20, 27, 34, 41 | 7 |
| `test-depends-on-machine` | 6, 13, 45, 52, 53 | 3 |
| `driver-counts-unrelated-red` | 43, 50, 56 | 0 (planned 1: #56) |
| `harness-part-not-tested-with-sandbox` | 54, 55, 57 | 3 |
| `dependency-change-unguarded` | 1, 3 | 2 |
| `platform-not-checked-live` | 10, 12 | 1 |
| `conclusion-from-partial-read` | 22, 44 | 0 |
| `test-passes-for-wrong-reason` | 23, 30 | 2 |
| `block-hits-legitimate-input` | 24, 40 | 2 |
| `retry-takes-no-comment` | 39, 51 | 0 |
| `task-can-edit-check-config` | 2 | 1 |
| `commit-not-gated-on-test` | 4 | 0 |
| `merge-method-not-enforced` | 5 | 0 |
| `answer-reaches-wrong-gate` | 7 | 1 |
| `skill-text-not-run-live` | 9 | 1 |
| `instruction-names-no-repo` | 11 | 0 |
| `driver-run-under-monitor` | 14 | 1 |
| `staged-files-survive-refused-commit` | 17 | 0 |
| `repo-config-incomplete` | 21 | 0 |
| `hook-bypassed-through-bash` | 25 | 0 |
| `stage-read-from-branch-only` | 26 | 1 |
| `outside-input-unchecked` | 28 | 0 |
| `answer-dropped-silently` | 29 | 1 |
| `zero-tests-read-as-pass` | 31 | 0 |
| `message-misleads` | 32 | 0 |
| `implementer-writes-files-through-bash` | 33 | 1 |
| `size-limit-invites-squeezing` | 35 | 1 |
| `child-process-without-timeout` | 36 | 1 |
| `check-timeout-stops-run` | 37 | 0 |
| `answer-states-unchecked-fact` | 38 | 0 |
| `watch-redraws-into-scrollback` | 42 | 0 |
| `new-config-key-breaks-old-run` | 46 | 0 |
| `implementer-runs-full-suite` | 47 | 0 |
| `evals-run-before-version-bump` | 48 | 0 |
| `child-processes-outlive-call` | 49 | 0 |

35 causes, 57 rows; each of #1–#57 is in exactly one line. The order of this table is not the output order
(AC-5). The "Tested rows" column follows from today's `Test` cells; the script computes it, this table
only shows what it should print.

### `scripts/defect-causes.mjs`

Plain Node ESM, built-ins only, a header comment, the style of `scripts/eval.mjs`. Run as
`node scripts/defect-causes.mjs [--check] [--file <path>]`, or `pnpm defects [--check]`.

- **Input:** `docs/defects.md` relative to the repo root (found from the script's own path), or `--file <path>`.
- **Parsing:** the table starts at a header line with the four columns, followed by a separator line: a line
  starting with `|` whose every cell matches `^:?-+:?$` after trimming (`|---|` and `| --- |` both count). A header
  with no separator line after it is not a table. Columns are found by their header names, not by position. The
  cells of a line are the parts between its first and its last unescaped `|`; an escaped `\|` stays inside the cell
  as `|`, without the backslash. Cells are trimmed. So a row with no closing `|` has one cell fewer and is an
  AC-16 error. A row with the wrong number of cells gets only that error line, no other.
- **Options:** `--check` may repeat; `--file` may repeat, and the last one wins. The argument after `--file` is
  always its path, even when it starts with `--` (`--file --check` reads a file named `--check`).
- **Output (stdout), every run that exits 0 or 1:** a header line, then one line per cause, six fields:

  For a log whose only cause is `rule-in-two-places`:

  ```text
  cause               count  last   tested  planned  rows
  rule-in-two-places      9  25/11       7        0  8,15,16,18,19,20,27,34,41
  ```

  The header words are exactly `cause`, `count`, `last`, `tested`, `planned`, `rows`. Each column is padded to its
  widest value or header word; columns are joined by two spaces. `cause`, `last` and `rows` are left-aligned,
  `count`, `tested` and `planned` right-aligned; trailing spaces are removed. The tests split a line on `/\s{2,}/`
  and check the field values and the line order, not the widths. `last` is the `Date` cell of the cause's row with
  the highest `#`. `rows` lists the `#` values in ascending order, joined by `,` with no spaces. Lines are sorted
  by count, highest first; equal counts by cause name, compared by UTF-16 code unit (`<`, not `localeCompare`).
- **`--check`:** after the table, one line on stderr per failing cause, in the order of AC-5 (the printed table):
  `defect-causes: <cause> has <n> rows and no test or planned check (rows <list>)`, `<list>` being the same
  `,`-joined list as the `rows` column; then exit 1. With no failing cause it prints `defect-causes: check ok` on
  stdout and exits 0.
- **Errors:** lines on stderr, each starting `defect-causes: `, then exit 2. No table is printed. The exact texts
  are in AC-14 to AC-16 and AC-18.
- **In messages:** `<path>` is the `--file` argument as given, or `docs/defects.md` for the default. Line numbers
  start at 1.
- **Usage line:** `usage: node scripts/defect-causes.mjs [--check] [--file <path>]`.
- **Exports** for the tests:
  - `parseLog(text)` → `{ rows, errors, noTable }`: `rows` is a list of `{ n, date, cause, test }` (`n` a number,
    the rest trimmed strings); `errors` is a list of the AC-16 messages, empty when the log is good; `noTable` is
    `true` when there is no defect log table, and then `main` writes the AC-15 line.
  - `countCauses(rows)` → the sorted list of `{ cause, count, last, tested, planned, rows }` (`rows` a list of
    numbers).
  - `failingCauses(counts)` → the entries of that list that are failing causes, in the same order.
  - `main(argv, readFile)` → `{ stdout, stderr, code }`. `argv` excludes `node` and the script path. `readFile` is
    `(path: string) => string` and throws when the file cannot be read; `main` turns the throw into AC-14.
  - The file runs `main` with `node:fs` `readFileSync` only when it is the entry script, writes `stdout` and
    `stderr`, and sets `process.exitCode`. It uses no API newer than Node 18 (no `import.meta.dirname`).

### Other files

- `package.json` → `scripts`: `"defects": "node scripts/defect-causes.mjs"`.
- `.github/workflows/ci.yml`: a step `- run: pnpm defects --check` right after `- run: pnpm test:fast`.
- `CONTRIBUTING.md` → Defects: a pointer to the glossary entry Cause and the command `pnpm defects` (AC-19).
- `CHANGELOG.md` → `## 0.5.2 — unreleased`: one bullet (AC-21).
- `docs/GLOSSARY.md` → Ideas: the entry **Cause**, the one place of the rule (added with this spec, AC-20).

## Constraints

- **Must not:** add a dependency, a build step for the script, or TypeScript for it. Check: `package.json`
  `dependencies` and `devDependencies` unchanged in the diff; the script imports only `node:` modules (review).
- **Must not:** change a cell of `docs/defects.md` other than the new `Cause` column, the header line, and the
  `Test` cell of #56 (`—` → `planned: 0.5.3`). Check: the command in How to verify, step 3.
- **Must not:** change the first paragraph or the two summary sections of `docs/defects.md`. Check: How to
  verify, step 3 (a changed or removed line); review of the diff (an added line there).
- **Must not:** write the cause rule anywhere but `docs/GLOSSARY.md` → Cause. Check: the AC-19 test for
  CONTRIBUTING; review for the rest (the CHANGELOG bullet, the `**Cause:**` paragraph, the script's header comment).
- **Must not:** change `.claude/tmp/roadmap-plan.md` or `.claude/tmp/defects.md`. They are not in git, so
  `git diff` cannot show them. Check: review (no task names them), and `shasum` of both files before and after the
  run.
- **Must keep:** the existing tests green, among them `tests/claude/changelog-effort1.test.ts` (it reads row #41
  of `docs/defects.md` and the CHANGELOG). Check: `pnpm test`.
- **Must keep:** the tests that run no process in the fast group: `tests/scripts/defect-causes.test.ts` (the
  script's functions and the real files). The one that spawns `node`, `tests/scripts/defect-causes-cli.test.ts`,
  goes into `SLOW` in `vitest.config.ts` (CONTRIBUTING → Tests). Check: review of `vitest.config.ts`.
- **Must not:** a test that asserts on elapsed time (defects #43, #50). The spawned test gives `spawnSync` a
  15 s `timeout` only as a guard against a hang (#36), below the slow group's 20 s `testTimeout`, so the guard
  fires first and names the hang. Check: review.
- **When goals conflict:** a correct count > a short output > speed.

## Acceptance criteria (EARS)

### Happy path

- **AC-1:** THE SYSTEM SHALL have in `docs/defects.md` a table header with the columns `#`, `Date`, `Defect`,
  `Found by`, `Class`, `Cause`, `Escaped?`, `Closed by`, `Test`, in that order. Every row has a non-empty kebab-case `Cause`
  (`^[a-z0-9]+(-[a-z0-9]+)*$`); rows #1–#57 have the cause given in Contract → "Causes of the existing rows".
  Among rows #1–#57, only #56 has a planned check: its `Test` cell is `planned: 0.5.3`.
- **AC-2:** THE SYSTEM SHALL have in `docs/defects.md`, after the `**Found by:**` paragraph, one paragraph (up to
  the next blank line) starting `**Cause:**` that names `pnpm defects` and `docs/GLOSSARY.md`.
- **AC-3:** WHEN `parseLog` reads a log, THE SYSTEM SHALL return one row per table line with `n` (the number in
  `#`), `date`, `cause` and `test` taken from the cells of those headers, wherever the columns stand.
- **AC-4:** WHEN `countCauses` gets rows, THE SYSTEM SHALL return one entry per cause with `count`, `last` (the
  `date` of its row with the highest `n`), `tested` (the number of tested rows), `planned` (the number of rows with
  a planned check) and `rows` (the `n` values, ascending).
- **AC-5:** WHEN `countCauses` returns entries, THE SYSTEM SHALL sort them by `count`, highest first, and equal
  counts by cause name, compared by UTF-16 code unit (`<`).
- **AC-6:** WHEN the script runs without `--check`, THE SYSTEM SHALL print the header line and one line per cause in
  the order of AC-5, in the format of the Contract, and exit 0.
- **AC-7:** WHEN a `Test` cell is `yes`, `yes (text)` or a file path, THE SYSTEM SHALL count the row as tested; WHEN
  it is `—` or a planned check, THE SYSTEM SHALL not.
- **AC-8:** WHEN the script runs with `--check` and no cause is failing, THE SYSTEM SHALL print the table, then
  `defect-causes: check ok`, and exit 0.
- **AC-9:** WHEN the script runs with `--check` and a cause has 3 or more rows, no tested row and no planned check,
  THE SYSTEM SHALL print the table, then on stderr
  `defect-causes: <cause> has <n> rows and no test or planned check (rows <list>)` for each such cause, and exit 1.
  A spawned `node scripts/defect-causes.mjs --check --file <fixture>` has the process exit code 1.
- **AC-10:** WHEN a cause has 3 or more rows and either at least one tested row, or no tested row and at least one row whose `Test`
  cell is a planned check (e.g. `planned: 0.5.3`), THE SYSTEM SHALL not name it under `--check`. A planned row SHALL count in `planned`,
  not in `tested`.
- **AC-11:** WHEN `--file <path>` is given, THE SYSTEM SHALL read that file instead of `docs/defects.md`. WHEN
  `--file` is given twice, THE SYSTEM SHALL read the last path; WHEN `--file` is followed by `--check`, THE SYSTEM
  SHALL read a file named `--check`; WHEN `--check` is given twice, THE SYSTEM SHALL act as with one.
- **AC-12:** THE SYSTEM SHALL have `"defects": "node scripts/defect-causes.mjs"` in `package.json` → `scripts`.
- **AC-13:** THE SYSTEM SHALL have in `.github/workflows/ci.yml` the step `- run: pnpm defects --check` right after
  the step `- run: pnpm test:fast`.

### Unhappy path

- **AC-14:** IF the file cannot be read, THEN THE SYSTEM SHALL print `defect-causes: cannot read <path>` on stderr
  and exit 2; IF `--file` is the last argument, with no path after it, THEN THE SYSTEM SHALL print
  `defect-causes: --file needs a path` on stderr and exit 2 (partner of AC-6, AC-11). Arguments are read left to
  right; the first wrong one (AC-14, AC-18) gives the only error, and the file is not read.
- **AC-15:** IF the file has no table whose header has `#`, `Date`, `Cause` and `Test`, THEN THE SYSTEM SHALL print
  `defect-causes: no table with the columns #, Date, Cause and Test in <path>` on stderr and exit 2 (partner of
  AC-3).
- **AC-16:** IF a row is wrong, THEN THE SYSTEM SHALL print one stderr line per problem and exit 2, with or without
  `--check` (partner of AC-3, AC-4, AC-7). `<where>` is `row <#>`, `<#>` printed as a number (`row 7` for `07`),
  or `line <line number in the file>` when the `#` is not a number. The lines come in the order of the file's
  lines; the duplicate-`#` lines come after them, in ascending `#`. Within one row, the lines come in the order of
  this list. A row whose `#` is not a number is still checked for `Date`, `Cause` and `Test`. A row with the wrong
  number of cells is not used for the duplicate check. The problems and their texts:
  - `defect-causes: <where>: <k> cells, the header has <h>` — the number of cells differs from the header's;
  - `defect-causes: line <line>: # is not a number` — the `#` cell does not match `^[0-9]+$` (`+3`, `3a`);
  - `defect-causes: <where>: Date is empty` — the `Date` cell is empty;
  - `defect-causes: <where>: Cause is empty` — the `Cause` cell is empty;
  - `defect-causes: <where>: Cause "<text>" is not kebab-case` — a non-empty cell that does not match
    `^[a-z0-9]+(-[a-z0-9]+)*$` (an empty cell gets only the line above);
  - `defect-causes: <where>: Test "<text>" is not a test; write — or a test` — the `Test` cell, trimmed, is empty,
    `-`, `–` (U+2013), or `no` or `n/a` in any letter case (`<text>` is the trimmed cell, `""` when empty);
  - `defect-causes: <where>: Test "<text>" is not "planned: <version>"` — the cell starts with `planned` in any
    letter case (`/^planned/i`) and does not match `^planned: [0-9]+\.[0-9]+\.[0-9]+$` exactly;
  - `defect-causes: row <#>: # is used by another row` — a `#` that two or more rows share; `#` values compare as
    numbers, so `07` and `7` are the same `#` (one line per such `#`, after all other lines).
- **AC-17:** IF the real `docs/defects.md` has a failing cause, THEN THE SYSTEM SHALL fail `pnpm defects --check`
  in CI. On the day of this change it SHALL pass: the one cause that would fail, `driver-counts-unrelated-red`
  (#43, #50, #56), has `planned: 0.5.3` in #56 (AC-1). A fast test reads the real file with `parseLog`: no errors, at least 57 rows, every
  `cause` non-empty. It does not assert "no failing cause": that is the CI step's job, so a failure prints the
  cause by name (partner of AC-1, AC-9, AC-13).
- **AC-18:** IF an argument other than `--check` and `--file <path>` is given, THEN THE SYSTEM SHALL print
  `defect-causes: unknown option <arg>` and the usage line on stderr, and exit 2 (partner of AC-6).

### Documents

- **AC-19:** THE SYSTEM SHALL have in `CONTRIBUTING.md` → Defects, next to the classes, in place of the bullet "A
  class that repeats gets a check, not more text", one bullet that says: every row names its cause; the rule for
  causes is in `docs/GLOSSARY.md` → Cause (a link); `pnpm defects` counts the rows by cause. The intro sentence of
  the section also lists "its cause" among the cells. The section SHALL not repeat the rule. A fast test reads
  the Defects section and finds `Cause`, `GLOSSARY.md` and `pnpm defects` in it, and none of `A class that
  repeats`, `2 rows`, `3 rows` and `planned:`.
- **AC-20:** THE SYSTEM SHALL have in `docs/GLOSSARY.md` → Ideas an entry with the headword **Cause** that holds the
  whole rule: one cause per row, the cause that can repeat in other places, not the place that broke; at 2 rows a
  check goes into the plan of the next release; at 3 rows with no test and no planned check (`planned: <version>`
  in the `Test` cell) `pnpm defects --check` fails in CI and the release does not merge. It SHALL explain in two
  sentences why the log counts causes: one cause can show in several places, and the count of repeats sets the
  priority. A fast test finds the line `- **Cause** —` under `## Ideas`, and in that entry `2 rows`, `3 rows`,
  `planned: <version>` and `pnpm defects --check`.
- **AC-21:** THE SYSTEM SHALL have under `## 0.5.2 — unreleased` in `CHANGELOG.md` one bullet that names the
  `Cause` column, `pnpm defects` and its `--check` step in CI. A fast test finds all three in the 0.5.2 entry.

### Edge cases

- **AC-22:** WHEN the table has a header and no rows, THE SYSTEM SHALL print only the header line and exit 0; with
  `--check` it SHALL print `defect-causes: check ok` and exit 0.
- **AC-23:** WHEN a cause has exactly 2 rows and no tested row, THE SYSTEM SHALL not name it under `--check` (the
  rule asks for a check in the next release plan, which a human writes).
- **AC-24:** WHEN the file holds other tables after the defect log's table (the summaries), THE SYSTEM SHALL read
  only the defect log's table, and SHALL stop at the first line after it that does not start with `|`.
- **AC-25:** WHEN a cell holds an escaped `\|`, THE SYSTEM SHALL keep it inside that cell, as `|` without the
  backslash.

## Non-functional requirements

- The script reads the 57-row log and prints in under 1 s on the maintainer's machine, checked once by hand with
  `time pnpm defects` (no test with a time limit: defects #43, #50).
- The script has 0 dependencies outside `node:` modules (review of its imports). It runs on Node 18, the `engines`
  floor in `package.json`: CI runs Node 22 only, so review checks that it uses no API newer than Node 18.

## Out of scope

- Checking that a planned version is still in the future (a `planned: 0.5.3` that stays after 0.5.3 is released).
  Later, if a planned check is seen to stay forever.
- More than one cause per row (grill).
- Changing `Class`, the old summaries, `.claude/tmp/defects.md` or `.claude/tmp/roadmap-plan.md`.
- The first paragraph of `docs/defects.md` ("Goal … see which classes repeat") stays as it is, as history; the new
  `**Cause:**` paragraph says how the log counts now.
- Writing the checks themselves: for `driver-counts-unrelated-red` (planned for 0.5.3), and for the causes with 2
  rows (`retry-takes-no-comment`, `conclusion-from-partial-read`, …). The rule puts them into the release plan,
  which the maintainer keeps.
- New rows for the two earlier `harness-part-not-tested-with-sandbox` cases that #54 and #57 name (the `Read(...)`
  rules, the package cache): they have no row today, and this stage adds no row.
- Words other than `no` and `n/a` that mean "no test" (`none`, `no test`): they count as tested; review catches
  them.
- A check that a new row's cause is not a near duplicate of an existing name (`rule-in-2-places`): review catches it.
- `CODEMAP.md`: it is git-excluded in this repo, so the change does not touch it.
- Branch protection: a red CI check stops a merge only if the `check` job is required on GitHub. That is the
  maintainer's repo setting; this stage does not check or change it.

## How to verify

```bash
# 1. The criteria, by id (the fast file and the spawned one)
pnpm vitest run -t "causes1 AC-"

# 2. The real log, the counts and the CI step
pnpm defects
pnpm defects --check; echo "exit $?"          # exit 0

# 3. No other cell changed: drop the Cause cell (only in 9-column rows) and planned cells, then print every
#    line of the file before this stage that is no longer there. The base is the commit that added this spec
#    (it does not touch docs/defects.md). Expected output: "same".
BASE=$(git log --diff-filter=A --format=%H -1 -- docs/specs/causes1/SPEC.md)
BASE=$BASE node -e '
const {execSync}=require("child_process"),fs=require("fs");
const now=fs.readFileSync("docs/defects.md","utf8").split("\n").map(l=>{const c=l.split("|");
  if(l.startsWith("|")&&c.length===11)c.splice(6,1);return c.join("|").replace(/\| planned: [0-9.]+ \|$/,"| — |")});
const old=execSync("git show "+process.env.BASE+":docs/defects.md").toString().split("\n");
const gone=old.filter(l=>!now.includes(l));console.log(gone.length?gone:"same")'

# 4. Terms and the whole suite
.claude/bin/trace --terms causes1
pnpm typecheck && pnpm test

# 5. NFR, once by hand
time pnpm defects
```

## Changes

None yet.
