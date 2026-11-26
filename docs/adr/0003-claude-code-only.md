# 0003. The harness enforces rules for Claude Code only

- **Status:** Proposed <!-- Accepted once a human merges it -->
- **Decided:** 2026-06-16 in code (`55518a4`, the provider layer removed); written as rule D1 in the v0.2 plan,
  2026-10-22/23
- **Recorded:** 2026-11-26
- **Applies to:** All stages (project-wide decision)
- **Supersedes:** —

## Context

- **The early code had a provider layer** (`src/providers/`: a registry, a `ProviderAdapter` type and one
  Claude Code adapter). Only one adapter ever existed. Commit `55518a4` (2026-06-16) removed the layer: "a
  single provider doesn't need the registry / ProviderAdapter polymorphism".
- **Our promise is enforcement outside the model** (GLOSSARY, ADR 0001). It needs real hook events that can
  block an action: `PreToolUse`, `Stop`, permissions, the OS sandbox, `claude -p` with `--json-schema`. Each
  agent has its own events, or none. One rule would need one adapter and one set of tests per agent.
- **Context files are a different thing.** `AGENTS.md` is read by Codex, Cursor, OpenCode and others. Sharing
  context with them is not enforcement (decision of 2026-10-22).
- **Models.** The driver and the routing name Claude models only (`opus`, `sonnet`, `haiku`,
  `src/run/routing.ts`). The reviewer runs on a model no weaker than the implementer's (ADR 0001).

## Decision

The harness enforces rules for **Claude Code only**: hooks, gates, the driver and the sandbox block target
Claude Code and Claude models. We write no adapter for another agent and no second model provider. Other
agents may read the project context (`AGENTS.md`), but nothing enforces rules for them.

## Alternatives considered

| Option | Why not (what it would cost us) |
| --- | --- |
| Keep the provider layer for later agents | One adapter in six months; the layer added code and tests and held nothing (`55518a4`) |
| Adapters for Codex, Cursor, OpenCode | Each needs its own hook events, permission model and tests; some have no blocking hook, so the promise breaks there (agent's inference) |
| A second model as reviewer (Codex, another vendor) | Rejected in the roadmap ("Не берём": models not from Claude, Codex as second reviewer); a fresh Claude context with a rubric is the reviewer (ADR 0001) |

## Consequences

- **Good:** one set of hook events to test; every guard is checked against the real `claude`; the README can
  promise only what was verified (D8).
- **Bad, accepted:** people who use other agents get the context files, not the gates; a change in Claude Code
  (a hook event, a flag) reaches us directly, and we follow its releases.
- **Follow-ups:** the version of Claude Code we check against is named in the CHANGELOG of each release.
  Changing the working model without a code change (a role's model in `gates.json → routing`, full model ids)
  stays in the roadmap backlog.
