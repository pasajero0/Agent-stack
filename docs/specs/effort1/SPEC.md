---
stage: effort1
---

# Route the implement call's model and effort from tier × complexity

## Purpose

After this stage the driver picks the model **and** the effort level of each implement call from two task
parameters: the tier (S / M / L, as now) and a new complexity (low / medium / high). The mapping is data in
`.claude/gates.json → routing`, which a human can read and change. The driver passes `--model` and `--effort` to
`claude`.

What exists today:
- the driver picks only the model of implement: Opus for tier L, a risky task, a fix task and every attempt after
  the first, else Sonnet (`src/run/engine/steps-implement.ts:26`, v04 AC-16);
- a task is risky only at tier S or M (`src/run/engine/steps-plan.ts:29`, v04 AC-13);
- the driver never passes `--effort`, so every call runs at Claude Code's default level. The `/plan` skill still
  says tier S runs at "low effort": defect #41 in `docs/defects.md`. This stage closes it;
- the mapping is written in several places: the code, the `/plan` skill table, the glossary entry Tier,
  `templates/claude/_normative.md`, the implementer agent's description and the `verify` hint (AC-22 lists them).

This stage changes v04 AC-13 and AC-16 (both are edited to point here, AC-27) and adds two eval tasks to the
evals1 set (AC-25).

## Decisions

| ADR | Decided | What it means here |
| --- | --- | --- |
| [0001](../../adr/0001-pipeline-driver.md) | 2026-11-18 | The driver holds the order and the rules; the route is chosen by the driver, never by a role |

Leonid decided these in the grill (2026-11-25):
- **Fix tasks** (`F<k>`, task and quick mode) use the retry route. Today they run on Opus; a fix task counts as a
  later attempt.
- **Order of the route choice:** the retry route first (an attempt after the first, or a fix task), then the risky
  route, for **every** tier, then the cell of tier × complexity. Risky now covers tier L too: L·low is
  sonnet·medium, so a risky L task would lose Opus.
- **Tier L and splitting.** The plan step splits an L task with logic into blocks when each block can leave the
  tree green (expand-contract: add the new beside the old, move the code block by block, remove the old). It may
  keep one L task when the change is atomic (a state in between does not build or pass) or purely mechanical (a
  rename across many files). Then complexity comes from the logic, not the number of files: an atomic mechanical
  rename is L·low. Every L task has a required `splitReason`.
- **Old plans:** a `tasks.json` without `complexity` (a run started on 0.4.7) is refused, never given a default.
- **Only implement and the scout** get a route (scout1). clarify, spec, plan and review keep their model and get no `--effort`.
- **The plan-approve card** shows the route of the first attempt after the risky route is applied, and keeps the
  `· risky` mark.

From the task description:
- No route in TypeScript code. The one source of the default routing block is the template the harness deploys.
  The `/plan` skill and the glossary only point to `gates.json → routing`.
- Quick mode has no plan: Q1 uses the cell M·medium, unless `--cell` names another cell (below).

Leonid accepted these at the spec review (2026-11-25):
- **Where the default lives:** `templates/claude/_routing.json`, a data file. A name starting with `_` is
  generator input and is not deployed (`src/claude/harness.ts:402`). `generate` and `update` both read it, so
  there is no second copy.
- **The complexity rule in the `/plan` skill:** high when question 4 is yes; else medium when question 2 or 3 is
  yes, or question 1 is no; else low. A task with no pattern to copy is never low.
- **The limit gate's retry answers** name the retry route (`retry (a new attempt, opus · high)`), not "on Opus",
  because the human may change the retry route.

Leonid changed this one at the spec review (2026-11-25):
- **The two new eval tasks test their own cells**, not M·medium. `run quick` gets a flag `--cell <tier>·<complexity>`
  (e.g. `--cell L·low`): Q1 then uses that cell instead of M·medium. Without the flag quick mode stays on M·medium.
  An eval `task.json` gets an optional `cell`; the eval runner passes it to `run quick` as `--cell`. `rename-many`
  has cell L·low and expects sonnet · medium; `auth-boundary` has cell S·high and expects opus · high.

Added by this spec to make that work (for the human to confirm):
- **The run file keeps the cell** in a new optional field `cell`. A quick run that stops at a gate and resumes must
  still use its cell, and `--resume` takes no `--cell`. This is the one exception to "no new run file field"
  (Constraints). A run file without `cell` reads as `null`, as `estimateSec` does (v04 AC-81).

## Terms

Shared words are defined in [docs/GLOSSARY.md](../../GLOSSARY.md): tier, complexity, route, routing, effort, plan,
task, attempt, driver, run, mode, role, gate, limit gate, eval task. Below is only what this spec makes precise.

- **Tier** — as in the glossary: S, M or L. Not the glossary's *size* (task, story, epic).
- **Complexity** — as in the glossary: low, medium or high, set by the plan step per task.
- **Route** — as in the glossary. Written `<model>·<effort>` in `gates.json` (no spaces, `·` is U+00B7) and
  `<model> · <effort>` in what the driver prints.
