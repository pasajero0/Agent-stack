# 0001. A driver program holds the pipeline order

- **Status:** Proposed
- **Decided:** 2026-11-18
- **Recorded:** 2026-11-18
- **Applies to:** All stages (project-wide decision)
- **Supersedes:** —

## Context

- **The promise of agent-stack is enforcement outside the model.** Guards already do this for single actions
  (`git push`, foreign package managers, secret reads). The order of the pipeline does not: it lives in
  skills (`/spec` → `/plan` → `tasks.json` → `verify` → `evidence-gate`) that the model may or may not call.
- **The recorded miss (D9).** In the lex-poc trial `/plan` was never called. With no `tasks.json`,
  `evidence-gate` exits early (`evidence-gate.sh:16`), so no "done" claim was checked at all.
- **Text alone does not hold.** Superpowers, which keeps order purely by prompt text plus a SessionStart
  injection, measured a skipped design step in 24 of 24 runs, and still 3 of 24 after hardening.
- **Two working patterns exist.**
  - Inside harnesses, order is held by permissions and gates: plan mode as a permission set (Mistral Vibe,
    OpenCode); verify-on-stop (Hermes).
  - Outside, a program runs the agent stage by stage: Purple Flow (`run.json` → `next`, `engine.ts drive()`),
    the Spec Kit workflow engine (`claude -p` per stage, success = exit 0), OpenHands `/goal`.
- **The human must stay in the loop.** The main mode is interactive (M8). A driver runs `claude -p`, which has
  no human in it, so human decisions have to happen in the driver's own pauses.
- **Purple Flow is the reference for order, not for safety.** It runs every role with `bypassPermissions`,
  disables all hooks by default (`--settings {"disableAllHooks":true}`), copies `.env` into worktrees, and
  parses verdicts out of free text.
- Sources: `.claude/tmp/sources/ideas-7.1-2026-11-18.md` and the four notes it cites (local, not in git).

## Decision

We add `agent-stack run`, a driver that holds the pipeline order in code in **every** mode. It runs Claude
Code headless one stage at a time. It runs the checks itself and decides by exit code. It pauses for the human
at fixed gates. The stage order and the engine follow Purple Flow; the safety model stays ours.

**Engine.**
- One state file per run, `.claude/tmp/<stage>/run.json`: `mode`, `next`, `attempts`, `feedback`, `gates[]`,
  `baseCommit`, `session`. The agent cannot edit it; guard-file protects it like `tasks.json`.
- An explicit transition table, not transitions scattered over the stages (Purple Flow scatters them;
  agent's inference).
- Every way back (red checks, blocking review, human rejection) writes `feedback` and returns to implement.
- Attempts are limited: quick 2, others 3. When they run out, or review findings stop shrinking, the run
  stops at a ✋ `limit` gate.
- An infrastructure failure (quota, timeout) does not use up an attempt.
- Resume after a crash continues from `git status` and `tasks.json`.

**Modes in v1.**

| Mode | Stages |
| --- | --- |
| quick | implement → checks → review (only above a diff size) → ✋ accept |
| task | clarify → ✋ answers + size → spec + plan → ✋ approve → implement (one task at a time) → checks → review → ✋ accept |
| bug | clarify → plan = a failing test only; the driver confirms it is red, then the test file is locked → ✋ approve → implement → checks → review → ✋ accept |
| refactor | baseline (must be green) → clarify → plan → ✋ approve → implement → checks + no test files changed → review → ✋ accept |

- **There is no separate "big task" mode.** The task mode's clarify stage sizes the work as task, story or
  epic and proposes the split. The human confirms it at the first gate.
  - task: one `tasks.json`, a light spec.
  - story: one stage spec with several tasks.
  - epic: several stages, each its own spec, branch and run.
- "Auto" mode selection is left for later.

**Human gates.**
- ✋ answers + size (task, bug and refactor).
- ✋ approve. Spec approval stays Q2: the spec MR is merged by a human. The driver pauses until the merge and
  then resumes.
- ✋ accept: the diff, the review verdicts and the check results. The human answers accept, reject (back to
  implement with a comment) or cancel.
- ✋ limit.
- Commit is made by the driver. Push and merge stay manual (D2).

**Checks are the driver's.**
- The driver runs `.claude/bin/verify`, tests and lint against a baseline taken before the task.
- A newly failing test blocks; an already failing one is marked pre-existing.
- The model never reports "passed".
- The reviewer's verdicts come back through `--json-schema`.

**Review.**
- One reviewer, two verdicts: spec compliance and quality (Superpowers, June 2026).
- The reviewer gets the task, the executor's report as unverified claims, and the diff `BASE..HEAD`.
- It runs on Claude with a fresh context, on a model no weaker than the executor's and never haiku (D1).

**Safety invariants of the driver.**
- Hooks stay on: no `--bare`, no `bypassPermissions`, no `disableAllHooks`.
- Read-only roles get read-only tools (`--tools`).
- Every run has `--max-budget-usd` and `--max-turns`.
- A hook's `ask` inside a headless run is a denial. The agent reports it as NEEDS HUMAN DECISION and the
  driver shows it at the next gate.

**Plain `claude` sessions keep the hooks as the safety net.**
- spec-gate stays as it is.
- New: no code edits on a stage branch without `tasks.json`.
- New: no "done" after code edits without a fresh `verify`.

## Alternatives considered

| Option | Why not (what it would cost us) |
| --- | --- |
| Hook gates only (each stage needs the previous artifact) | Fits the 22/10 decision "methodologies sit on top", but it only catches what is visible in actions and cannot make a step happen. It stays as the fallback for plain sessions, not as the main path (agent's inference). |
| Driver only in autonomous mode, hooks in interactive | Order would again depend on the model in the main mode, which was the lex-poc failure. Rejected by Leonid 18/11. |
| Built-in Dynamic workflows (`.claude/workflows/*.js`) | No human input in the middle of a run, so the ✋ gates of the Purple Flow order cannot exist. It also needs paid plans and resumes only in the same session. |
| Use Purple Flow as is | It disables our hooks and bypasses permissions, needs Electron and the OpenSpec CLI, and keeps its knowledge outside git. |
| Do nothing; keep order in skills and delete the unused chain | Breaks D11, the main principle of the harness. |

## Consequences

- **Good:**
  - The trial failure becomes impossible on the driver path: a stage cannot be skipped.
  - "Done" is decided by programs, not by the model's words.
  - The `tasks.json` → `verify` → `evidence-gate` chain finally has a caller, so stage 3 cleanup keeps it.
- **Bad, accepted:**
  - This is a large feature. Estimate for v1 (all four modes, gates, baseline, review, resume, fake `claude`
    for e2e tests): ≈ 25–30 h (agent's inference). The D9 budget is stretched; D11 justifies it.
  - Inside a driver run the human cannot chat freely with the model, only answer at gates.
  - The 22/10 decision "methodologies sit on top of the harness" is reversed: agent-stack now ships its own
    pipeline.
  - Every headless run costs real money. Caps are mandatory and the e2e tests use a fake `claude`.
- **Follow-ups:**
  - Specs for the driver by parts: engine + quick/task; bug + refactor; baseline compare; review.
  - The plain-session gates (no `tasks.json` → no code; no fresh `verify` → no "done").
  - How quick and bug runs pass spec-gate without a full spec: the run mode is read from `run.json`, which only
    the driver writes (agent's inference — to settle in the engine spec).
  - Browser check (7.11) together with V9, later.
  - Worktree per run after 2.W1–2.W7.
