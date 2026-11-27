# Glossary

The words agent-stack uses, one meaning each, and the ideas the harness is built on. Specs and ADRs use
these words; a spec's own "Terms" section adds only what is local to it. When a word changes meaning, change
it here first.

## Ideas

- **Enforcement outside the model.** What must always happen is held by a program (hook, script, driver),
  not by text the model may ignore. Prompts and skills only guide. This is why hooks exist, and why the
  driver exists (ADR-0001).
- **The program holds the order.** The order of pipeline stages is kept by code, like guards keep single
  actions. Recorded miss behind it: in the first trial `/plan` was never called, and nothing checked the
  "done".
- **The program decides "done".** Checks are run by the harness and judged by exit code; the model's report
  is an unverified claim. `.claude/bin/verify` is the only writer of `passes`.
- **Spec leads the code.** No code for a stage before a human approves its spec (how: the spec flow); later
  spec changes are committed before the code they explain.
- **The human approves at fixed points.** Approving a spec, approving a plan, accepting a result. Push and
  merge are always the human's.
- **Cheapen mechanics, never judgment.** Use a cheaper model only where a program checks the result
  afterwards (implementation behind tests and `verify`). Where nothing checks after it — clarifying,
  specifying, planning, sizing, reviewing — use the strongest model. A missed defect in review costs more
  than the tokens saved (Superpowers measured 0 of 10 defects caught by reviewers on a small model).
  A cheap helper whose output is only a hint to a strong role is allowed: the scout's map only says where
  to read first, the driver checks that its paths exist, and the strong role still reads and judges.
- **`ask` beats `deny` when a legitimate case exists.** In interactive mode a risky action asks the human;
  in autonomous mode, where nobody can answer, the same rule blocks.
- **A hook catches mistakes; walls come from other layers.** Hooks are a blocklist. Real walls are
  permissions, the OS sandbox, CI and branch protection.
- **Every block has a test, and a legitimate input beside it.**
- **Build only from a recorded miss.** A new mechanism needs a failure it would have prevented, or a need of
  the stage. Parts nobody uses are measured (`agent-stack usage`) and removed.
- **One source of rules.** A rule lives in one place: a skill or an agent. The driver's steps load them and add
  only data and bounds, so a fix to an agent reaches the driver too. Recorded miss: the driver's own review
  text missed the agent's later fixes.
- **Cause** — the column of `docs/defects.md` that names why a defect happened: a short, stable kebab-case name
  (`rule-in-two-places`), the same for every row with that cause. One cause per row: the cause that can repeat in
  other places, not the place that broke (`harness-part-not-tested-with-sandbox`, not "a temp file outside
  `$TMPDIR`"). The log counts defects by cause, not by class, because one cause can show in several places. The
  count of repeats sets the priority. **A cause that repeats gets a check:** at 2 rows, the maintainer plans a check
  for it in the next release; at 3 rows with no test and no planned check (`planned: <version>` in the `Test`
  cell), `pnpm defects --check` fails in CI and the release does not merge. This entry is the one place of the
  rule.
- **The harness is stack-agnostic.** Stack-specific settings live in `.claude/gates.json`; fixed checks that
  are the same for every project live in the hooks, so `update` can deliver them.

## Pipeline

- **Stage** — a unit of planned work with an id (`A0`, `PAY-12`, `v04`), one spec and one branch. The gates
  read the stage from the branch name (`stagePattern`). The id names what the stage does: a word, then a
  number (`stats1`), not a code that only a plan explains (`M1`).
- **Spec** — `docs/specs/<stage>/SPEC.md`: acceptance criteria in EARS, unhappy paths, edge cases, numeric
  NFRs, how to verify. **Full** for visible behaviour, **light** (a checklist) for setup work. Approved by a
  human; how depends on the spec flow.
- **Local term** — a word a spec defines for itself only, marked `- **Word** (local): …` in its `## Terms`.
  `trace` checks every other Terms entry against this glossary.
- **Acceptance criterion (AC)** — one checkable statement in a spec, with an id (`AC-3`); tests carry the
  id in their names.
- **ADR** — a numbered architecture decision (`docs/adr/NNNN-*.md`): context, decision, rejected
  alternatives, consequences. Accepted when merged.
- **Plan** — `.claude/tmp/<stage>/tasks.json`, written by `/plan`: every criterion covered by a task, each
  task with a `verify` command and a tier. Written once; only `verify` changes it.
- **Task** (in a plan) — one reviewable step, roughly one commit.
- **Tier** — a task's S / M / L: how much work it is. With the complexity it picks the implementer's route;
  `.claude/gates.json → routing` holds the mapping. An L task that is not split into blocks says why
  (`splitReason`). Not the *size* of task mode (task, story, epic).
- **Complexity** — a task's low / medium / high: how hard its logic is, not how many files it touches. The plan
  sets it from four yes/no questions in the `/plan` skill.
- **Effort** — the level Claude Code thinks at, `claude --effort`: low, medium, high, xhigh or max.
- **Route** — the model and the effort of one implement or scout call, written `model·effort` (`sonnet·low`).
  For implement the driver picks it from the routing: the retry route for a later attempt or a fix task, then the
  risky route, then the cell of tier × complexity. The scout always uses `routing.scout`.
- **Routing** — `.claude/gates.json → routing`: the route of each tier × complexity (9 cells), plus `retry`,
  `risky` and `scout`. Data, not code: the harness template is its one source, and the driver refuses a run when a value is
  missing or wrong.
- **Verify** — a task's command that fails before the task and passes after it; `.claude/bin/verify` runs
  it and records `passes`.

## Driver (ADR-0001)

- **Driver** — `agent-stack run`: runs Claude Code headless one stage at a time, runs the checks itself,
  stops for the human at gates.
- **Step** — one unit of the pipeline the driver executes: scout, clarify, spec, plan, base-check, implement, checks,
  review, commit; a gate is a step that waits for the human. Not a *stage*: a stage is planned work with a
  spec.
- **Run** — one execution of the pipeline for one piece of work; its state is the **run file**
  (`.claude/tmp/runs/<run id>/run.json`), written only by the driver.
- **Live run** — a run whose status is `running` and whose driver process is alive. spec-gate steps aside for
  a live run on its own branch: its `codeBy` check in any mode, its spec and plan checks in quick mode.
- **Driver call** — a Claude process the driver started, with `AGENT_STACK_RUN=<run id>` in its environment;
  its hooks inherit that variable.
- **Mode** — the path a run takes: **quick** (a small fix: implement → checks → review → accept), **task**
  (scout → clarify → spec → plan → implement → checks → review → accept), **bug** (a failing test first),
  **refactor** (green before and after, tests untouched). There is no separate "big task" mode.
- **Size** — task mode's own verdict on the work: **task** (full spec, one or two tasks), **story** (full spec,
  several tasks), **epic** (several stages; the run proposes a split and stops).
