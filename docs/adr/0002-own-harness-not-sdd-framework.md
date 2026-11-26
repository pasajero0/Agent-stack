# 0002. We build our own harness and take ideas from spec-driven frameworks, not the frameworks

- **Status:** Proposed <!-- Accepted once a human merges it -->
- **Decided:** 2026-11-18 (the framework analysis of 17–18/11 and ADR 0001; kept in the roadmap, not in git)
- **Recorded:** 2026-11-26
- **Applies to:** All stages (project-wide decision)
- **Supersedes:** —

## Context

- **Spec-driven development (SDD) frameworks are the industry default** for agent work in 2026: GitHub Spec Kit,
  OpenSpec, BMAD Method, AWS Kiro, Superpowers, and many Claude Code frameworks (GSD, agent-os, ccpm, cc-sdd,
  claude-task-master, SuperClaude and others). People who start with agents are told to pick one.
- **What they share:** a spec before the code, a plan cut into tasks, and a fixed list of steps.
- **What they hold, and how** (from their docs and code, read 17–18/11):

  | Framework | Steps | Who holds the order | Strong part |
  | --- | --- | --- | --- |
  | GitHub Spec Kit | constitution → specify → clarify → plan → tasks → implement | the model in a chat; an outside engine in `specify workflow run` (`claude -p` per step, gates with pause and resume) | the clarify question format; the workflow engine |
  | OpenSpec | propose → apply → archive; a change is a delta (ADDED / MODIFIED / REMOVED) | nobody; `openspec validate` checks the format before archive | `validate` without a model; archive merges deltas into a living spec |
  | BMAD Method | analyst → PM → architect → PO → scrum master → dev → QA personas | the model and the human, story by story | "sharding": the developer loads only its own story |
  | AWS Kiro | EARS requirements → design → tasks, a human approval between phases | the product | EARS; three modes (vibe, quick spec, spec) |
  | Superpowers | brainstorm → plan of 2–5 minute tasks → subagent per task, test first | prompt text and a SessionStart injection | small tasks, red test before code |

- **The gap they leave.** In all of them the order of steps lives in prompts, or in an engine that turns the
  agent's own guards off. Superpowers measured a skipped design step in 24 of 24 runs, and 3 of 24 after
  hardening. The Spec Kit engine runs `claude -p` with `--dangerously-skip-permissions`. None links each
  criterion to a test by a program.
- **The verbosity cost.** Practitioners report that teams drop heavy frameworks within weeks: dozens of
  documents and steps for a one-line fix (video «AI workflow, 8 months later», 26/11).
- **Our promise is enforcement outside the model** (D1, ADR 0001). A framework that keeps order in text cannot
  carry that promise.
- Sources (local, not in git): `.claude/tmp/sources/openspec-speckit-2026-11-18.md`,
  `pipeline-research-2026-11-17.md`, `market-pipelines-2026-11-19.md`, `sdd-video-2026-11-25.md`,
  `kyrylo-pipeline-video-2026-11-26.md`.

## Decision

We do not adopt an SDD framework, as a dependency or as a base. We keep our own harness (hooks, gates, `trace`,
`verify`) and our driver (ADR 0001), and we copy single ideas from the frameworks when a recorded miss asks for
them (D9). Each idea we take names its source.

**Taken:**
- the Spec Kit workflow engine → `agent-stack run`: `claude -p` per step, gates with pause and `--resume`
  (ADR 0001), but with our hooks on;
- the Spec Kit clarify format → the clarify step: at most 5 questions, each with a recommended answer;
- Kiro → EARS criteria with ids; quick and task modes;
- BMAD sharding → the implementer gets only the text of its task's criteria;
- Superpowers → a failing test before the code, one task per commit;
- OpenSpec → planned, not built: the living spec (deltas merged at the end of a stage) and a spec check without
  a model.

## Alternatives considered

| Option | Why not (what it would cost us) |
| --- | --- |
| Adopt Spec Kit | its order lives in prompts in a chat; its engine turns permissions off. We would lose spec-gate, evidence-gate and the guards — the product itself |
| Adopt OpenSpec | nothing holds the order; we would add our gates on top of its folder layout and depend on its format changes |
| Adopt BMAD | role personas in prompts; we removed personas in V2 because they added text, not checks |
| Build on Kiro | a separate IDE product, not Claude Code (D1) |
| Ship as a Spec Kit or OpenSpec extension | their extension hooks are prompt hooks; our hooks are real `PreToolUse` and `Stop` hooks. We would be bound to their release cycle (agent's inference) |

## Consequences

- **Good:** the order of steps, the test of each criterion and the guards stay in code; we keep our own steps
  small (quick mode, a light spec) instead of a framework's full list. Planned (Leonid 26/11): three pipelines by
  task size, quick / light / full, so a medium task does not pay for a full spec.
- **Bad, accepted:** people who know Spec Kit or OpenSpec meet new words and a new layout; we maintain the
  pipeline ourselves; ideas from the frameworks reach us only when we copy them.
- **Follow-ups:** README says in one line how agent-stack differs from an SDD framework; the living spec (7.12)
  and a spec check without a model stay in the roadmap, by D9.
