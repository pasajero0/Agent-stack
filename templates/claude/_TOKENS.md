<!--
Token vocabulary for the harness generator. Files under templates/claude/ contain {{TOKEN}}
placeholders; the emitter (src/claude/) substitutes them from the detector's output. This file is
generator input (leading underscore = not copied into the target repo).
-->

# Harness template tokens

Only prose templates (agents, commands, skills) use tokens. Hooks never do: everything
stack-specific they need is read at runtime from `.claude/gates.json`, so the hooks are identical
for every language.

| Token | Meaning | Example value | Source (detector) |
| --- | --- | --- | --- |
| `{{DOCS_DIR}}` | docs directory (trailing slash) | `docs/` | convention |
| `{{MAIN_BRANCH}}` | default branch | `main` | git (`origin/HEAD`, else current branch) |
| `{{VERIFY_CMD}}` | the project's verification commands, `&&`-joined | `pnpm typecheck && pnpm test` | stack manifest |

## Not templated (emitter builds these directly)

- `settings.json` — verbatim hooks block + computed `permissions.allow` (commands + forge CLI).
- `settings.local.json` — your local permissions; no `Read(...)` deny rules (guard-file does that). Seed file.
- `gates.json` — every stack-specific value the hooks read (`src/claude/gates.ts`). Seed file.
- `CLAUDE.md` — project body (from detector) + `_normative.md` appended verbatim. Seed file.
- `CODEMAP.md` — a fixed stub to fill in by hand (it is not generated from the repo tree yet). Seed file.

Seed files are written once by `generate` and never overwritten by `update`.