- **Gate** — a point where the run waits for the human: answers, spec merge or spec approval, plan approval,
  acceptance, limit.
- **Spec flow** — `gates.json` → `specFlow`: how a human approves a spec. **merge** (the default, for a team):
  the spec comes on its own branch and merging it into the base branch is the approval. **branch** (for one
  person): spec, plan and code stay in the current branch, and the human's answer at gate:spec-approve is the
  approval; the spec may change there later and is approved again. The allowed names are one list in code.
- **Gate card** — what a gate shows, built once (rebuilt only when it goes stale) and kept in the run file: a title, the facts, what the human
  must decide, and the answers it takes. The terminal prints it short for a person; `--status --json` gives the
  same card to a program. One source, so the two never say different things.
- **Operator chat** — a Claude Code chat that runs the driver for the human: it starts a run, shows each gate
  card, passes the human's answer with `--answer`, and reports at the end. It does no step's work itself; the
  driver's roles do. By default (`codeBy` `"driver"`) spec-gate holds this: code edits outside `openPaths` and outside a
  driver call are refused. It speaks `language.chat` (English by default) and keeps terms in `language.terms`.
- **Attempt** — one pass of implement → checks → review for a task. Limited (task 3, quick 2); a later
  attempt runs on the retry route.
- **Limit gate** — where a run stops when attempts run out, review findings stop shrinking, or the fuse
  blows: one more attempt (on the retry route), raise the fuse (only when the fuse blew), or cancel.
  - **Decision** reason: the spec or plan role asked the human instead of doing its job. The human answers,
    and the role runs again with its questions and the answer. A blind re-run would only ask again.
  - **Test conflict** reason: the implementer found an existing test or verify that contradicts a criterion,
    and left it alone. The human fixes the test or the spec, or answers; no attempt is counted.
  - **Tests changed** reason: the task deleted or weakened a test that was there before it, or changed a check
    config (CI, test or lint settings). The human allows the change or sends the task back.
- **Role** — what one Claude call is asked to be: scout, clarify, spec, plan, implement or review. Each role has
  its own tools, model and output schema. Its rules come from the project's skill or agent, never from a copy
  in the driver (scout and clarify have none: their few rules are in the driver's prompt). The role returns
  data, and the driver writes the files it owns, such as `tasks.json`, `scout.md` and the commits.
- **Scout** — the first step and role of a task run: one cheap read-only call (`routing.scout`) that lists the
  files and line ranges that matter for the task, each with one line of why. The driver writes the list to the
  run folder as `scout.md` and gives it to clarify, spec and plan as their starting map. The scout is never
  re-run after a failed call: the run goes on without a map.
- **Project-only call** — every call the driver makes loads only the project: its `.mcp.json`, project
  settings and CLAUDE.md. It loads nothing of the user's: no global CLAUDE.md, memory, plugins or account
  connectors. This keeps the user's private context out, and keeps the cost down (the account connectors
  alone were about 150k tokens a turn).
