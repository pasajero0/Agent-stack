---
description: Break a merged stage spec into tasks in .claude/tmp/<stage>/tasks.json — every acceptance criterion covered, each task with a verify command and a model tier — on a stage branch. Use when the user says "/plan", "break it down", or right after a spec MR is merged.
argument-hint: "<stage id, e.g. A0>"
---

# Plan stage $ARGUMENTS

## Preconditions

- The spec is merged: `git cat-file -e origin/<base>:<specsDir>/$ARGUMENTS/SPEC.md` succeeds (`git fetch`
  first), or — when there is no `origin/<base>` — the same with the local `<base>`. That is the branch
  spec-gate reads. `baseBranch` and `specsDir` are in `.claude/gates.json`. If not — stop: no plan before
  the merge.
- Read the merged spec in full, and the ADRs it links.

## Steps

1. **Work on a stage branch:** update the base branch, then create a branch whose name `stagePattern` (in
   `.claude/gates.json`) maps to this stage — `$ARGUMENTS-<short-name>` with the default pattern,
   `f-$ARGUMENTS` with the feature-name one. The stage comes from the branch name — that is what opens the
   spec-gate for this stage and nothing else.
   **Light spec** (`light: true`): no test tasks — each task's `verify` is the `Check:` command of its ACs,
   and the last task runs them all.
2. **Write `.claude/tmp/$ARGUMENTS/tasks.json`** (the file can be written once — after that only
   `.claude/bin/verify` updates it; to re-plan, `rm` it and write a new one). Claude Code asks the human to
   approve a write under `.claude/`; with no one to approve, the write is denied, so say that and stop.
   Under the driver (`agent-stack run`), do not write the file at all: return the tasks, and the driver writes
   it:

   ```json
   { "stage": "$ARGUMENTS",
     "tasks": [
       { "id": "T1", "ac": ["AC-1", "AC-2"], "desc": "tests and code for AC-1, AC-2",
         "tier": "S", "verify": "<command that fails now and passes when T1 is done>", "passes": false } ] }
   ```

   - **Every AC id appears in at least one task.** Every task lists its ACs.
   - **Every task ends green.** A task is done only when its `verify` passes — there are no test-only
     tasks that leave red tests behind for a later task.
   - **Tests first, inside each task:** the task writes its failing tests (via `test-writer`), sees them
     fail, then writes the code that makes them pass. Every test names its criterion with the stage in
     front — `it("$ARGUMENTS AC-3: counts duplicates")`, `def test_$ARGUMENTS_AC_3_counts_duplicates()` —
     so `.claude/bin/trace` can link spec and tests.
   - **Last task:** `"verify": ".claude/bin/trace && .claude/bin/health && <full test command>"` — every
     criterion has a test, no test invents one, code health within its SLOs, everything green.
   - **`verify` is a real check of this task only** — tests filtered by AC id, a type check, a script.
     Never `true`, except a task that changes only documentation (Markdown, comments, no behaviour), whose
     verify is `true`: the driver accepts exactly that. Never the whole suite unless the task is "everything
     green".
   - **`verify` must be able to fail.** No `|| true`, `|| :`, `|| echo`, `|| exit 0`, `; true`, `; exit 0`,
     `set +e`, `set +o errexit`, `| tee` or `| cat`, and no last line `true` or `exit 0`: such a command passes
     whatever the code does. The driver refuses a plan with one.
   - **A missing test file must be red.** A runner given a file list may skip a file that does not exist yet
     and pass. So a verify that names test files starts with `test -f <file> &&` for each one.
   - **One task = one reviewable step** (roughly one commit). Split anything bigger.
3. **Assign a tier** to each task — it picks the implementer's model:

   | Tier | When | Implementer model |
   | --- | --- | --- |
   | S | mechanical, one file, pattern already in the codebase | `sonnet`, low effort |
   | M | normal feature work across a few files | `sonnet` |
   | L | new design, concurrency, data migration, security, money, auth | `opus` |

   Under the driver (`agent-stack run`), a retry runs on Opus. By hand, after two failed `verify` runs move
   the task one tier up (`.claude/bin/verify` prints the hint).
4. **Run `.claude/bin/verify`** once: every task should fail now (red). A `verify` that already passes
   proves nothing — fix it. Under the driver, skip this step: the driver runs each task's verify before its
   first attempt and notes one that is already green.
5. Show the plan to the human as a table (id, ACs, tier, verify) before implementing.

## Then

Under the driver (`agent-stack run`): stop here — the driver runs the tasks, checks and commits.

By hand: implement one task at a time with the `implementer` subagent (model per tier) — its tests
first, then the code — run `.claude/bin/verify <id>` after each, commit, next. Report with the contract
from CLAUDE.md.