- **Routing** — as in the glossary: the `routing` object in `.claude/gates.json`.
- **Effort** — as in the glossary: the value of `claude --effort`.
- **Cell** (local): one of the 9 entries `routing.<tier>.<complexity>`, e.g. `routing.L.low`. Named on the command
  line and in an eval `task.json` as `<tier>·<complexity>`, e.g. `L·low`.
- **Quick cell** (local): the cell Q1 uses: the one `run quick --cell` named, kept in the run file as `cell`, or
  M·medium when there is none.
- **Retry route** (local): `routing.retry`.
- **Risky route** (local): `routing.risky`.
- **Risky task** (local): a plan task whose `desc` or one of whose criterion texts holds a risk word (v04 Terms
  "Risk words", unchanged), at any tier. Q1 and fix tasks are never risky.
- **Split reason** (local): `splitReason` of an L task in the plan: one line on why the task is not split.
- **Default routing** (local): the content of `templates/claude/_routing.json`.
- **Fix task** (local): a task `F<k>` that the driver makes from a reject at gate:accept (v04 AC-22, AC-25), in task
  or quick mode.
- **Call file** (local): `calls/<n>-<role>.json` in the run folder, which records the argv of one Claude call (v04).
- **Head line** (local): the line the driver prints when a Claude call starts, `-> <next> · <role> · …` (v04 AC-78).
- **Card line** (local): the line of one task on the gate:plan-approve card (v04 AC-68).

## Model and state transitions

The route of one implement call. The rows are checked in order; the first that fits wins.

| Task | Condition | Route | Criterion |
| --- | --- | --- | --- |
| any | `attempts` > 1, or a fix task `F<k>` | retry route | AC-3 |
| plan task | a risky task | risky route | AC-4 |
| plan task | any other | cell `routing.<tier>.<complexity>` | AC-2 |
| Q1 (quick mode) | the run file's `cell` is set | that cell, e.g. `routing.L.low` | AC-28 |
| Q1 (quick mode) | any other | cell `routing.M.medium` | AC-5 |

The route is chosen again for every implement call. It is never stored in the run file; only the quick cell's name
is (AC-28).

## Contract

**`.claude/gates.json → routing`.** The default routing (`templates/claude/_routing.json`) is exactly:

```json
{
  "S": { "low": "sonnet·low", "medium": "sonnet·medium", "high": "opus·high" },
  "M": { "low": "sonnet·low", "medium": "sonnet·medium", "high": "opus·high" },
  "L": { "low": "sonnet·medium", "medium": "opus·medium", "high": "opus·high" },
  "retry": "opus·high",
  "risky": "opus·high",
  "scout": "haiku·low"
}
```

- A route matches `^(opus|sonnet|haiku)·(low|medium|high|xhigh|max)$`.
- The keys of `routing` are exactly `S`, `M`, `L`, `retry`, `risky`, `scout` (scout1). The keys of a tier object are exactly `low`,
  `medium`, `high`. Any other key is refused, so a typo never passes in silence.

**Routing check messages** (AC-12). The routing check runs after the checks `loadRunConfig` makes today, which stop
at their first error; so a bad `run.fuse` is reported alone, and routing is checked once the rest is valid. The
routing check prints one line per problem, in this order:
1. the cells S.low, S.medium, S.high, M.low … L.high; a tier line (missing, or not an object) stands where its
   three cells would be;
2. `retry`, then `risky`, then `scout`;
3. unknown keys of `routing`, in the file's order;
4. unknown keys of `S`, then of `M`, then of `L`, each in the file's order.

`<got>` is `JSON.stringify` of the value, then each U+007F to U+009F printed as `?`. `<cmd>` is the command name,
as in every other hint (v04 AC-73).

| Problem | Line |
| --- | --- |
| no `routing` key | `gates.json has no routing block. Run <cmd> update to add it (CHANGELOG: Upgrading from 0.4.7).` |
| `routing` is not an object | `gates.json routing must be an object; got <got>. Fix it, or remove the key and run <cmd> update.` |
| `routing.<tier>` is missing | `gates.json routing.<tier> is missing. Add it as an object with low, medium and high.` |
| `routing.<tier>` is not an object | `gates.json routing.<tier> must be an object with low, medium and high; got <got>.` |
| a cell, `retry`, `risky` or `scout` is missing | `gates.json routing.<path> is missing. Add it as "<model>·<effort>".` |
| a value breaks the route pattern | `gates.json routing.<path> must be "<model>·<effort>" (model opus, sonnet or haiku; effort low, medium, high, xhigh or max); got <got>.` |
| an unknown key | `gates.json routing.<path> is not a routing key; remove it.` |

`<path>` is the full path below `routing`, e.g. `L.medium` or `retry`. For an unknown key the key itself is printed
as `JSON.stringify(key)` with the same `?` rule, e.g. `routing.S."extreme"`, so a key with control characters cannot fake a line. A missing tier, or one that is not an object,
gives its own line only, not three cell lines. The last line of the output is `Fix .claude/gates.json, then run
again.` No message holds a route value, so the AC-22 grep of `src/` stays empty.

