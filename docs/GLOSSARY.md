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
- **Spec leads the code.** No code for a stage before its spec is merged by a human; later spec changes are
  committed before the code they explain.
- **The human approves at fixed points.** Merging a spec, approving a plan, accepting a result. Push and
  merge are always the human's.
- **Cheapen mechanics, never judgment.** Use a cheaper model only where a program checks the result
  afterwards (implementation behind tests and `verify`). Where nothing checks after it — clarifying,
  specifying, planning, sizing, reviewing — use the strongest model. A missed defect in review costs more
  than the tokens saved (Superpowers measured 0 of 10 defects caught by reviewers on a small model).
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
- **The harness is stack-agnostic.** Stack-specific settings live in `.claude/gates.json`; fixed checks that
  are the same for every project live in the hooks, so `update` can deliver them.

## Pipeline

- **Stage** — a unit of planned work with an id (`A0`, `PAY-12`, `v04`), one spec and one branch. The gates
  read the stage from the branch name (`stagePattern`).
- **Spec** — `docs/specs/<stage>/SPEC.md`: acceptance criteria in EARS, unhappy paths, edge cases, numeric
  NFRs, how to verify. **Full** for visible behaviour, **light** (a checklist) for setup work. Approved when
  a human merges it.
- **Local term** — a word a spec defines for itself only, marked `- **Word** (local): …` in its `## Terms`.
  `trace` checks every other Terms entry against this glossary.
- **Acceptance criterion (AC)** — one checkable statement in a spec, with an id (`AC-3`); tests carry the
  id in their names.
- **ADR** — a numbered architecture decision (`docs/adr/NNNN-*.md`): context, decision, rejected
  alternatives, consequences. Accepted when merged.
- **Plan** — `.claude/tmp/<stage>/tasks.json`, written by `/plan`: every criterion covered by a task, each
  task with a `verify` command and a tier. Written once; only `verify` changes it.
- **Task** (in a plan) — one reviewable step, roughly one commit.
- **Tier** — a task's S / M / L. Picks the implementer's model: S/M → Sonnet, L → Opus. L also covers risky
  work at any size: security, auth, money, data migration, concurrency.
- **Verify** — a task's command that fails before the task and passes after it; `.claude/bin/verify` runs
  it and records `passes`.
- **Evidence** — the commands run and their real output, in the report's EVIDENCE section. "Done" without
  it is blocked.

## Driver (ADR-0001)

- **Driver** — `agent-stack run`: runs Claude Code headless one stage at a time, runs the checks itself,
  stops for the human at gates.
- **Step** — one unit of the pipeline the driver executes: clarify, spec, plan, base-check, implement, checks,
  review, commit; a gate is a step that waits for the human. Not a *stage*: a stage is planned work with a
  spec.
- **Run** — one execution of the pipeline for one piece of work; its state is the **run file**
  (`.claude/tmp/runs/<run id>/run.json`), written only by the driver.
- **Live run** — a run whose status is `running` and whose driver process is alive. Two hooks step aside only
  for a live run on its own branch: spec-gate (quick mode) and evidence-gate.
- **Driver call** — a Claude process the driver started, with `AGENT_STACK_RUN=<run id>` in its environment;
  its hooks inherit that variable.
- **Mode** — the path a run takes: **quick** (a small fix: implement → checks → review → accept), **task**
  (clarify → spec → plan → implement → checks → review → accept), **bug** (a failing test first),
  **refactor** (green before and after, tests untouched). There is no separate "big task" mode.
- **Size** — task mode's own verdict on the work: **task** (full spec, one or two tasks), **story** (full spec,
  several tasks), **epic** (several stages; the run proposes a split and stops).
- **Gate** — a point where the run waits for the human: answers, spec merge, plan approval, acceptance,
  limit.
- **Attempt** — one pass of implement → checks → review for a task. Limited (task 3, quick 2); a later
  attempt runs on Opus.
- **Limit gate** — where a run stops when attempts run out, review findings stop shrinking, or the fuse
  blows: one more attempt (on Opus), raise the fuse (only when the fuse blew), or cancel.
  - **Decision** reason: the spec or plan role asked the human instead of doing its job. The human answers,
    and the role runs again with its questions and the answer. A blind re-run would only ask again.
  - **Test conflict** reason: the implementer found an existing test or verify that contradicts a criterion,
    and left it alone. The human fixes the test or the spec, or answers; no attempt is counted.
  - **Tests changed** reason: the task deleted or weakened a test that was there before it, or changed a check
    config (CI, test or lint settings). The human allows the change or sends the task back.
- **Role** — what one Claude call is asked to be: clarify, spec, plan, implement or review. Each role has
  its own tools, model and output schema. Its rules come from the project's skill or agent, never from a copy
  in the driver. The role returns data, and the driver writes the files it owns,
  such as `tasks.json` and the commits.
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

## Harness parts

- **Harness** — what agent-stack deploys into `.claude/`: hooks, `bin/` scripts, subagents, skills,
  settings.
- **Hook** — a script Claude Code runs on an event. **PreToolUse** hooks can block an action; **Stop**
  hooks can send the model back once; **SessionStart** hooks add context.
- **Gates (hooks)** — the blocking hooks that hold the process: **spec-gate** (spec merged, then plan, before
  code), **cheat-guard** (no skipped tests or suppressed checks), **evidence-gate** (no "done" without
  evidence or against the plan), **arch-guard** (no imports across layer boundaries).
- **Guards** — the blocking hooks that hold single actions: **guard-bash** (no push, no foreign package
  manager, ask before download-and-run or reading secrets), **guard-file** (harness files, lockfiles,
  generated files, `tasks.json`).
- **`gates.json`** — the project's settings for the gates. Yours: `update` never rewrites it, so new keys
  get defaults in code.
- **Interactive / autonomous** — `gates.json` → `mode`. Interactive asks the human; autonomous never asks,
  blocks instead, and records decisions under NEEDS HUMAN DECISION.
- **Seed files** — files `init` writes once and `update` leaves alone: `CLAUDE.md`, `CODEMAP.md`,
  `gates.json`, `settings.local.json`.
