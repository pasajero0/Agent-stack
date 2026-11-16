# Changelog

## Unreleased

Fixes from the first real trial (lex-poc):

- **`update` keeps your own hooks.** It regenerated `settings.json` and silently dropped hook entries you had
  added; now every hook the harness does not ship is carried over whole (all its fields, any hook type) under
  the same event and matcher, and `update` lists them. Hooks an earlier version shipped and this one removed
  are dropped with a note. A `settings.json` that is not valid JSON is left as is, with a warning. Other hand
  edits to `settings.json` (permissions, env, plugins) are still regenerated.
- **A repository with no commits** no longer blocks the scaffold: `spec-gate` stays open until the first
  commit on any branch, and session start says so. An orphan branch in a repo with history stays closed. The session context names the unborn branch instead of `HEAD`/`unknown`.
- **Session start warns about a hook that never runs** — a file in `.claude/hooks/` that is not registered in
  `settings*.json`, or registered but not executable — and, once, when `jq` is missing (every guard then
  blocks every call).
- **Hook commands quote the project dir** (`"$CLAUDE_PROJECT_DIR"/.claude/hooks/…`), so a path with a space works.
- **The install guard no longer reads a shell operator as a package**: `pnpm install && pnpm test` is not an
  install. `gates.json` is yours after `generate`, so an existing repo gets this only by updating
  `installPatterns` there by hand.
- **`agent-stack usage`** — reads the project's Claude Code session logs and reports what the harness actually
  did: hook blocks and added context, Stop-hook runs, subagent and skill calls, slash commands, `.claude/bin`
  runs, tokens by agent and model, and the installed parts that never acted. Read-only; `--days`, `--logs`,
  `--json`. `--save` writes the summary (counts only, no conversation text) to
  `.claude/tmp/usage/<date>.json`, so it outlives the logs. Guide: `docs/usage-analytics.md`.
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
