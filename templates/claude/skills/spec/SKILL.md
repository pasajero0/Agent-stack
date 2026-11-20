---
description: Write a stage spec (SPEC.md) with acceptance criteria in EARS notation — happy path, unhappy path, edge cases, numeric NFRs, verification commands — get it reviewed by the spec-reviewer subagent, and prepare it for a human-merged MR. A light spec (checklist) for setup work. Use when the user says "/spec", "write the spec", or a grill is finished.
argument-hint: "<stage id> [what it is about], e.g. A0 ingest of meter readings"
---

# Spec for $ARGUMENTS

**The stage id is the first word of the arguments** (`A0` in `A0 ingest of meter readings`); the rest is
only a description. Below, `<stage>` means that id — never put the description into a path.

A spec is approved when a **human merges it into the base branch**. Until then the spec-gate hook blocks
every code edit for the stage. So the spec must be good enough to build from without asking again.

## Full or light?

- **Full spec** — the stage has behaviour a user or a client can see: an API, a screen, a CLI command.
- **Light spec** — setup or mechanical work with nothing to see: scaffold, tooling, CI, a dependency bump,
  a move. Write `<specsDir>/<stage>/SPEC.md` from `${CLAUDE_SKILL_DIR}/light-template.md`, keeping its
  sections (the template is the one list of them): a checklist of `AC-n`, each with the command that proves it.
  No unhappy-path partners, no spec-reviewer. Then go to step 8. If the work turns out to have behaviour, switch to a full spec. A
  "## Changes" entry that turns a full spec light says why — trace stops checking its tests.

## Steps (full spec)

1. **Grill first.** If the stage has not been grilled, run `/grill` — a spec written from guesses only
   moves the guessing later.
2. **Write** `<specsDir>/<stage>/SPEC.md` (`specsDir` in `.claude/gates.json`, default `docs/specs`)
   from `${CLAUDE_SKILL_DIR}/template.md`.
3. **Acceptance criteria** — each one:
   - has a unique id (`AC-1`, `AC-2`, …) — tests will carry these ids in their names;
   - uses an EARS pattern and an observable outcome — something a test can check. The patterns (reference
     only — do not copy this table into the spec):

     | Pattern | Form |
     | --- | --- |
     | Always | `THE SYSTEM SHALL …` |
     | Event | `WHEN <trigger>, THE SYSTEM SHALL …` |
     | State | `WHILE <state>, THE SYSTEM SHALL …` |
     | Unwanted | `IF <condition>, THEN THE SYSTEM SHALL …` |
     | Option | `WHERE <feature is enabled>, THE SYSTEM SHALL …` |

   - **every happy-path criterion has at least one unhappy-path partner** (`IF … THEN THE SYSTEM SHALL …`);
   - every edge case from the grill is either a criterion or listed under "Out of scope";
   - a criterion that follows from a decision cites its ADR: `(ADR-0003)`, and that ADR is in the
     Decisions table. The ADR lists this stage under "Applies to", unless it is project-wide.
   - A stage with several parts (Backend and Frontend, api and web) groups criteria by part; ids run on.
   - a new named concept (a state, role, reason, mode, gate) is an entry in `## Terms`. If the project has a
     glossary, add a shared word there in the same change, or mark it `(local)`. Check it with
     `.claude/bin/trace --terms <stage>` (terms only, so it works before there are tests).
4. **Constraints** — fill `## Constraints`: what the builder must not add without asking (tables, services,
   languages, dependencies), what it must keep (contract versions, how outside input is checked), and which
   goal wins when two conflict. Each line names how it is checked; an agent with no stated limit is free to
   add a table or a package.
5. **NFRs only with numbers** ("p99 < 300 ms at 50 rps"), never "fast" or "scalable".
6. **How to verify** — the exact commands (tests filtered by AC id, load profile, manual check).
7. **Review.** Run `.claude/bin/trace --terms <stage>` and fix what it names. Then run the `spec-reviewer` subagent on the file. Fix every blocker; argue or fix the rest.
   Repeat until it returns PASS (max 3 rounds — then list what is left under NEEDS HUMAN DECISION).
   Skipping the review is allowed only when the human says so; then say in the report that it was skipped.
8. **Hand over.** Commit the spec (and its ADRs) on a branch `spec/<stage>` and tell the human it is ready:
   - **with a remote:** they push, open the MR, review and merge. Never push yourself.
   - **local only** (no `origin/<base>`): the human reviews the branch and merges it into the local base
     branch (`git merge spec/<stage>`) — that merge is the approval. Once `origin/<base>` exists, spec-gate
     reads only that, and a local merge no longer counts.
   - **no commits yet:** the gate stays open until the first commit. Commit the scaffold to the base branch
     first, then branch `spec/<stage>` from it — a first commit on `spec/<stage>` would leave no base branch
     to merge into.

## Changing a merged spec

Requirements change; the spec must stay true. Change it in the stage branch, **before** the code:

1. Edit the criterion in place (do not leave the old one beside it) and add an entry under "## Changes":
   date — what changed (AC ids) — why (link the ADR if it was a decision).
2. Commit it alone: `docs(<stage>): spec — <what changed>` (the form the driver uses; `spec:` is no Conventional
   Commits type, so commitlint refuses it).
3. Then update the tests for the changed criteria (they must fail first), then the code.

The spec-gate enforces the order: code is closed while the spec has uncommitted edits, or when it differs
from the base branch without a "## Changes" entry. One MR carries both; the human reviews and merges once.
