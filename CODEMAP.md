# CODEMAP — agent-stack

Single-package ESM TypeScript CLI. Where things live:

| Path                     | What                                                                 |
| ------------------------ | -------------------------------------------------------------------- |
| `bin/cli.mjs`            | Executable shim — `import "../dist/index.js"`.                        |
| `src/index.ts`           | Entry point — `program.parse()`.                                     |
| `src/cli.ts`             | Commander command tree: `init`, `detect`, `mcp install/list`, `generate`, `update`, `sync`, `usage`, `run`. |
| `src/commands/`          | One file per command — orchestration; `next-steps.ts` — hints printed after a deploy. |
| `src/detect/`            | `project.ts` — project / environment; `harness-params.ts` — stack (node/python/go/rust), package manager, test/lint/complexity commands. |
| `src/claude/`            | `provider.ts` — Claude Code detection; `harness.ts` — deploy from templates; `update-plan.ts` — the update plan, manifest, seed files, the `routing` block; `hooks-block.ts` — `HOOKS_BLOCK`; `permissions.ts` — the deny and ask entries for the channels past the OS sandbox; `gates.ts` — `gates.json` defaults; `types.ts`. |
| `src/run/`               | Pipeline driver (`agent-stack run`): `types.ts`, `schemas.ts` (role outputs: checks and parsing), `role-schemas.ts` (their JSON schemas, re-exported by `schemas.ts`), `config.ts` (`gates.json` -> `run`), `store.ts` (run file, lock), `run-file.ts` (run file check), `git.ts`, `checks.ts`, `claude.ts` (one call), `process-group.ts` (kill a child's process group; the set of live child groups), `prompts.ts`, `gate.ts` (prompter), `errors.ts`. |
| `src/run/engine/`        | The step machine: `index.ts` (start/resume/status/cancel), `loop.ts`, `transitions.ts`, `context.ts`, `call.ts`, `gates.ts` (+ `limit-prompt.ts`), `steps-{common,implement,check,quick,spec,plan,task}.ts` (common = base-check + the registry), `task-core.ts` (helpers the task steps share), `frozen.ts` (frozen tests), `plan-file.ts`, `role-bounds.ts`, `signals.ts` (`abortOnSignals`: SIGINT/SIGTERM/SIGHUP, kill live child groups when the driver ends). |
| `src/usage/`             | `logs.ts` — find a project's session logs; `collect.ts` — count real harness events in them; `inventory.ts` — installed parts that never acted. |
| `src/mcp/`               | `catalog.ts`, `installer.ts`, `types.ts` — MCP server management.     |
| `src/utils/`             | `logger.ts`, `shell.ts` (`run`, `runSilent`, `commandExists`).       |
| `mcp/catalog.json`       | Data: installable MCP servers.                                       |
| `templates/claude/`      | The deployed harness: `hooks/` (gates + `gates-lib.sh`), `bin/` (`verify`, `trace`, `health`), `agents/`, `skills/`, `commands/`, `rules/` (empty), `_normative.md` (CLAUDE.md sections). |
| `evals/`, `scripts/eval.mjs` | Regression task set for the driver (not shipped): `evals/tasks/<id>/` (`task.json` + `fixture/`), the runner `scripts/eval.mjs` with its modules in `scripts/eval/`, results in `evals/results/`. Spec: `docs/specs/evals1/SPEC.md`. |
| `tests/`                 | vitest: `claude/`, `detect/` (unit), `hooks/` (shell hooks in temp repos, `fixture.ts`), `e2e/` (`generate` on fresh repos), `eval/` (the eval runner with the fake claude). |
| `dist/`                  | tsup build output — generated, never hand-edit.                      |
| `CHANGELOG.md`           | Release notes per version.                                           |

## Entry / wiring

`bin/cli.mjs` → `dist/index.js` → `src/index.ts` → `src/cli.ts` (commander) → `src/commands/*`.
`generate` / `update` → `src/claude/harness.ts` → copies `templates/claude/` + `gates.json` from `src/detect/harness-params.ts`.

## Where new files go

- New CLI command → `src/commands/<name>.ts`, registered in `src/cli.ts`.
- New hook → `templates/claude/hooks/<name>.sh`, registered in `HOOKS_BLOCK` (`src/claude/hooks-block.ts`); test in `tests/hooks/`.
- New stack-specific value → a `gates.json` key (`src/claude/gates.ts`), detected in `src/detect/harness-params.ts`.
- New MCP server → entry in `mcp/catalog.json`; logic in `src/mcp/`.
- New test → `tests/<layer>/<name>.test.ts` mirroring the source path.

## Harness (not committed)

`.claude/` (hooks, agents, rules, skills, commands), `CLAUDE.md`, `CODEMAP.md` are git-excluded via
`.git/info/exclude` — personal harness, not project history.
