# 0005. The model and effort follow the task size; only checked work gets a cheap model

- **Status:** Proposed <!-- Accepted once a human merges it -->
- **Decided:** 2026-11-25 (the effort1 and scout1 grills, release 0.4.8)
- **Recorded:** 2026-11-26
- **Applies to:** All stages (project-wide decision). Details: [effort1](../specs/effort1/SPEC.md),
  [scout1](../specs/scout1/SPEC.md).
- **Supersedes:** —

## Context

- **Before 0.4.8** the driver chose only the implement model (Opus for tier L, a risky task or a retry, else
  Sonnet) and never passed `--effort`, so every call ran at Claude Code's default level. The `/plan` skill
  promised "low effort" for tier S anyway (defect #41).
- **The roles before code read the repo from nothing.** One spec call in evals1 cost $6.61; most of its tokens
  were re-reads from cache. In effort1's run the first spec step took 39:42.
- **The rule "cheapen mechanics, never judgment"** (GLOSSARY): a cheap model only where a program checks the
  result afterwards. Superpowers measured 0 of 10 defects caught by reviewers on a small model.

## Decision

- **Implement gets a route** (`model·effort`) from `gates.json → routing`: the retry route first, then the
  risky route, then the cell of tier (S / M / L) × complexity (low / medium / high). The mapping is data; its
  one default is `templates/claude/_routing.json`, and no route lives in TypeScript code.
- **A task run starts with a scout:** one read-only call on `routing.scout` (default haiku · low) lists up to 30
  files and line ranges. The driver checks that the paths exist; clarify, spec and plan read them first.
- **Judgment stays strong:** clarify, spec, plan and review keep Opus and get no route.

## Alternatives considered

| Option | Why not (what it would cost us) |
| --- | --- |
| One model and effort for all calls | The 0.4.7 state; small tasks pay Opus prices, and tier S's "low effort" was a false promise (defect #41) |
| A cheap model for review or spec too | Nothing checks those results after them; a missed defect in review costs more than the tokens (GLOSSARY) |
| Routes in code | A human cannot read or change them, and the `/plan` skill, glossary and code drift apart (effort1 lists six copies) |

## Consequences

- **Good:** evals 21/21 and pass^3 = 1 after the change; a human can change any route in `gates.json`; the
  route shows on the plan card.
- **Bad, accepted:**
  - the gain of the scout for spec is not measured yet (rule: spec ≥ 20 % cheaper and faster, scout ≤ $0.05);
  - an old `tasks.json` without `complexity` is refused, not given a default;
  - clarify, spec, plan and review are fixed to Opus in code (`src/run/engine/call.ts`), so a new model there
    needs a code change.
- **Follow-ups:** a route per role and full model ids in routing; the scout's own timeout — both in the roadmap
  backlog.