**`tasks.json` and the plan role's output** gain two fields per task:

```json
{ "id": "T3", "ac": ["AC-4"], "tier": "L", "complexity": "low",
  "splitReason": "rename used by all modules", "desc": "…", "verify": "…", "passes": false }
```

| Field | Rule | Message when it fails |
| --- | --- | --- |
| `complexity` | required, one of `low`, `medium`, `high` | `task <id> needs a complexity of low, medium or high` |
| `splitReason` | required for tier L: a string, not empty after trim, at most 80 characters after trim. The driver writes it to `tasks.json` trimmed. For S and M any value, or none, is accepted and dropped: the driver does not write it to `tasks.json` | `task <id> is tier L and needs a splitReason: why it is not split`; longer than 80: `task <id>: splitReason must be at most 80 characters` |

The plan role's JSON schema (`src/run/schemas.ts`) lists `complexity` in `required` with the enum, and
`splitReason` as an optional string.

**`claude` argv for implement and the scout.** `--effort <effort>` follows `--model <model>` right away; both come
from the route (the scout's from `routing.scout`, scout1). Every other role's argv is as today: no `--effort`, the
same model.

**The call head line** (stdout and `progress.log`) for implement:
`-> implement:T1 · implement · opus · high · call 3/40 ...` (T1 of the card below). Other roles: unchanged.

**The plan-approve card line** of a task:

```text
T1  M · high -> opus · high · AC-1,3   add the cache
T2  S · low -> opus · high · risky · AC-4   check the token expiry
T3  L · low -> sonnet · medium · not split: rename used by all modules · AC-5,6   rename getTotal
```

These are the lines with the default routing. T2 is risky (`token` is a risk word), so the risky route replaces
its cell S·low.

`<id>  <tier> · <complexity> -> <model> · <effort>`, then ` · risky` for a risky task, then
` · not split: <splitReason>` for tier L, then ` · <criteria>   <desc>` as today. In `<splitReason>` every run of
whitespace (newlines included) prints as one space, and each other control character (U+0000 to U+001F, U+007F to
U+009F) prints as `?`.

The card's `source` (v04 AC-68) becomes the sha256 of the `tasks.json` text **and** the 11 route values the
driver read: `sha256(<tasks.json text> + "\n" + <the 11 values joined by "\n">)`, the values in the order S.low,
S.medium, S.high, M.low … L.high, retry, risky. So a routing edit while the gate waits counts as a changed plan (AC-21). The `planSha256` of a reject
record (v04 AC-14) stays the sha256 of the `tasks.json` text alone, so a leftover rejected plan is still found.

**Limit gate answers.** The two labels that say "on Opus" today name the retry route:
`retry with a comment (a new attempt, <model> · <effort>)` and `retry (a new attempt, <model> · <effort>)`, with
the model and effort of `routing.retry`. With the default routing: `(a new attempt, opus · high)`.

**`agent-stack update`** on `.claude/gates.json` (a seed file):

| On disk | What update does | Output |
| --- | --- | --- |
| a JSON object without a `routing` key | adds `routing` with the default routing as the last key; writes `JSON.stringify(…, null, 2)` and a newline | see below |
| a JSON object with a `routing` object that has all six top-level keys | nothing | as today |
| a JSON object with a `routing` object without one or more top-level keys | adds each missing key with its default value (scout1 Contract) | see scout1 |
| a JSON object with a `routing` key that is not an object | nothing | as today |
| not valid JSON | nothing; exit 0 | warning `.claude/gates.json is not valid JSON, so routing was not added. Fix it, then run update again.` |
| valid JSON, not an object | nothing; exit 0 | warning `.claude/gates.json is not a JSON object, so routing was not added. Fix it, then run update again.` |
| missing | as today (created from the template, with routing) | as today |

`--dry-run` prints the same warnings and writes nothing. `--force` changes nothing here: it never rewrites a seed
file, so it neither adds nor replaces `routing` beyond this table.

When update adds routing:
- it prints `added the routing block to .claude/gates.json` right after the `Harness updated:` line;
- the line `  .claude/rules/, .claude/tmp/ and your seed files (CLAUDE.md, gates.json…) were left untouched.` becomes
  `  .claude/rules/, .claude/tmp/ and your seed files (CLAUDE.md, gates.json…) were left untouched, except the routing block added to gates.json.`;
- the totals of `Harness updated:` count gates.json as today (kept as yours); the lines after (edited files,
  extras) are as today;
- a dry run prints `  ~ .claude/gates.json (routing block added)` in place of `  = .claude/gates.json (yours — kept)`.

**`run quick --cell <tier>·<complexity>`.** A new option of `run`, help text
`with run quick: the routing cell Q1 uses instead of M·medium, e.g. L·low`.
- The allowed values are exactly the 9 strings `S·low`, `S·medium`, `S·high`, `M·low`, `M·medium`, `M·high`,
  `L·low`, `L·medium`, `L·high` (`·` is U+00B7, no spaces, case as written).
- The driver checks the flag with the other argument checks of `run` (`src/commands/run.ts`), before AC-1. As
  there, the first problem that fits wins: it prints one line and exits 1, and nothing is written. The rows below are
  in that order, and each sits at the place named:

| Problem | Where among today's checks | Line |
| --- | --- | --- |
| `--cell` with `--resume`, `--status`, `--cancel`, `--watch` or `--stats` | right after the `--json` check, before any action runs | `--cell applies to run quick only.` |
| `--cell` with mode `task` | right after the `--stage` check (so no mode and an unknown mode keep their lines) | `--cell applies to run quick only.` |
| the value is not one of the 9 names | right after the row above | `--cell must be one of S·low, S·medium, S·high, M·low, M·medium, M·high, L·low, L·medium, L·high; got <got>.` |

  `<got>` is `JSON.stringify` of the value, then each U+007F to U+009F printed as `?` (the `splitReason` rule), so
  a value with control characters cannot fake a line. `--cell` with no value is refused by commander, as `--stage`
  with no value is today.
- The allowed values are the names of cells, not routes, so this list in `src/` does not break AC-22 or the first
  Constraint.

**Run file field `cell`.** `"cell": "L·low"`, or `null`. `run quick --cell` writes it when it creates the run
file; every other run writes `null`. A run file without the key reads as `null`. A value that is not `null` and
not one of the 9 names, or any non-null value in a task-mode run, makes the run file malformed (AC-31).

**Eval `task.json → cell`** (evals1 Contract table gains a row):

| Field | Rule | Message when it fails (evals1 AC-8) |
| --- | --- | --- |
| `cell` | optional; one of the 9 names above | `cell: must be one of S·low, S·medium, S·high, M·low, M·medium, M·high, L·low, L·medium, L·high` |

With `cell`, the eval runner starts the try with `node <repo root>/bin/cli.mjs run quick --cell <cell>
<description>` (argv, no shell, as evals1 says). Without it, the command is as today.

## Constraints

- **Must not:** put a route (the `model·effort` value of a cell, `retry` or `risky`) in TypeScript code. The 9 cell
  names (`L·low` …) of `--cell` are allowed in `src/`. `generate` and `update` read
  `templates/claude/_routing.json`. Check: the AC-22 test greps `src/` for `(opus|sonnet|haiku)·`.
- **Must not:** add a dependency, a run file field other than `cell` (AC-28), or a new step. At most one new source
  file (`src/run/routing.ts`). Check: review of `package.json` and `src/`; a run file of 0.4.7 still reads (AC-5).
- **Must not:** change the argv of clarify, spec, plan or review. Check: the AC-13 test.
- **Must keep:** every other key of an existing `gates.json`, with its value and order, when `update` adds routing.
  Check: the AC-16 test.
- **Must keep:** the v04, stats1 and evals1 tests green. Only the tests of the criteria AC-27 edits change with
  them: v04 AC-12, AC-13, AC-16, AC-17, AC-31, AC-66, AC-68, AC-78, AC-79 (e.g.
  `tests/run/engine-task-plan.test.ts`, `tests/run/prompts.test.ts`, `tests/run/engine-quick.test.ts`,
  `tests/run/progress.test.ts`) and evals1 AC-18 and AC-24 (`tests/eval/fake-runs.test.ts` and
  `tests/eval/task-set.test.ts`: their id lists and tables gain the 2 eval tasks), evals1 AC-4 and AC-8 (the
  `--cell` argv and the `cell` field). Test fixtures that write a `gates.json` gain the default routing.
  Check: `pnpm test`, `pnpm test:slow`.
- **Must keep:** `.claude/bin/verify` and `trace` reading `tasks.json` as today; the two new fields are only
  extra keys for them. Check: `tests/hooks/` stays green.
- **When goals conflict:** a refused run > a guessed route. A missing or bad routing value stops the run; the driver
  never falls back to a model of its own. Check: AC-12, AC-15.

## Acceptance criteria (EARS)

### Happy path

- **AC-1:** WHEN the driver starts a run or resumes one (`run quick`, `run task`, `run --resume`), THE SYSTEM SHALL
  read and check `gates.json → routing` with the other `gates.json` values, before any step, any branch and any
  lock. A valid routing has all 9 cells, `retry`, `risky` and `scout`, each matching the route pattern, and no other key.
- **AC-2:** WHEN implement starts the first attempt of a plan task that is not risky, THE SYSTEM SHALL use the cell
  `routing.<tier>.<complexity>` of that task.
- **AC-3:** WHEN implement starts an attempt after the first (`attempts` > 1) of any task, or any attempt of a fix
  task `F<k>` in task or quick mode, THE SYSTEM SHALL use the retry route, whatever the tier, complexity or risk.
- **AC-4:** WHEN implement starts the first attempt of a risky task, of any tier, THE SYSTEM SHALL use the risky
  route. With the default routing a risky L·low task runs on opus · high, not sonnet · medium.
- **AC-5:** WHEN implement starts the first attempt of Q1 in a quick run whose run file has `cell` null, or has no
  `cell` key (a quick run started on 0.4.7 and resumed on 0.4.8), THE SYSTEM SHALL use the cell `routing.M.medium`.
- **AC-6:** WHEN the plan role's output is checked (v04 AC-12), THE SYSTEM SHALL accept a task only with a
  `complexity` of low, medium or high, and an L task only with a non-empty `splitReason`. It SHALL write
  `complexity` to `tasks.json` for every task and `splitReason` for L tasks only.
- **AC-7:** WHEN the driver calls `claude` for implement, THE SYSTEM SHALL pass `--model <model>` and, right after
  it, `--effort <effort>` from the route of AC-2 to AC-5 and AC-28, and print the head line of the Contract.
- **AC-8:** WHEN gate:plan-approve shows the plan, THE SYSTEM SHALL show each task as the Contract's card line: the
  tier, the complexity and the route of its first attempt after the risky route is applied, the `· risky` mark for a
  risky task, and `· not split: <splitReason>` for an L task.
- **AC-9:** WHEN `agent-stack update` runs and `.claude/gates.json` is a JSON object without `routing`, THE SYSTEM
  SHALL add the default routing as its last key and print the lines of the Contract ("When update adds routing").
  With `--dry-run` it SHALL print `  ~ .claude/gates.json (routing block added)` in place of
  `  = .claude/gates.json (yours — kept)`, and write nothing.
- **AC-10:** WHEN `agent-stack generate` writes a new `.claude/gates.json`, THE SYSTEM SHALL write `routing` equal
  to the default routing.
- **AC-11:** WHEN gate:limit offers a new attempt, THE SYSTEM SHALL name the retry route in the answer label, as the
  Contract says. These are the `r` answers of the reason tests-changed and of every reason that uses the `other`
  answers today (`src/run/engine/gates.ts:243`).
- **AC-28:** WHEN `run quick --cell <tier>·<complexity>` starts a run with an allowed value, THE SYSTEM SHALL write
  that value to the run file as `cell`. WHEN implement starts the first attempt of Q1 in a run whose `cell` is set,
  THE SYSTEM SHALL use the cell `routing.<tier>.<complexity>` it names, also after `run --resume`. With the default
  routing, `--cell S·high` runs Q1 on opus · high and `--cell L·low` on sonnet · medium. Later attempts and fix tasks
  still use the retry route (AC-3).
- **AC-29:** WHEN an eval `task.json` has a valid `cell`, THE SYSTEM SHALL start each try of it with
  `run quick --cell <cell> <description>`, as the Contract says. Without `cell`, the eval runner SHALL run
  `run quick <description>` as today (evals1 AC-4).

### Unhappy path

- **AC-12:** IF `routing` is missing, is not an object, misses a cell, `retry`, `risky` or `scout`, holds a value that breaks
  the route pattern, or holds an unknown key, THEN THE SYSTEM SHALL exit 1 before any step, print every problem as
  the Contract's routing check messages say, and change nothing: no run folder, no branch, no lock, no run file
  write (partner of AC-1).
- **AC-13:** IF the role is clarify, spec, plan or review, THEN THE SYSTEM SHALL pass no `--effort` and the same
  `--model` as before this stage (partner of AC-7).
- **AC-14:** IF a task of the plan role's output has no valid `complexity`, or an L task has no `splitReason`, one
  that is empty after trim, or one longer than 80 characters after trim, THEN THE SYSTEM SHALL treat the output as not a valid plan, with the Contract's message
  naming the task (undo and run plan once more, v04 AC-45) (partner of AC-6).
- **AC-15:** IF a task-mode run resumes, its `next` is any step except a step before plan (scout, clarify, gate:answers, spec,
  gate:spec-approve, gate:spec-merge), plan, and gate:limit whose `returnTo` is scout, clarify, spec or plan (the list is `BEFORE_PLAN`, `src/run/engine/plan-file.ts:163`), its stage's
  `tasks.json` exists, and that file lacks a valid `complexity` in a task (a plan written by 0.4.7), or an L task
  lacks a valid `splitReason`, THEN THE SYSTEM SHALL exit 1 before the lock, so the run file, `status` and `next`
  stay as they were (partner of AC-2, AC-8):
  - WHILE `next` is still `plan`, the file is a leftover: the AC-15 check does not run, and the plan step deletes
    an invalid leftover and runs plan again, as `keepLeftover` does today (`src/run/engine/steps-plan.ts:47`);
  - the check reads `tasks.json` once, after the AC-1 check and after the branch check of `--resume` (so a wrong
    branch still gets its `git switch` hint first), with the same rules as `readPlan` (v04);
  - the message is one of these three lines, with the first task that fails, and `<cmd>` the command name (v04
    AC-73):

    ```text
    .claude/tmp/<stage>/tasks.json is no longer a valid plan: task <id> needs a complexity of low, medium or high. Add "complexity" to each task by hand, or cancel the run: <cmd> run --cancel <run id>.
    .claude/tmp/<stage>/tasks.json is no longer a valid plan: task <id> is tier L and needs a splitReason: why it is not split. Add "splitReason" to that task by hand, or cancel the run: <cmd> run --cancel <run id>.
    .claude/tmp/<stage>/tasks.json is no longer a valid plan: task <id>: splitReason must be at most 80 characters. Shorten it by hand, or cancel the run: <cmd> run --cancel <run id>.
    ```

  - `readPlan` uses these three lines for these problems everywhere, also when a step finds them mid-run (for
    example `taskInfo`, `src/run/engine/steps-task.ts:246`);
  - every other `readPlan` problem keeps today's ending, `Restore it, or cancel the run.`;
  - it SHALL never use a default complexity.
- **AC-16:** IF `.claude/gates.json` already has a `routing` key that is an object with all six top-level keys, or
  that is not an object, THEN `update` SHALL leave the file byte for byte as it was. IF the `routing` object lacks a
  top-level key, THEN `update` SHALL add it with its default value and change no value that is there (scout1). IF the file is not valid JSON or not a JSON object, THEN `update` SHALL leave it as it
  was, print the Contract's warning for that case, and exit 0. WHEN `update` adds routing, every other key SHALL keep its value and its order
  (partner of AC-9).
- **AC-17:** IF a task is a fix task or Q1, THEN THE SYSTEM SHALL not check `complexity` or `splitReason` for it:
  they have no plan entry. A fix task SHALL never use a cell, and Q1 SHALL never use the risky route, with or
  without `--cell` (partner of AC-3, AC-5).
- **AC-18:** IF a risky task is on an attempt after the first, THEN THE SYSTEM SHALL use the retry route, not the
  risky route: the retry route wins (partner of AC-4).
- **AC-19:** IF `templates/claude/_routing.json` cannot be read or is not a valid routing by AC-1's rules (the six top-level keys, `scout` included), THEN
  `generate` and `update` SHALL exit 1 with `templates/claude/_routing.json is not a valid routing; reinstall
  agent-stack.` and write nothing (the file is part of the package, so the user cannot fix it in the repo). A test SHALL check that the shipped file is valid and equals the Contract's block (partner of
  AC-9, AC-10).
