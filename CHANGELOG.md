# Changelog

## Unreleased

- Removed the `post-edit-verify` hook. While any `*-plan.md` sat in `.claude/tmp/`, it pasted the file's
  diff into the context after every edit, including plans that were long finished. The `/migration`
  skill still asks for the same check by hand. After `update`, an existing
  `.claude/hooks/post-edit-verify.sh` stays on disk but is no longer registered; delete it if you like.

## 0.2.0 — gates

The harness becomes an enforcement layer for a spec-driven workflow, on any stack.

- **Stack-agnostic config** — `.claude/gates.json` holds every language-specific value; detected for node,
  python, go and rust.
- **Modes** — `interactive` (confirm each diff) and `autonomous` (installs denied, no push, commit per phase).
- **Gates** — `spec-gate` (spec merged first, later changes committed before the code), `cheat-guard`,
  `arch-guard` (layer boundaries), `evidence-gate` (no "done" without passing tasks and evidence).
- **Guards** — `git push` in any form and PR merges blocked; the harness protects its own hooks, scripts and
  config; `tasks.json` written only by `.claude/bin/verify`.
- **Drift** — `.claude/bin/trace` (spec criteria ↔ tests), `.claude/bin/health` (code-health SLIs/SLOs on the
  branch's changes, time series in `.claude/tmp/health.jsonl`).
- **Workflow skills** — `grill`, `adr`, `spec`, `plan`; `spec-reviewer` and `researcher` subagents; every
  subagent has a model and effort level.
- **`update`** keeps seed files (`CLAUDE.md`, `CODEMAP.md`, `gates.json`, `settings.local.json`); `init` skips
  an existing harness.
- Removed `docs/HARNESS-SETUP.md` — the manual copy of the harness; `agent-stack generate` deploys it.

## 0.1.0 — first release

Claude Code only. `generate` / `update` / `sync` deploy the harness from `templates/claude/` with a version
manifest; `init` wizard; `detect`; MCP servers from a catalog.