- **Fuse** — the run-wide cap (`run.fuse`). It is not a budget: it stops a run that went wrong. It comes in
  three kinds:
  - **calls**, the default: Claude calls per run. It fits a subscription, where what runs out is the usage
    limit, not money.
  - **usd**: for API billing.
  - **off**.

  Turns per call and attempts per task apply whatever the kind.
- **Feedback** — what sends a run back to implement: the failing command and its output, review findings,
  the human's comment.
- **Run stats** — `agent-stack run --stats`: a summary over every run folder of the repo, read only from the run
  files, the call files and the lock. It measures how the driver works; it changes nothing.
- **First-pass success** — the share of started tasks that were committed after one attempt (`attempts == 1`).
  A fix task F*k* counts like any task.
- **Iterations per task** — the mean `attempts` of the started tasks. 1.0 means every task passed the first time.

## Evals

- **Eval task** — one regression case for the driver: `evals/tasks/<id>/task.json` and a tiny fixture repo. It
  names a mode, a description, the outcome the driver must reach and a check command, and may name the routing
  cell of its first implement call. Not a *task* of a plan.
- **Eval runner** — `scripts/eval.mjs`: runs each eval task k times, each time in a fresh temp copy with the
  harness deployed, and writes a results file under `evals/results/`. It never changes this repo's code or runs.
- **Try** — one run of one eval task by the eval runner, from a fresh temp copy to the check. Not an *attempt*:
  an attempt is one pass of implement → checks → review inside a run.
- **pass@1** — the share of tries that passed. For a task: passes / tries; in total: all passes / all tries.
- **pass^k** — reliability: for a task, 1 when all its k tries passed, else 0; in total, the share of eval tasks
  with all k tries passed. A task can have a high pass@1 and pass^k 0.

## Harness parts

- **Harness** — what agent-stack deploys into `.claude/`: hooks, `bin/` scripts, subagents, skills,
  settings.
- **Hook** — a script Claude Code runs on an event. **PreToolUse** hooks can block an action; **Stop**
  hooks can send the model back once; **SessionStart** hooks add context.
- **Gates (hooks)** — the blocking hooks that hold the process: **spec-gate** (spec merged, then plan, before
  code), **cheat-guard** (no skipped tests or suppressed checks), **arch-guard** (no imports across layer boundaries).
- **Guards** — the blocking hooks that hold single actions: **guard-bash** (no push, no foreign package
  manager, ask before download-and-run or reading secrets), **guard-file** (harness files, lockfiles,
  generated files, `tasks.json`).
- **`gates.json`** — the project's settings for the gates. Yours: `update` never rewrites it, so new keys
  get defaults in code. One exception: `routing` has no default in code, so `update` adds the block when it is
  missing, and adds a missing top-level key of it (such as `scout`). It never changes a value that is there.
- **`codeBy`** — `gates.json` → `codeBy`: who may edit code outside `openPaths`. spec-gate reads it.
  **driver** (the default, also when the key is missing): only a driver call of a live run on this branch. A chat
  runs the work with `/drive`, also a small fix (`run quick`).
  - **Emergency exit** — `"codeBy": "anyone"`: every chat may edit code again. Only a human sets it, by hand, when
    the driver itself is broken.
- **OS sandbox** — Claude Code's own sandbox for the Bash tool and its child processes: macOS Seatbelt, or
  `bwrap` + `socat` on Linux and WSL2. It limits the files Bash reads and writes and the domains it reaches. It
  does not cover Read, Edit, Write, WebFetch, MCP servers or hooks.
- **Sandbox block** — the `sandbox` object the harness writes into `.claude/settings.json`: the sandbox on, no retry
  outside it, the secret folders unreadable, network only to `gates.json` → `sandbox.allowedDomains`. `update`
  merges it with the user's own `sandbox` keys: a switch the user set wins, with a warning when it is weaker, and a
  secret folder the user removed stays removed, with a warning. One exception, announced: an object or list of the
  wrong type is replaced.
- **Probe** — one short command that tries an action a rule forbids, on the real machine with the real settings,
  and reports "denied" or "allowed". A probe changes nothing: it opens a file for writing and closes it, or lists
  a folder, and prints no file names or contents. A test checks that the harness wrote a rule into the settings;
  a probe checks that Claude Code enforces it. A set of probes has a control probe: an action that must stay
  allowed, so a probe that always says "denied" is seen. Probes run after `update`, before a release that changes
  the sandbox block or the permission lists. A probe is not a role, not a subagent and not a model call.
- **Interactive / autonomous** — `gates.json` → `mode`. Interactive asks the human; autonomous never asks,
  blocks instead, and records decisions under NEEDS HUMAN DECISION.
- **Seed files** — files `init` writes once and `update` leaves alone: `CLAUDE.md`, `CODEMAP.md`,
  `gates.json`, `settings.local.json`. One exception: `update` adds a missing `routing` block, or a missing top-level
  key of it, to `gates.json`.
