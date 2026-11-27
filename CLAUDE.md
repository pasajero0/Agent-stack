# agent-stack — Claude Code project guide

CLI that deploys a **Claude Code** harness (hooks, gates, subagents, skills) onto a repository and
manages MCP servers. Single-package ESM TypeScript CLI. Claude Code only — earlier multi-provider
ideas live in git history, not in the code.

Version: see `package.json`; themes by version: `CHANGELOG.md` (0.4.x = the driver, 0.5.x = security and isolation). The one plan (order of work, open decisions,
backlog, security audit): `.claude/tmp/roadmap-plan.md`. Inputs it cites: `.claude/tmp/sources/`; done plans:
`.claude/tmp/plans-done.md`.

## Stack & tooling

- **Language**: TypeScript, ESM only (`"type": "module"`; ES2022; `moduleResolution: bundler`;
  `strict`; `isolatedModules`). Use `.js` extensions in relative imports.
- **Build**: tsup (esbuild) → `dist/` (ESM + `.d.ts` + sourcemaps). Entry `src/index.ts`; the bin
  shim `bin/cli.mjs` imports the built output.
- **Tests**: vitest — `tests/**/*.test.ts`, mirroring `src/` layers; `tests/hooks/` runs the shell
  hooks in temp repos (needs bash, git, jq); `tests/e2e/` runs `generate` end to end. `pnpm test`.
- **Static gate**: `pnpm typecheck` (`tsc --noEmit`). No ESLint/Biome installed yet — the
  post-edit-lint hook self-disables until one is added.
- **Package manager**: **pnpm only** — npm/yarn/bun are blocked by the guard-bash hook.
- **Commits**: Conventional Commits, enforced by commitlint via the husky `commit-msg` hook.
- **Forge**: GitHub (`gh`). No Jira.

## Structure

`src/cli.ts` is the commander entry. Layers: `commands/`, `detect/`, `claude/`, `mcp/`, `utils/`.
Data: `mcp/catalog.json`; the deployed harness is `templates/claude/` (hooks and `bin/` are bash 3.2
compatible). See **CODEMAP.md** for the full map and where new files go. Words and the ideas behind the
harness: **docs/GLOSSARY.md** — use its terms; a new concept or principle goes there first. `trace` checks
each spec's `## Terms` against it (a term not there must be marked `(local)`); reviewers flag new words that
never reached Terms.

## Critical rules

- pnpm only; `git push` is manual-only.
- Never hand-edit generated files: `dist/**`, `*.d.ts`, `*.map`, `pnpm-lock.yaml`.
- Strict TS — no `any` / unchecked casts without justification.

## Subagent delegation

- **task-analyzer** at the start of a non-trivial task (intake + decomposition).
- **code-reviewer** after writing/modifying code (grep-first, severity-tagged).
- **test-writer** for vitest unit tests (reads neighbouring tests first).
- **pattern-scout** to (re)generate the path-scoped rules under `.claude/rules/` after structural
  changes.

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

## Explaining to the human

Explain as simply as possible — the human decides from your reply, so it must be readable when tired.
Replies in chat are in Russian; code, commits and repo docs stay in English.

- Lead with the answer in one or two plain sentences. Details come after, or go into a file.
- When proposing a change, show **now → proposed** side by side, with one concrete example.
- Few options: recommend one. End with one question the human can answer with yes/no or a choice.

Write every sentence for a reader whose English may not be native. These rules hold for replies, docs,
prompts and commit bodies:

- **Short.** About 20 words for a step, 25 for an explanation. One action per step. Put the condition
  first: "If X, do Y".
- **Name who acts:** "spec-gate blocks the edit", not "the edit is blocked".
- **One thing, one word.** Once you name a thing, use that word every time — the `docs/GLOSSARY.md` word.
  Explain a term the first time, or do not use it.
- **Plain verbs, no phrasal verbs or idioms:** "start", not "kick off"; "remove", not "get rid of".
- **Shorter must not change the facts:** keep numbers, names, the reason why, and what was not checked.