- **AC-20:** IF the limit reason offers no new attempt (fuse, decision, test-conflict), THEN THE SYSTEM SHALL keep
  its answer labels as they are today (partner of AC-11).
- **AC-30:** IF `--cell` has a value that is not one of the 9 names (e.g. `L.low`, `l·low`, `L·LOW`, `M·max`), or
  goes with `run task`, `--resume`, `--status`, `--cancel`, `--watch` or `--stats`, THEN THE SYSTEM SHALL print the
  Contract's line for that problem and exit 1 before AC-1: no run folder, no branch, no lock (partner of AC-28).
- **AC-31:** IF the run file's `cell` is not `null` and not one of the 9 names, or is not `null` in a task-mode
  run, THEN `run --resume` SHALL exit 1 with `run.json is malformed: cell` (`src/run/store.ts:76`), leave the run
  file as it was, and never fall back to M·medium (partner of AC-28).
- **AC-32:** IF an eval `task.json` has a `cell` that is not one of the 9 names, THEN the eval runner SHALL refuse
  the set with code 1 before any try, with the Contract's message as evals1 AC-8 prints it:
  `<id>/task.json: cell: must be one of …` (partner of AC-29).

### Edge cases

- **AC-21:** WHILE a run is open, THE SYSTEM SHALL use the routing as this driver process read it at start or
  resume (AC-1). An edit of `routing` takes effect at the next `run --resume`. At gate:plan-approve the card is
  rebuilt on each show with that routing, and its `source` holds the routes (Contract). So after a routing edit
  `--resume --answer a` is refused as for a changed plan, and the human sees the new routes first (v04 AC-68).
