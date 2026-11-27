<!--
Normative CLAUDE.md sections — emitted VERBATIM into the target repo's CLAUDE.md by the harness
generator. Not a deployed file itself (leading underscore = generator input, not copied as-is).
These sections are project-agnostic and must transfer unchanged.
-->

## Explaining to the human

Explain as simply as possible — the human decides from your reply, so it must be readable when tired.

- Lead with the answer in one or two plain sentences. Details come after, or go into a file.
- When proposing a change, show **now → proposed** side by side, with one concrete example.
- Few options: recommend one. End with one question the human can answer with yes/no or a choice.

Write every sentence for a reader whose English may not be native. These rules hold for replies, docs,
prompts and commit bodies:

- **Short.** About 20 words for a step, 25 for an explanation. One action per step. Put the condition
  first: "If X, do Y".
- **Name who acts:** "spec-gate blocks the edit", not "the edit is blocked".
- **One thing, one word.** Once you name a thing, use that word every time — the glossary word, if the
  project has a glossary. Explain a term the first time, or do not use it.
- **Plain verbs, no phrasal verbs or idioms:** "start", not "kick off"; "remove", not "get rid of".
- **Shorter must not change the facts:** keep numbers, names, the reason why, and what was not checked.

## Spec-driven workflow

The driver runs the steps: `agent-stack run` in a terminal, or `/drive` from a chat. A chat does not write code
itself: spec-gate refuses a chat's code edit (`codeBy` in `.claude/gates.json`). Each step keeps its rules in one
file:

| Step | Rules in |
| --- | --- |
| questions (grill, clarify) | `.claude/skills/grill/SKILL.md` |
| spec | `.claude/skills/spec/SKILL.md`, `.claude/agents/spec-reviewer.md` |
| plan | `.claude/skills/plan/SKILL.md` |
| implement | `.claude/agents/implementer.md` |
| checks | `.claude/bin/verify`, `.claude/bin/trace`, `.claude/bin/health` |
| review | `.claude/agents/code-reviewer.md` |

Hooks hold the steps:

- **spec-gate** refuses code before the stage's spec is merged, and a chat's code edit (`codeBy`).
- **cheat-guard** blocks skipped tests and suppressed checks (`.skip`, `@ts-ignore`, `any`, …).
- **arch-guard** blocks new imports across layer boundaries.
- **guard-file** blocks edits of the harness, the driver's run folder, generated files and secrets.

**Drift, measured like a service.** `.claude/bin/health` measures what the branch changed (file size,
new dependencies, project metrics such as complexity) against SLOs in `.claude/gates.json` and appends
each run to `.claude/tmp/health.jsonl`. arch-guard blocks new imports across layer boundaries. A broken
SLO or boundary is fixed — or justified in an ADR, after which the human raises the limit.

## Report contract

Finish every stage, task or autonomous run with:

```
STATUS: DONE | IN PROGRESS | BLOCKED
DONE: what is finished
NOT DONE: what is left
EVIDENCE: the commands run and their real output — a claim without evidence is not done
RISKS: what may break, what was not checked
NEEDS HUMAN DECISION: questions only the human can answer (never guessed)
```

## Modes

`mode` in `.claude/gates.json` — switched only by the human.

- **interactive** (default): show each diff and wait for confirmation before applying it.
- **autonomous**: diffs need no confirmation. Hard limits stay: never install anything from outside
  (guard-bash denies it), never push. Commit per phase — Conventional Commits, the phase in the
  subject, what and why in the body. A decision you cannot make → NEEDS HUMAN DECISION, then move to
  the next item; never guess. The human fixes up in the morning.

## Model routing

Pick the subagent by the work, not by habit. Delegation is not free — every subagent loads its own
context — so do trivial things directly and delegate when it buys a cheaper model or a clean context.

| Work | Subagent | Model |
| --- | --- | --- |
| fact lookups in the repo | researcher | haiku |
| one task from tasks.json | implementer | from `.claude/gates.json → routing` |
| tests from acceptance criteria | test-writer | sonnet |
| spec review, code review, task analysis | spec-reviewer, code-reviewer, task-analyzer | opus |

The implementer's model and effort live in one place: `.claude/gates.json → routing`. Under the driver
(`agent-stack run`), the routing picks them from the task's tier × complexity (its cell), and a retry uses
`routing.retry`. By hand, spawn the implementer with the model of the task's cell; if a task fails `verify`
twice, by hand, use the model of `routing.retry`. Every task ends green.

## Multi-step migrations

Before a multi-file migration or refactor, follow the migration skill (.claude/skills/migration/SKILL.md).

## Scope discipline

- **Debug budget for support machinery**: 2 iterations max. On the third, stop and propose to
  simplify or defer the mechanism rather than debug it further.
- **Nesting limit**: if work is more than 2 levels removed from the user's original task, stop and
  ask — continue / simplify / cut.
- **Cost/value framing**: when proposing a new support mechanism, lead with one line —
  cost / value / cost-of-not-implementing.
- **Plan starts with the goal**: the first line of any plan is the user's original goal verbatim; a
  sub-item that does not bring it closer is a candidate for cutting.
