<!--
Normative CLAUDE.md sections — emitted VERBATIM into the target repo's CLAUDE.md by the harness
generator. Not a deployed file itself (leading underscore = generator input, not copied as-is).
These two sections are project-agnostic and must transfer unchanged.
-->

## Multi-step migrations

Before any multi-file migration or refactor, write decision invariants to
`.claude/tmp/<task>-plan.md`. Re-read that plan from disk (not memory) immediately before composing
each diff preview, and open every diff preview with a compliance header — e.g.
`Plan check: D1 — ok; D3 — n/a`. Any deviation requires explicit user approval before the diff —
surface it as `ОТКЛОНЕНИЕ ОТ ПЛАНА` with rationale.

## Scope discipline

- **Debug budget for support machinery**: 2 iterations max. On the third, stop and propose to
  simplify or defer the mechanism rather than debug it further.
- **Nesting limit**: if work is more than 2 levels removed from the user's original task, stop and
  ask — continue / simplify / cut.
- **Cost/value framing**: when proposing a new support mechanism, lead with one line —
  cost / value / cost-of-not-implementing.
- **Plan starts with the goal**: the first line of any plan is the user's original goal verbatim; a
  sub-item that does not bring it closer is a candidate for cutting.