- **AC-22:** THE SYSTEM SHALL hold the mapping in one place: `templates/claude/_routing.json`.
  - No file under `src/` holds a match of `(opus|sonnet|haiku)·`.
  - These texts name no model for a tier and no route value, and say instead that under the driver
    `.claude/gates.json → routing` picks the implementer's model and effort:
    - the `/plan` skill (its tier table, the retry sentence, "model per tier");
    - the glossary entry Tier;
    - `templates/claude/_normative.md` (its table rows for tiers, and the sentence on a retry);
    - the description of `templates/claude/agents/implementer.md`;
    - the escalation hint of `templates/claude/bin/verify`;
    - the generated CLAUDE.md line on the implementer (`src/claude/harness.ts`, "model by tier"). It becomes:
      `implementer — under the driver, .claude/gates.json → routing picks its model and effort; by hand, spawn it
      with the model of the task's cell in routing.`;
    - `templates/claude/skills/drive/SKILL.md`: its example `implement:T1 started (sonnet)` becomes
      `implement:T1 started (sonnet · low)`, and "its model" becomes "its route".
  - By hand (no driver), the human or the main chat spawns the implementer with the model of the task's cell. Its
    effort stays as the agent's frontmatter says (Out of scope). The by-hand escalation text in the `verify` hint
    and the `/plan` skill ("move it one tier up") becomes "by hand, use the model of `routing.retry`".
  - The test checks:
    - no file under `src/` matches `(opus|sonnet|haiku)·`;
    - the `/plan` skill, the glossary entry Tier and `_normative.md` hold `routing`;
    - the `/plan` skill and the glossary entry Tier have no case-insensitive match of `\b(opus|sonnet|haiku)\b`
      and none of `model (per|by) tier`;
    - `_normative.md`, the implementer description and the `verify` hint match none of `S/M → sonnet`,
      `L → opus`, `low effort`, `retry runs on Opus`, `model (per|by) tier`,
      `tier[^|\n]*\|[^|\n]*\| *.?(sonnet|opus)` (today `_normative.md:44` says "model by tier").
