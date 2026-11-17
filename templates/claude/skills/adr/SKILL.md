---
description: Record an architecture decision as a numbered ADR (context, decision, rejected alternatives, consequences). Use after a grill settles a decision, or when the user says "write an ADR", "/adr", "record this decision".
argument-hint: "[decision title]"
---

# ADR

Write one decision per file in the ADR directory — `adrDir` in `.claude/gates.json` (default
`{{DOCS_DIR}}adr`). Number = highest existing number + 1, four digits: `0007-queue-for-ingest.md`.

1. Read the existing ADRs first: do not duplicate one, and mark an older ADR `Superseded by NNNN` if this
   one replaces it.
2. Fill `${CLAUDE_SKILL_DIR}/template.md`. Rules:
   - **Context** states the forces and constraints, with numbers where they exist — not the solution.
   - **Alternatives** — the real ones, each with what it would cost us. "Do nothing" counts. Aim for two;
     if the source has fewer, do not invent one to fill the table.
   - **Consequences** — the good *and* the bad we accept. Ask the human for the downside if it is not known.
   - **Say whose words they are.** Text the human did not give you — an alternative, a cost, a downside you
     worked out — ends with "(agent's inference)", so a reader can tell it from the human's reasoning.
   - **Two dates.** "Decided" is when the decision was taken (often before the first commit — ask, or write
     `unknown`); "Recorded" is today.
   - **Applies to** — the stages it shapes, each linked to its SPEC.md, or "All stages (project-wide
     decision)". Every spec listed here has this ADR in its Decisions table, and every spec whose table
     lists this ADR is listed here. A project-wide ADR goes in a spec's table only when the spec cites it.
3. **A boundary decision becomes a rule.** If the ADR says one part of the code must not depend on another
   ("domain does not import infra"), end it with the proposed rule for `layers` in `.claude/gates.json`:
   `{ "name": "…", "files": ["src/domain/*"], "forbid": ["infra/"], "adr": "<this ADR>" }`. The human adds it
   (the agent cannot edit gates.json); from then on the arch-guard hook blocks new imports across it.
4. Status starts as `Proposed`. It becomes `Accepted` when a human merges it — same rule as specs: the MR
   with a remote, a local merge into the base branch without one. When a decision changes, write a new ADR
   with `Supersedes: NNNN`, mark the old one `Superseded by`, and update the specs it applies to (their
   Decisions table and "## Changes").

Keep it short: an ADR is read in two minutes or it is not read.
