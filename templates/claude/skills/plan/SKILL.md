---
description: Break a merged stage spec into tasks in .claude/tmp/<stage>/tasks.json — every acceptance criterion covered, each task with a verify command, a tier and a complexity — on a stage branch. Use when the user says "/plan", "break it down", or right after a spec MR is merged.
argument-hint: "<stage id, e.g. A0>"
---

# Plan stage $ARGUMENTS

## Preconditions

- The spec is merged: `git cat-file -e origin/<base>:<specsDir>/$ARGUMENTS/SPEC.md` succeeds (`git fetch`
  first), or — when there is no `origin/<base>` — the same with the local `<base>`. That is the branch
  spec-gate reads. `baseBranch` and `specsDir` are in `.claude/gates.json`. If not — stop: no plan before
  the merge. With `specFlow: "branch"` in `.claude/gates.json`: the spec is committed on the current branch
  (`git cat-file -e HEAD:<specsDir>/$ARGUMENTS/SPEC.md`) and the human approved it; stay on this branch and
  skip step 1.
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
         "tier": "S", "complexity": "low",
         "verify": "<command that fails now and passes when T1 is done>", "passes": false },
       { "id": "T2", "ac": ["AC-3"], "desc": "rename the config loader in every module",
         "tier": "L", "complexity": "low", "splitReason": "rename used by all modules",
         "verify": "<command that fails now and passes when T2 is done>", "passes": false } ] }
   ```

   - **Every AC id appears in at least one task.** Every task lists its ACs.
   - **Every task ends green.** A task is done only when its `verify` passes — there are no test-only
     tasks that leave red tests behind for a later task.
   - **Tests first, inside each task:** the task writes its failing tests, sees them
     fail, then writes the code that makes them pass. The test name rule lives in
     `.claude/agents/implementer.md`.
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
3. **Assign a tier and a complexity** to each task (see `## Complexity`). Tier × complexity is the task's
   cell; under the driver, `.claude/gates.json → routing` picks the implementer's model and effort for it:

   | Tier | When |
   | --- | --- |
   | S | mechanical, one file, pattern already in the codebase |
   | M | normal feature work across a few files |
   | L | new design, concurrency, data migration, security, money, auth |

   Under the driver (`agent-stack run`), a retry runs on the retry route (`routing.retry`). If a task fails
   `verify` twice: by hand, use the model of `routing.retry` (`.claude/bin/verify` prints the hint).
4. **Run `.claude/bin/verify`** once: every task should fail now (red). A `verify` that already passes
   proves nothing — fix it, except a docs-only task's `true`, which is green by design. Under the driver, skip this step: the driver runs each task's verify before its
   first attempt and notes one that is already green.
5. Show the plan to the human as a table (id, ACs, tier, complexity, verify) before implementing.

## Complexity

Answer four yes/no questions for each task:

1. Is there a pattern in the code to copy? (towards low)
2. Is there more than one reasonable solution? (at least medium)
3. Does the spec leave a decision open, or is the logic not obvious: edge cases, order, state? (at least medium)
4. Does it touch security, money, data or concurrency? (high)

The rule: high when question 4 is yes; else medium when question 2 or 3 is yes, or question 1 is no; else low.
A task with no pattern to copy is never low.

**Tier L and splitting.** Split an L task with logic into blocks when each block can leave the tree green
(expand-contract: add the new beside the old, move the code block by block, remove the old). Keep one L task
only when the change is atomic (a state in between does not build or pass) or purely mechanical (a rename across
many files). Then the complexity comes from the logic, not the number of files: an atomic mechanical rename is
L · low. Every L task has a `splitReason`: one line, at most 80 characters, on why it is not split.

## Then

Under the driver (`agent-stack run`): stop here — the driver runs the tasks, checks and commits.

By hand: implement one task at a time with the `implementer` subagent, spawned with the model of the task's
cell in `.claude/gates.json → routing` — its tests
first, then the code — run `.claude/bin/verify <id>` after each, commit, next. Report with the contract
from CLAUDE.md.