- **AC-23:** THE SYSTEM SHALL keep in the `/plan` skill a section `## Complexity` with exactly these four yes/no
  questions, the rule that turns them into a complexity (Decisions), and the tier L split rule with `splitReason`:
  1. Is there a pattern in the code to copy? (towards low)
  2. Is there more than one reasonable solution? (at least medium)
  3. Does the spec leave a decision open, or is the logic not obvious: edge cases, order, state? (at least medium)
  4. Does it touch security, money, data or concurrency? (high)

  The skill's `tasks.json` example SHALL show `complexity` in every task and one L task with `splitReason`, since
  the plan role copies that example. The test checks the section, its four numbered questions, the word
  `splitReason`, and the example.
- **AC-24:** WHEN the fake claude (`tests/run/fake-claude.mjs`) gets a response with `expectEffort`, THE SYSTEM
  SHALL exit 9 unless `--effort` equals it. A response with `expectRole` other than implement or scout SHALL exit 9 when
  `--effort` is present (scout1 AC-24). The engine tests use this to check AC-2 to AC-5, AC-7, AC-13 and AC-28.
- **AC-25:** THE SYSTEM SHALL ship two more eval tasks in `evals/tasks/`, in quick mode, each with a `cell` chosen
  to test that cell's route, and with `pass` and `break` fake scripts under `tests/eval/scripts/` as evals1 AC-18
  says:

  | id | Work | `cell` | `expect` | `answers` | `check` holds |
  | --- | --- | --- | --- | --- | --- |
  | `rename-many` | rename one function that is defined in one file and called from two others; the fixture's tests do not name it (a mechanical rename across modules) | `L·low` | `finished` | `["a"]` | `git grep` finds the old name in no tracked file outside `.claude/`, the new one is defined, the tests pass, and the first implement call ran on sonnet · medium |
  | `auth-boundary` | a one-line fix in an access check, with edge cases: a missing user, a user with no role | `S·high` | `finished` | `["a"]` | a node script in `check` runs a table of at least 5 cases (owner, admin, other user, missing user, user with no role) and passes; under `src/` only the named file differs from `main`; the first implement call ran on opus · high |

  - With the default routing, L·low and M·medium are both sonnet · medium, so the `rename-many` route check alone
    cannot tell that `--cell` worked. The `auth-boundary` check can (opus · high, not sonnet · medium), and the
    AC-28 engine tests check every cell.

  - The `auth-boundary` table lives inline in `check` (`node -e …`), not in a file of the temp copy that the
    implementer could edit, and not in the fixture's tests: base-check needs the fixture's tests
    green at `main` (v04 AC-15). The fixture keeps its tests in `test/`, outside `src/`, so new test files of the
    implementer are allowed and do not break the "only the named file under `src/`" check.
  - "The first implement call ran on `<model>` · `<effort>`" means: the call file with the lowest number named
    `*-implement.json` in the temp copy's run folder has `--model <model>` and `--effort <effort>` in its `argv`.
  - Each fixture keeps the evals1 rules: at most 5 files (evals1 NFR), and `generate` writes a non-empty
    `commands.test` that exits 0 (evals1 AC-24).
