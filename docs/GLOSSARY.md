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
- **The harness is stack-agnostic.** Stack-specific settings live in `.claude/gates.json`; fixed checks that
  are the same for every project live in the hooks, so `update` can deliver them.

## Pipeline

- **Stage** — a unit of planned work with an id (`A0`, `PAY-12`, `v04`), one spec and one branch. The gates
  read the stage from the branch name (`stagePattern`).
- **Spec** — `docs/specs/<stage>/SPEC.md`: acceptance criteria in EARS, unhappy paths, edge cases, numeric
  NFRs, how to verify. **Full** for visible behaviour, **light** (a checklist) for setup work. Approved when
  a human merges it.
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
- **Fuse** — the run-wide cost cap (`run.fuseUsd`). Not a budget: it stops a run that went wrong. On a
  subscription the dollars are a measure of work, not money.
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
