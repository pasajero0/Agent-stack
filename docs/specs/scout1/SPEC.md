---
stage: scout1
---

# Scout call: a cheap file map for clarify, spec and plan

## Purpose

After this stage a task run starts with one cheap, read-only **scout** call. It lists the files and line ranges
that matter for the task, each with one line of why. The driver writes the list to the run folder as `scout.md`
and gives it to the clarify, spec and plan roles as their starting map. So those roles read the listed places
first, instead of reading whole files again.

What exists today:
- a task run starts at clarify (`src/run/engine/steps-task.ts:236`, v04 AC-5). Clarify, spec and plan each read
  the repo from nothing. In effort1's measure (run `r-20261125-142216`) the first spec step took 39:42 over two
  calls: call 2 hit the 30-minute step timeout (cost unknown), then call 3 took 9:39 and cost $2.46. The task
  description names $0.76 for this step; no run file holds that number (NEEDS HUMAN DECISION);
- a route (model and effort) exists for implement only (`gates.json → routing`, effort1);
- a judgment role call is re-run once and then stops the run with a `RunError` (`judgeCall`,
  `src/run/engine/call.ts:139`, v04 AC-36 to AC-38);
- `agent-stack update` leaves an existing `routing` block untouched (effort1 AC-16), so it can never add a new
  routing key;
- `run --stats` knows five roles (`src/run/stats/calls.ts:12`, stats1).

This stage edits the merged specs v04, effort1 and stats1 (AC-26).

## Decisions

| ADR | Decided | What it means here |
| --- | --- | --- |
| [0001](../../adr/0001-pipeline-driver.md) | 2026-11-18 | The driver holds the order: the scout is a step in the transitions table, and the driver writes `scout.md` |

Leonid decided these in the grill (2026-11-25):
- **Own step.** `scout` is its own step before `clarify` in the transitions. A resume after a kill skips the call
  when `scout.md` exists. `run --stats` shows it as its own role.
- **One attempt, no re-run.** A failed or empty scout call never stops the run. The run goes on to clarify
  without a map, and the progress log says why. Ctrl-C still interrupts the run, and a reached fuse still goes to
  gate:limit. The driver drops entries whose path does not exist.
- **Counted like any call.** The scout call adds to `calls`, `costUsd` and `costUnknownCalls` (v04 AC-62), and
  the fuse counts it.
- **`routing.scout` is required**, like `retry` and `risky`. Its default lives only in
  `templates/claude/_routing.json`. `update` adds the missing top-level keys of an existing routing block and
  never changes a value that is there (effort1 AC-16 is edited in place).
- **The measure is not a criterion.** It is a step after the code, run only with Leonid's yes (Non-functional
  requirements).

From the task description:
- The scout gets the tools Read, Grep and Glob only. The default route is haiku · low.
- At most 30 entries. Quick mode has no scout.

Added by this spec (for the human to confirm):
- **A cheap model is allowed here.** The glossary idea "Cheapen mechanics, never judgment" says a cheap model only
  where a program checks the result. The map is only a hint: the driver checks that its paths exist, and clarify,
  spec and plan still run on Opus and judge. The glossary idea now says so (done in this change).
- **The scout's rules live in the driver's prompt**, as clarify's do (`clarifyPrompt`). There is no scout skill
  or agent file.