- **AC-26:** THE SYSTEM SHALL add to `CHANGELOG.md` a 0.4.8 entry with `### Upgrading from 0.4.7`, which says:
  - run `agent-stack update`: it adds the routing block to `gates.json`;
  - a run started on 0.4.7 whose plan is written (at gate:plan-approve or later) stops with AC-15: add
    `complexity` (and `splitReason` for an L task) by hand, or cancel it; a run still at its plan step just runs plan again;
  - the plan-approve card line and the implement head line changed (a script that matched them must change);
  - new: `run quick --cell <tier>·<complexity>` picks the routing cell of Q1 (default M·medium), and an eval
    `task.json` may set `cell`.

  `docs/defects.md` #41 SHALL be marked fixed in 0.4.8. The test checks both texts.
- **AC-27:** THE SYSTEM SHALL edit the merged specs in place, each with a `## Changes` entry (date, what, why: effort1):
  - v04 AC-13 and AC-16: the route comes from effort1 (AC-2 to AC-5);
  - v04 AC-12 and AC-68: the card line is effort1's (AC-8), and the card `source` holds the routes (AC-21);
  - v04 AC-17: the `/plan` skill says that under the driver a retry runs on the retry route;
  - v04 AC-31, AC-60 and AC-66, and the state-table row of gate:limit: "on Opus" becomes "on the retry route";
  - v04 AC-78 and AC-79: the implement head line is effort1's (AC-7);
  - v04 Decisions, the "Models" bullets: implementation follows routing (effort1);
  - v04 Terms "Valid plan": each task also has a `complexity`, and an L task a `splitReason` (AC-6, AC-14);
  - v04 Contract: the implement argv line names `--effort`; the gate card example shows effort1's card line and
    the new `source`;
  - v04 Contract, the CLI: `run` gains `--cell` (effort1 AC-28, AC-30); the run file gains `cell` (AC-28, AC-31);
  - evals1 AC-18 and AC-24: "the 5 eval tasks" becomes every eval task in `evals/tasks/`, the 5 of AC-24 plus the 2
    of effort1 AC-25;
  - evals1 Contract `task.json` table, the `start` row of its state table, and AC-4: the optional `cell` and the
    `--cell` argv (effort1 AC-29, AC-32);
  - evals1 AC-8: "a missing required field (all but `answers`)" becomes "(all but `answers` and `cell`)";
  - evals1 NFR: the full eval run is 7 eval tasks × 3 = 21 tries, about $2.10.

  The glossary entry Eval task says that a `task.json` may also name a routing cell (done in this change).

  Check: `.claude/bin/trace v04` and `.claude/bin/trace evals1` pass.

## Non-functional requirements

- The routing check adds 0 file reads: it runs on the `gates.json` the driver already reads (AC-1). Choosing a
  route reads no file beyond what `taskInfo` reads today.
- The eval cost estimate grows with the set: 7 eval tasks × 3 tries = 21 tries, about $2.10 by the evals1 AC-2
  estimate of $0.10 a try.

## Out of scope

- A route, `--effort` or a new model for clarify, spec, plan or review.
- Eval tasks in task mode, which would test the plan's own cell; the eval runner takes only `quick` (evals1).
- `run --stats` by route or by effort.
- A per-task route set by hand in `tasks.json`; a routing per mode; `--cell` for `run task` (its plan sets each
  task's cell); a `--cell` value written with `.` or spaces in place of `·`.
- Checking that the installed `claude` knows `--effort` (How to verify does it by hand once). A `claude` that
  refuses the flag fails the call as today (an infrastructure failure, v04 AC-36).
- Moving an existing `routing` block to new defaults on `update`: once the key is there, it is the user's. Its values stay the user's; only a missing top-level key is added (scout1).
- The by-hand flow (no driver): the implementer subagent's effort stays as its frontmatter says (`effort: medium`).
- The 0.4.8 release edits (version in `package.json`, CODEMAP): a separate release step, as in 0.4.7.

## How to verify

```bash
pnpm typecheck
pnpm build                              # the eval tests run the built CLI (evals1 AC-10)
pnpm vitest run -t "effort1 AC-"        # every criterion of this spec, with the fake claude only
pnpm test                               # fast and slow: v04, stats1, evals1 stay green
.claude/bin/trace --terms effort1
.claude/bin/trace effort1
.claude/bin/trace v04
.claude/bin/trace evals1
# Manual, once: the installed claude knows the flag
claude --help | grep -- '--effort'
# Manual: a broken cell refuses the run and names it
d=$(mktemp -d) && cd "$d" && git init -q -b main && git commit -q --allow-empty -m init \
  && node <repo>/bin/cli.mjs generate >/dev/null \
  && jq '.routing.L.medium = "opus-high"' .claude/gates.json > g && mv g .claude/gates.json \
  && node <repo>/bin/cli.mjs run quick "x"; echo "exit $?"   # exit 1, names routing.L.medium
# Manual: a bad --cell is refused before anything is written
node <repo>/bin/cli.mjs run quick --cell L.low "x"; echo "exit $?"   # exit 1, lists the 9 cells
```

## Changes

- 2026-11-25 — Decisions "Only implement gets a route", Contract (default routing, keys, routing check order and
  messages, update table, argv), AC-1, AC-12, AC-15, AC-16, AC-19, AC-24, Out of scope: scout1. Why: the scout
  call is a second role with a route, `routing.scout` (default haiku·low). `update` now adds a missing top-level
  key of an existing routing block, so a repo on 0.4.7 gets `scout` without losing its own values. AC-15's steps
  before plan, and `BEFORE_PLAN`, gain `scout`.