- **The `run --stats --json` shape gains the role `scout`**, so its `version` becomes 2 (stats1 Contract: "A later
  change to this shape raises `version`").
- **A mid-call budget stop** (`error_max_budget_usd`) counts as a reached fuse, as for every role: gate:limit with
  `returnTo` scout. After the human raises the fuse, the scout runs once more.
- **The driver checks the scout map again** each time it reads it for a prompt (AC-17), since a human or a later
  role could edit the file.

## Terms

Shared words are defined in [docs/GLOSSARY.md](../../GLOSSARY.md): scout, role, step, route, routing, effort,
run, driver, mode, fuse, limit gate, run stats. The run folder is `.claude/tmp/runs/<run id>/`, as in v04.

- **Scout** — as in the glossary: the step and the role. Its call is the scout call.
- **Route** — as in the glossary. The scout's route is `routing.scout`.
- **Call file** (local): `calls/<n>-<role>.json` in the run folder (v04 AC-3).
- **Call step** (local): a step that makes a Claude call, so the fuse can stop it (v04 AC-35): scout, clarify,
  spec, plan, implement, review.
- **Head line** (local): the line the driver prints when a Claude call starts, `-> <next> · <role> · …` (v04
  AC-78, effort1).
- **Progress line** (local): one line the driver prints to stdout and to `progress.log` in the run folder.
- **Map entry** (local): one item of the scout's output: `path`, an optional `lines`, and `why`.
- **Kept entry** (local): a map entry that passes the entry checks and is within the first 30 (AC-12, AC-21).
- **Dropped entry** (local): a map entry the driver does not keep.
- **Entry check** (local): one of the numbered steps under "Entry checks" in the Contract.
- **Unsafe character** (local): U+0000 to U+001F, U+007F to U+009F, U+200E, U+200F, U+2028, U+2029, U+202A to
  U+202E, and U+2066 to U+2069 (control, line-separator and bidi characters).
- **Scout map** (local): the file `.claude/tmp/runs/<run id>/scout.md`, with one entry line per kept entry.
- **Entry line** (local): one line of the scout map for a kept entry: ``- `<path>` — <why>`` or
  ``- `<path>:<range>` — <why>``.
- **No map** (local): the scout step ended without writing a scout map; the run goes on without one.
- **No-map line** (local): the progress line `scout: no map (<reason>); the run goes on without it`.
- **Map section** (local): the lines of a clarify, spec or plan prompt that hold the scout map's entry lines.

## Model and state transitions

Task mode gains one step before clarify. Quick mode is unchanged.

| State | Event | New state | Criterion |
| --- | --- | --- | --- |
| — | `run task "<d>"` | scout | AC-1 |
| scout | the scout map exists (a resume after a kill) | clarify, no call | AC-19 |
| scout | the call gives at least one kept entry, and the scout map is written | clarify | AC-4 |
| scout | the call ends infra, schema, max turns, timeout or exec-error | clarify (no map) | AC-10 |
| scout | the call gives no kept entry | clarify (no map) | AC-11 |
| scout | writing the scout map fails | clarify (no map) | AC-28 |
| scout | the fuse is reached before the call, or the call ends `error_max_budget_usd` | gate:limit (fuse), `returnTo` scout | AC-13 |
| scout | SIGINT or SIGTERM | stays at scout, interrupted (v04 AC-51) | AC-14 |
| gate:limit (`returnTo` scout) | raise | scout | AC-13 |

A run whose `next` is `clarify` and that has no scout map (a run started before this stage) resumes at clarify,
with no scout call (AC-20).

## Contract

**Routing.** `routing` gains the required key `scout`. The default routing (`templates/claude/_routing.json`)
is exactly:

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

- `scout` follows the route pattern of effort1. The keys of `routing` are exactly `S`, `M`, `L`, `retry`,
  `risky`, `scout`.
- The routing check (effort1 Contract, "Routing check messages") checks `scout` right after `risky`, before the
  unknown keys:

| Problem | Line |
| --- | --- |
| `routing.scout` is missing | `gates.json routing.scout is missing. Run <cmd> update to add it (CHANGELOG: Upgrading from 0.4.7).` |
| it breaks the route pattern | the effort1 line: `gates.json routing.scout must be "<model>·<effort>" (model opus, sonnet or haiku; effort low, medium, high, xhigh or max); got <got>.` |

- The gate:plan-approve card `source` keeps the 11 route values of effort1. `scout` is not one of them, so a
  scout route edit does not change a plan.

**The scout call** (`claude` argv, as v04 "How Claude Code is invoked"):

| Role | Model | `--effort` | `--tools` | `--permission-mode` | `--allowedTools` |
| --- | --- | --- | --- | --- | --- |
| scout | the model of `routing.scout` | the effort of `routing.scout`, right after `--model` | Read,Glob,Grep | default | — |

- `--max-turns` is `run.maxTurns`, and the timeout is `run.stepTimeoutMin`, as for every role. With a dollar
  fuse, `--max-budget-usd` is passed as for every role.
- The call file is `calls/<n>-scout.json`.
- The head line, with the default routing and a calls fuse of 40: `-> scout · scout · haiku · low · call 1/40 ...`.

**The scout prompt** (sent on stdin):

```text
# Role: scout

The driver has started a task run. You only read the repository: you must not edit files, run commands, or do the task.

Task description:
<description>

- List the places that the next roles (clarify, then spec, then plan) should read first for this task: specs, the code the task changes, its tests, and the docs that define its words.
- At most 30 entries, the most important first. Each entry has one line of why.
- `path` is relative to the repository root. Give `lines` as "<first>-<last>" (or one number) when only part of a file matters; leave it out for a whole file or a folder.
```

**The scout's output** (`structured_output`; JSON schema in `src/run/schemas.ts`). `entries` is required: an
array. Each item is an object; `path` and `why` are required strings; `lines` is an optional string. The schema
check covers every item: one malformed item makes the call a schema ending (AC-10). The schema sets no
`maxItems`, so a long list is not a schema failure (AC-21).

**Entry checks** (AC-12). They run on output that passed the schema. The driver checks the first 100 items only;
later items are dropped entries without a check. For each item, in this order; the first step that fails drops
the entry:
1. Trim `path`. If it is empty, drop.
2. If `path` holds an unsafe character or a backtick, or is longer than 300 code points, drop.
3. If `path` starts with `/` or `\`, or has a `..` segment (split on `/` and `\`), drop.
4. Remove every leading `./` and every trailing `/`. If the result is empty or `.`, drop: the root is not a place.
   Then run step 3 again on the result (so `.//src/x.ts` is dropped).
5. If the path does not exist (`lstat` of `path.resolve(<project folder>, <path>)`), drop.
6. Resolve its real path (`realpathSync.native`, symlinks resolved). If that fails (a dangling symlink), drop.
   If it is not inside the real path of the project folder, is that folder itself, or is `.git` or under `.git/`
   there (compared without case), drop.
7. Make the range: trim `lines`. If it matches `^[1-9][0-9]{0,6}(-[1-9][0-9]{0,6})?$` and the first number is not above
   the second, the range is `<a>` (when a = b, or one number) or `<a>-<b>`. Otherwise, and for a folder, there is
   no range: the entry is kept without one.
8. If an earlier kept entry has the same path (after step 4) and the same range (after step 7), drop.
9. Keep the entry. Only the first 30 kept entries stay; later ones are dropped entries.

`why` of a kept entry: every match of `/\s+/u` (this covers U+2028 and U+2029) becomes one space; each other unsafe character becomes `?`; it is
trimmed; above 200 code points it becomes its first 199 code points and `…`. An empty `why` becomes
`(no reason given)`.

Examples:

| Input `path`, `lines` | Result |
| --- | --- |
| `src/run/routing.ts`, `"5-5"` | kept, ``src/run/routing.ts:5`` |
| `./docs/specs/effort1/`, `"10-20"` | kept, ``docs/specs/effort1`` (a folder: no range) |
| `src/run/routing.ts`, `" 5 "` | dropped as the same as the first (path and range `5`) |
| `src/run/routing.ts`, `"20-10"` | kept, ``src/run/routing.ts`` (bad range) |
| `/etc/passwd`, `../x`, `.`, `./`, `/` | dropped |
| `link` (a symlink to `.git/config`) | dropped (real path under `.git/`) |
| `src/no-such-file.ts` | dropped (does not exist) |

**One worked case.** The scout returns, for run `r-20261125-101500`:

```json
{ "entries": [
  { "path": "src/run/engine/call.ts", "lines": "59-133", "why": "roleCall: one call,\nthe schema re-run, infra" },
  { "path": "./docs/specs/effort1/", "why": "the routing block and its check messages" },
  { "path": "src/run/engine/steps-scout.ts", "why": "where the new step goes" }
] }
```

In the AC-4 test project the third path does not exist, so it is dropped. The driver writes the scout map
(`.claude/tmp/runs/r-20261125-101500/scout.md`) by rename from a temp file in the same folder:

```markdown
# Scout map

Run r-20261125-101500 · haiku · low · 2 places

- `src/run/engine/call.ts:59-133` — roleCall: one call, the schema re-run, infra
- `docs/specs/effort1` — the routing block and its check messages
```

It prints the progress line `scout: map of 2 places written to scout.md (1 dropped)`. The clarify, spec and plan
prompts get this map section:

```text
Starting map (from the driver's scout, a cheap read-only call; it can miss places or be wrong). Read these places first; read a whole file only when the listed lines are not enough:
- `src/run/engine/call.ts:59-133` — roleCall: one call, the schema re-run, infra
- `docs/specs/effort1` — the routing block and its check messages
```

**The scout map's layout**, line by line: `# Scout map`; an empty line; the header; an empty line; one entry
line per kept entry, in the order of the output. Lines end with `\n`, and the file ends with one `\n` after the
last entry line. The header is `Run <run id> · <model> · <effort> · <n> places`, or `… · 1 place` when n is 1.

**The map section.**
- Its lines are the line `Starting map (…):` above, then the entry lines.
- The entry lines are the lines of the scout map that match ``^- `[^`]+` — .+$``, hold no unsafe character, and
  have at most 600 code points, in order, at most the first 30. Any other line of the file is not used. The
  driver reads the scout map each time it builds one of these prompts. This check is of the line's form only:
  the paths are not checked again.
- One empty line comes before the section, and the prompt goes on after it as today:
  - clarify: right after the description line(s), before the empty line and the `- Ask at most 5 questions` bullets;
  - spec: right after the answers, before the empty line and `The /spec skill follows.`;
  - plan: right before the empty line and `The /plan skill follows.` (so after the human's reject comment, when
    there is one).
- With no scout map, or none of its lines an entry line, a prompt has no map section and no word about it.

**Progress lines** of the scout step, one when it ends:

| Ending | Line |
| --- | --- |
| a scout map is written, nothing dropped | `scout: map of <n> places written to scout.md` (`1 place` when n is 1) |
| a scout map is written, k > 0 dropped | `scout: map of <n> places written to scout.md (<k> dropped)` |
| the scout map existed before the step (AC-19) | `scout: scout.md is already there; no new call` |
| no map | `scout: no map (<reason>); the run goes on without it` |

`<reason>` is one of: `infra`, `schema`, `max-turns`, `timeout`, `exec-error` (the call's ending, AC-10);
`empty list` (`entries` is empty); `no entry kept` (`entries` is not empty, and every item is a dropped entry, for
any reason); `write failed` (AC-28). The call file holds the details. A fuse stop (AC-13) and an interrupt
(AC-14) print no scout progress line; they print what they print today for any step.

**Run file.** `next` and `returnTo` may be `scout`; `steps` may hold a `scout` entry. No new field.

**`agent-stack update` on `.claude/gates.json`** (replaces the two `routing` rows of the effort1 table):

| On disk | What update does | Output |
| --- | --- | --- |
| a JSON object without a `routing` key | adds the whole default routing as the last key (as effort1) | as effort1 |
| `routing` is an object with all six top-level keys | nothing: the file stays byte for byte | as today |
| `routing` is an object without one or more of `S`, `M`, `L`, `retry`, `risky`, `scout` | adds each missing key with its default value, after the keys that are there, in that order; writes `JSON.stringify(…, null, 2)` and a newline | see below |
| `routing` is there but not an object | nothing | as today (the run's routing check names it) |

When update adds routing keys:
- it prints `added routing.<key> to .claude/gates.json` right after the `Harness updated:` line, with every added
  key joined by `, `, e.g. `added routing.scout to .claude/gates.json` or
  `added routing.retry, routing.scout to .claude/gates.json`;
- the seed line ends `…were left untouched, except the routing keys added to gates.json.`;
- a dry run prints `  ~ .claude/gates.json (routing.<key>, … added)` in place of
  `  = .claude/gates.json (yours — kept)`, and writes nothing.

Update never adds a missing cell inside an existing tier object, and never changes a value that is there.

**`run --stats`** (stats1 Contract). The roles are, in this order: scout, clarify, spec, plan, implement,
review.
- A call file name `<n>-scout.json` is valid (stats1 AC-19).
- The text `calls:` line starts with the scout, e.g. `calls: scout 1 (ok 1) · clarify 1 (ok 1) · …`.
- The JSON `byRole` always has the six roles, each with the nine keys; `version` is 2.

## Constraints

- **Must not:** put a route value in TypeScript code. `scout`'s default lives only in
  `templates/claude/_routing.json`. Check: the effort1 AC-22 test (no `(opus|sonnet|haiku)·` under `src/`).
- **Must not:** add a dependency, a run file field, or more than one new source file
  (`src/run/engine/steps-scout.ts`). Check: review of `package.json`, `RunFile` in `src/run/types.ts`, and
  `src/`.
- **Must not:** give the scout a tool other than Read, Glob and Grep, or a permission mode other than `default`.
  Only the driver writes the scout map. Check: the AC-2 test of the argv.
- **Must keep:** the argv of clarify, spec, plan, implement and review as they are (effort1 AC-13). Their prompts
  change only by the map section. Check: the AC-5 and AC-17 tests; `tests/run/prompts.test.ts`.
- **Must keep:** quick mode as it is: no scout step, no scout call. Check: the AC-1 test; the evals1 fake runs.
- **Must keep:** the v04, effort1, stats1 and evals1 tests green. What changes in them:
  - the tests of the criteria AC-26 edits;
  - every task-mode engine test: its fake claude script gets a scout response first (the fixture helpers, e.g.
    `toSpecMerge` in `tests/run/engine-task-fixture.ts`, add it), so call numbers and `calls` counts move up by 1;
  - test fixtures that write a `gates.json` gain `routing.scout`.

  No assertion of such a test may be weakened beyond that. Check: `pnpm test`; review of the test diff.
- **When goals conflict:** the run going on > the map. A scout problem never stops a run. Only a reached fuse
  (AC-13), an interrupt (AC-14) or a bad `routing.scout` before the start (AC-15) stops it. Check: AC-10, AC-11,
  AC-28.

## Acceptance criteria (EARS)

### Happy path

- **AC-1:** WHEN `run task` starts a run, THE SYSTEM SHALL make `scout` its first step, before clarify. WHEN
  `run quick` starts a run, THE SYSTEM SHALL make no scout step and no scout call.
- **AC-2:** WHEN the scout step makes its call, THE SYSTEM SHALL start `claude` with the model and, right after
  `--model`, the `--effort` of `routing.scout`, with `--tools Read,Glob,Grep`, `--permission-mode default`, no
  `--allowedTools`, and the scout's JSON schema, and print the head line of the Contract.
- **AC-3:** WHEN the scout step builds its prompt, THE SYSTEM SHALL send the Contract's scout prompt with the
  run's description.
- **AC-4:** WHEN the scout call returns valid output with at least one kept entry, THE SYSTEM SHALL write the scout
  map by rename as the Contract shows, print the Contract's progress line, and go to clarify. In a temp project
  that holds `src/run/engine/call.ts` and `docs/specs/effort1/` and no `src/run/engine/steps-scout.ts`, the
  worked case of the Contract SHALL give exactly the scout map, the progress line and the map section shown there.
- **AC-5:** WHEN the driver builds a clarify, spec or plan prompt and the scout map has at least one entry line,
  THE SYSTEM SHALL put the map section in it, at the place the Contract names. This holds for every call of these
  roles in the run: re-runs (v04 AC-37, AC-38), runs after a reject, and runs after gate:limit.
- **AC-6:** WHEN the scout call ends, THE SYSTEM SHALL count it as any call: `calls` + 1 before the call,
  `costUsd` + its cost, or `costUnknownCalls` + 1 when its cost is unknown (v04 AC-62). It SHALL write the call
  file `calls/<n>-scout.json`, and the run file's `steps` SHALL hold a `scout` entry.
- **AC-7:** WHEN `run --stats` counts a run with a scout call, THE SYSTEM SHALL count it under the role `scout`,
  as the Contract's `run --stats` part says, in text and in JSON (`version` 2).
- **AC-8:** WHEN the driver checks `gates.json → routing` (effort1 AC-1), THE SYSTEM SHALL require `scout` with a
  value that matches the route pattern, checked right after `risky`.
- **AC-9:** WHEN `agent-stack generate` writes a new `.claude/gates.json`, THE SYSTEM SHALL write the Contract's
  default routing, `scout` included. WHEN `agent-stack update` finds a `routing` object without one or more of
  its six top-level keys, THE SYSTEM SHALL add each missing key with its default value and print the Contract's
  lines.

### Unhappy path

- **AC-10:** IF the scout call ends infra, schema (also a parse failure after `ok`), max turns, timeout or
  exec-error, THEN THE SYSTEM SHALL make no second scout call, write no scout map, print the no-map line with
  that reason, and go to clarify. It SHALL not exit with an error or throw a `RunError` (partner of AC-4).
- **AC-11:** IF the scout's output has an empty `entries`, THEN THE SYSTEM SHALL print the no-map line with
  `empty list`. IF `entries` is not empty and every item is a dropped entry, THEN it SHALL print the no-map line
  with `no entry kept`. In both cases it SHALL write no scout map and go to clarify (partner of AC-4).
- **AC-12:** IF a map entry fails an entry check, THEN THE SYSTEM SHALL drop it and keep the other entries. A bad
  `lines` alone SHALL never drop an entry: the entry goes on without a range, and step 8 still applies. In a temp
  project that holds `src/run/routing.ts`, `docs/specs/effort1/`, a `.git` folder with `config`, and a symlink
  `link` to `.git/config`, each row of the Contract's examples table SHALL give its result (partner of AC-4).
- **AC-13:** IF the fuse is reached before the scout call, or the scout call ends `error_max_budget_usd`, THEN
  THE SYSTEM SHALL go to gate:limit with the reason fuse and `returnTo` scout, as for every call step (v04 AC-35).
  WHEN the human raises the fuse there, THE SYSTEM SHALL run the scout step again (partner of AC-6).
- **AC-14:** IF the driver gets SIGINT or SIGTERM during the scout call, THEN THE SYSTEM SHALL stop the call as for
  any role (v04 AC-51) and keep `next` at `scout`. A later `run --resume` SHALL make a new scout call, since no
  scout map exists (partner of AC-1).
- **AC-15:** IF `routing.scout` is missing or breaks the route pattern, THEN THE SYSTEM SHALL exit 1 before any
  step, print the Contract's line among the other routing lines (effort1 AC-12), and change nothing. This holds
  for `run quick` too, which checks the whole routing (partner of AC-8).
- **AC-16:** IF `.claude/gates.json` has a `routing` object with all six top-level keys, THEN `update` SHALL leave
  the file byte for byte. IF `routing` is there but not an object, THEN `update` SHALL leave the file as it was.
  WHEN `update` adds routing keys, every other key of the file and of `routing` SHALL keep its value and its
  order, and no cell inside an existing tier object SHALL be added (partner of AC-9).
- **AC-17:** IF there is no scout map, it cannot be read, or none of its lines is an entry line, THEN THE SYSTEM
  SHALL build the clarify, spec and plan prompts with no map section, exactly as before this stage, and not stop
  the run. A line of the file that is not an entry line, and each entry line after the 30th, SHALL never reach a
  prompt (partner of AC-5).
- **AC-18:** IF a run has no scout call (a quick run, or a run from before this stage), THEN `run --stats` SHALL
  show `scout 0` in text and all nine keys at 0 in JSON (partner of AC-7).
- **AC-28:** IF writing the temp file or the rename fails, THEN THE SYSTEM SHALL try to remove the temp file,
  leave no scout map, print the no-map line with `write failed`, and go to clarify (partner of AC-4).

### Edge cases

- **AC-19:** WHEN a run resumes at `scout` and its scout map exists (a kill after the map was written and before
  the run file moved on), THE SYSTEM SHALL make no scout call, print
  `scout: scout.md is already there; no new call`, and go to clarify.
- **AC-20:** WHEN a task run whose `next` is `clarify` resumes and it has no scout map (it started before this
  stage, or its scout gave no map), THE SYSTEM SHALL run clarify without a scout call.
- **AC-21:** WHEN the scout returns more than 30 entries that pass the checks, or more than 100 items, THE SYSTEM
  SHALL keep the first 30 kept entries and count every other item in `<k> dropped`. A list longer than 30 SHALL
  never be a schema failure.
- **AC-22:** WHEN a kept entry's `why` holds whitespace runs, a newline, another unsafe character, or more than 200
  code points, THE SYSTEM SHALL write it to the scout map as the Contract says, so each entry stays one line and
  cannot fake a prompt line.
- **AC-23:** WHEN a scout call ends `ok` with permission denials, THE SYSTEM SHALL add them to `humanDecisions` as
  for every role (v04 AC-32). This holds for every `ok` ending: a scout map, `empty list`,
  `no entry kept` and `write failed`. The other endings, and a parse failure after `ok` (a `schema` ending), add no denials, as today.
- **AC-24:** WHEN the fake claude (`tests/run/fake-claude.mjs`) gets a response with `expectRole` `scout`, THE
  SYSTEM SHALL accept any `--model` unless the response has `expectModel`, as for implement, and SHALL accept
  `--effort`, checked with `expectEffort` when that is set. A response with `expectRole` other than implement or
  scout SHALL still exit 9 when `--effort` is present.
- **AC-25:** THE SYSTEM SHALL add to the 0.4.8 entry of `CHANGELOG.md`:
  - new: a task run starts with a scout call (`routing.scout`, default haiku · low) that writes `scout.md` to the
    run folder for clarify, spec and plan;
  - under `### Upgrading from 0.4.7`: run `agent-stack update`; it adds `routing.scout` to `gates.json`, also when
    the routing block is already there. Until then the driver refuses to start (AC-15);
  - `run --stats --json` is version 2, with the role `scout` in `byRole`.

  The test checks that the 0.4.8 entry holds `scout.md` and `version 2`, and that its `### Upgrading from 0.4.7`
  part holds `routing.scout`.
- **AC-26:** THE SYSTEM SHALL edit the merged specs in place, each with a `## Changes` entry (date, what, why:
  scout1):
  - **v04**:
    - AC-5, the state table rows that start a task run (`run task "<d>"`, also AC-85's row), and the `next`
      values of the run file: a task run starts at scout;
    - Terms "Step" and "Run folder" (it also holds `scout.md`);
    - Decisions, the "Models" bullets: the scout follows `routing.scout`;
    - "How Claude Code is invoked": the role table gains the scout row; the `--effort` bullet says implement and
      scout;
    - "Role prompts" and "Role outputs": the scout, as this Contract says; the clarify, spec and plan prompts
      also hold the map section (scout1 AC-5);
    - AC-35: the scout step is a call step;
    - AC-36, AC-37, AC-38 and the "any | infrastructure failure, or schema mismatch twice" row: except the scout
      (scout1 AC-10);
  - **effort1**:
    - Decisions "Only implement gets a route": implement and the scout;
    - the Contract (the default routing, the keys, the routing check order, the update table, and in
      "`claude` argv for implement" the sentence "Every other role's argv is as today: no `--effort`": implement
      and the scout get `--effort`) and AC-1, AC-12, AC-16, AC-19 and AC-24;
    - AC-15: its list of steps before plan gains `scout`, and so does `BEFORE_PLAN`
      (`src/run/engine/plan-file.ts:163`);
    - Out of scope, "once the key is there, it is the user's": its values stay the user's, and a missing
      top-level key is added;
  - **stats1**: Decisions ("Fixed `--json` shape with `"version": 1`"), the Contract, AC-5, AC-7 and AC-19: six
    roles, `version` 2.

  The glossary entries Role, Step, Route, Routing, Mode, `gates.json`, Seed files, the idea "Cheapen mechanics,
  never judgment", and the new entry Scout are edited in this change.

  Check: `.claude/bin/trace v04`, `.claude/bin/trace effort1` and `.claude/bin/trace stats1` pass.
- **AC-27:** THE SYSTEM SHALL keep one source of the default routing: the test of effort1 AC-19 checks that
  `templates/claude/_routing.json` equals this Contract's block, and no file under `src/` matches
  `(opus|sonnet|haiku)·`.

## Non-functional requirements

- A quick run makes 0 scout calls. A task run started on this version that gets past scout makes exactly 1 scout call, plus 1 more for each mid-call
  `error_max_budget_usd` stop followed by a raise (AC-13), and 1 more for each interrupt or kill during the call
  (AC-14). A fuse reached before the call makes no call.
- The map section adds at most 31 lines to each clarify, spec and plan prompt, each of at most 600 code points
  (AC-17).
- The entry checks read no file content: at most 100 items are checked, each with at most one `lstat` and one
  `realpath`.
- **The measure (not a criterion; no test checks it).** After the code is done, and only with Leonid's yes, run
  one live task run on the same task as effort1's measure (run `r-20261125-142216`). Compare the first spec
  **step** (all its calls, from `steps` and the call files) with effort1's: 39:42, and the cost Leonid confirms
  (Purpose). Also note the scout call's own cost and time. The result goes to `CHANGELOG.md` and
  `.claude/tmp/roadmap-plan.md`.
  - Proposed keep rule (for Leonid to confirm): keep the scout when the first spec step costs at least 20% less
    and takes at least 20% less time than the baseline, the scout call costs at most $0.05, and the spec still
    passes spec-reviewer within its 3 rounds. Otherwise remove or rework it.
  - The roadmap's rule "keep it only if `evals` cost drops and pass^k does not drop" cannot apply: the eval runner
    runs quick mode only, and quick mode has no scout.

## Out of scope

- A scout in quick mode, or for implement and review.
- A scout skill or agent file; a scout re-run on failure; a fallback route when `routing.scout` is bad; a route
  without an effort.
- Checking that `lines` are inside the file's length, or that the map is right. The roles may read beyond it.
- Showing the scout map on a gate card or in `run --status`.
- `update` adding a missing cell inside an existing tier object.
- An older driver reading a run file whose `next` is `scout`.
- An eval task in task mode, which could measure the scout with `evals`.
- The 0.4.8 release edits (version in `package.json`, CODEMAP): a separate release step.

## How to verify

```bash
pnpm typecheck
pnpm build
pnpm vitest run -t "scout1 AC-"         # every criterion of this spec, with the fake claude only
pnpm test                               # v04, effort1, stats1 and evals1 stay green
.claude/bin/trace --terms scout1
.claude/bin/trace scout1
.claude/bin/trace v04
.claude/bin/trace effort1
.claude/bin/trace stats1
# Manual, once: the installed claude takes --effort with haiku (else every scout ends "no map (infra)")
echo 'Say ok.' | claude -p --model haiku --effort low --output-format json; echo "exit $?"   # exit 0
# Manual: a routing block without scout refuses the run, and update adds the key
d=$(mktemp -d) && cd "$d" && git init -q -b main && git commit -q --allow-empty -m init \
  && node <repo>/bin/cli.mjs generate >/dev/null \
  && jq 'del(.routing.scout)' .claude/gates.json > g && mv g .claude/gates.json \
  && node <repo>/bin/cli.mjs run quick "x"; echo "exit $?"   # exit 1, names routing.scout
node <repo>/bin/cli.mjs update | grep 'added routing.scout'
# Manual, after the code and with Leonid's yes: the measure (Non-functional requirements)
```

## Changes

None: this is the first version.
