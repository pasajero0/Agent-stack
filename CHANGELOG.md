# Changelog

## Unreleased (0.4)

### Upgrading from 0.3

- **After `update`, code on a stage branch waits for `/plan`.** spec-gate now also needs
  `.claude/tmp/<stage>/tasks.json`. A stage you were already coding without a plan stops at the next edit
  with "Run /plan first". Run `/plan`, or set `specGate: "off"` in `gates.json` to opt out.
- **A spec with `## Terms` may now fail `trace`** when the repo has `docs/GLOSSARY.md`: each Terms entry must be
  a glossary headword or be marked `- **Word** (local): …`. Mark the spec's own words `(local)`, move the shared
  ones to the glossary, or set `"glossary": ""` in `gates.json` to opt out.
- **Copy the new "Explaining to the human" section by hand.** `CLAUDE.md` is a seed file, so `update` keeps
  your copy. Take the section from `templates/claude/_normative.md`.

### Gates

- **spec-gate: no code without a plan.** After the spec checks pass, code edits wait for the stage's
  `tasks.json`. In the first trial `/plan` was never called, so `verify` and `evidence-gate` had nothing to
  check. Docs, `.claude/` and other `openPaths` stay open, so `/plan` can write the file.
- **evidence-gate: no "done" without evidence, task list or not.** `STATUS: DONE` without an `EVIDENCE`
  section is blocked outside a stage too (still once per stop, and only with `evidenceGate: true`).
- **session-start names the next step** on a stage branch with no task list: `/spec` if the spec is not
  merged yet, `/plan` if it is.

### Docs

- [ADR 0001](docs/adr/0001-pipeline-driver.md): a driver program, `agent-stack run`, holds the pipeline
  order.
- **Five sentence rules in the generated `CLAUDE.md`.** "Explaining to the human" now asks for about 20 words
  a step and 25 an explanation, the condition first, who acts, one word for one thing, plain verbs, and
  short text that keeps the facts. The rules hold for replies, docs, prompts and commit bodies. The old
  "everyday words" pushed the model to swap a glossary term for a synonym. The rules come from ASD-STE100
  (Issue 9) and Google's "Writing for a global audience", without the STE dictionary. In one test a strict
  "write in ASD-STE100" prompt lost 46.8% of the facts about code, so the harness does not use one.

### Driver (experimental)

- **`agent-stack run`**: `quick "<fix>"` and `task "<what to build>"` modes; `--resume`, `--status`,
  `--cancel`. Exit codes 0 / 3 (waiting) / 1. Tested with a fake `claude`, plus five manual runs with the
  real one (three task, one of them with two tasks; two quick).
- **Gates:** answers, spec merge, plan approval, accept and limit, from the terminal. The driver makes the
  branches and commits (headers pass commitlint), runs the checks, and never pushes or merges.
- **Fuse:** `gates.json` -> `run`, three kinds: calls (default 40), dollars, or off.
- **Resume:** a waiting or interrupted run continues from its run file; one run per repo.
- **Hooks:** spec-gate's quick-mode bypass and evidence-gate's silence apply only to a live driver run on the
  run's branch; guard-file protects the run folder; path checks follow symlinks.
- **/plan skill:** every task ends green; the test is written first inside the task, no test-only tasks.
- **`trace` checks spec terms against the glossary.** Each `- **Term**` in a spec's `## Terms` must be a
  headword of the glossary (`gates.json → glossary`, default `docs/GLOSSARY.md` when it exists; `""` turns it
  off) or be marked `(local)`. `trace --terms` checks only that, so `/spec` runs it before the review and the
  driver after its spec role. spec-reviewer and code-reviewer flag a new word that never reached Terms. A rule
  kept only as text in CLAUDE.md was skipped three times in one session.
- **/spec skill:** the EARS pattern table moved from `template.md` into the skill, so a spec written from the
  template no longer carries it.
- **From the first run with the real `claude`:**
  - the plan role returns its tasks and the driver writes `tasks.json`: Claude Code guards `.claude/`, so a
    headless role could not;
  - a spec or plan role that asks a question stops at gate `limit` (reason `decision`) instead of being re-run;
  - a permission denial is shown as one short line;
  - each call loads only the project: its `.mcp.json`, project settings, no user CLAUDE.md, no claude.ai
    connectors, no auto-memory. About 165k → 15k tokens a turn;
  - a line before and after every call, so a long call does not look hung.
- **From the second run:**
  - without a remote, the spec-merge gate prints `git checkout <base> && git merge spec/<stage>`;
  - a stage or type prefix the model repeats in a commit subject is dropped (no more `feat(a2): a2: …`);
  - the spec role is told the driver commits, so it does not ask;
  - each answers prompt says that Enter takes the recommended answer;
  - a decision retry gives the role its questions with your answer;
  - the implement role is told which shell commands it may run;
  - clarify gets the stage-id rule and the ids in use, and a stage id that cannot be used is never the
    default: the gate offers the proposal or a free id, so Enter no longer loops;
  - a change to documentation only needs no test (a quick fix of one README line had got one);
  - the start check: before a task's first attempt the driver runs `.claude/bin/verify --dry <task>` once,
    and a verify that is already green gets a note at gate:accept, because it cannot show the task's work.
    `--dry` guards and runs like verify but records nothing;
  - a verify killed on timeout leaves no stale lock: the driver drops it, or the next verify waited 60 s;
  - `/plan` puts `test -f <file> &&` in front of each named test file, so a missing file is red, not skipped.
- **From a check against Compound V:**
  - a check that times out is the environment's fault: the driver exits 1, names the command and the limit,
    and counts no attempt. Before, a hung package manager sent the task back to implement on Opus;
  - in task mode with more than one task, gate:accept first runs every task's verify again. A later task that
    broke an earlier one shows up red;
  - a killed call, or one with no cost in its result, counts as unknown cost, not $0. A dollar fuse says it
    may count too little;
  - spec-reviewer recomputes every example from the contract, literally. It had passed a spec whose
    `greet()` example was wrong in JS.

## 0.3.0 — from the first trial

Fixes and changes from the first real trial (lex-poc, 10 sessions), and a way to see what the harness does.

### Upgrading from 0.2

- Copy any harness file you edited by hand (hooks, skill templates) before the first `update`: a 0.2 harness
  has no file hashes yet, so that one `update` still overwrites them. It says so. From then on your edits
  are kept.
- `gates.json` is yours, so two new values reach an existing repo only by hand: the fixed `installPatterns`
  entry for `pnpm|npm|yarn|bun` (see `src/claude/gates.ts`), and `docsLayout` if you want it.
- Delete `.claude/hooks/post-edit-verify.sh`: `update` unregisters it but cannot tell that the file is
  untouched.

### `update`

- **Keeps what you changed.** The manifest (`.claude/.harness.json`) records a sha256 of every harness file it
  deploys. A file you changed since is kept and listed (`update --force` overwrites it); a file a newer
  version no longer ships is deleted, or left in place if you changed it.
- **Keeps your `settings.json` edits.** Every hook the harness does not ship is carried over whole (all its
  fields, any hook type) under the same event and matcher; so are your permission entries and keys the
  harness does not write (`env`, `plugins`, …). Hooks and permissions an earlier version generated and
  this one does not are dropped with a note. A `settings.json` that is not valid JSON is left as is.

### Seeing what the harness does

- **`agent-stack usage`** reads the project's Claude Code session logs and reports what the harness actually
  did: hook blocks and added context, Stop-hook runs, subagent and skill calls, slash commands,
  `.claude/bin` runs, tokens by agent and model, and the installed parts that never acted. Read-only;
  `--days`, `--logs`, `--json`. `--save` writes the summary (counts only, no conversation text) to
  `.claude/tmp/usage/<date>.json`, so it outlives the logs. Guide: `docs/usage-analytics.md`.
- **Experimental parts are marked** in the README: the parts the trial never used (the `tasks.json` chain,
  `task-analyzer`, `pattern-scout`, `spec-reviewer`, several skills and commands, `cheat-guard`,
  `arch-guard`, `post-edit-lint`, `health`). Nothing is removed yet; `usage --save` summaries decide.

### Specs, ADRs and docs

- `/spec` takes the stage id as the first word and the rest as a description, so a description no longer
  ends up in the path. It says how to hand over a spec with no remote: a local merge is the approval.
- **Light spec** for setup work (`light-template.md`): Purpose, a checklist proven by commands, Out of
  scope. With `light: true` in its frontmatter, `spec-reviewer` passes it and `trace` does not ask for tests.
- The spec template has `Purpose` and a `Decisions` table instead of `Goal` and `Context`; a criterion cites
  its ADR (`ADR-0003`); a stage with several parts groups criteria by part, ids running on.
- The ADR template has `Decided` (may be `unknown`) and `Recorded` instead of one date, `Applies to` instead
  of `Stage / spec`, and `Supersedes`. The skill no longer pushes the agent to invent a second alternative,
  and text the human did not give is marked "(agent's inference)".
- `spec-reviewer` checks the new sections, the spec ↔ ADR links, and that what the spec says about the code
  is true. `code-reviewer` checks the author's explanation instead of trusting it, backs each issue with
  evidence and a consequence, and may report "No issues." `pattern-scout` reads `docs/architecture/`.
- **Default doc layout for a monorepo.** `gates.json` gets `docsLayout`, where Markdown files belong: for a
  monorepo `docs/`, a README in each app or package, package CHANGELOGs, `.claude/`, `.github/`; empty
  otherwise. `health` lists a changed `.md` outside it as `misplacedDocs`. It only reports; a project with
  another layout changes the list and records it in an ADR.
- The `CODEMAP.md` stub has Code, Specs and Docs tables instead of a fixed `src/` and `tests/`, and says to
  keep it in git.
- `stagePattern` is explained in the README with branch → spec path examples, including a feature-name
  pattern. The default stays `A0`.

### Security

From a security review of the harness; the rest of its findings are listed under Limits in the README.

- **Reading secrets asks first.** A Read or Grep of an env file (`.env`, `.env.local`, … — not `.env.example`),
  a private key (`*.pem`, `*.key`, `id_rsa`, …) or `.aws/credentials`, and a shell command that reads one
  (`cat .env`, `grep KEY .env`, `source .env`), ask for confirmation; in autonomous mode they are blocked.
  guard-file is now also registered for `Read|Grep` — `update` adds it.
- **Download-and-run counts as an install:** `npx`, `pnpm dlx`, `yarn dlx`, `bunx`, `npm exec`, `uvx`,
  `uv tool run`, `pipx run`, `go run …@version`, `deno run <url>` and `curl … | sh` ask first (blocked in
  autonomous mode). `npx tsc` and the like pass when the binary is already in `node_modules/.bin`, and
  `curl … | python3 -m json.tool` is data, not code. The list lives in guard-bash, not in `gates.json`, so it
  reaches existing repos.
- **The harness protects itself whatever the path looks like:** `.claude/./hooks/…`, `.claude//hooks/…`,
  `.claude/new/../hooks/…` and `.Claude/Hooks/…` (the same file on a case-insensitive disk) are blocked; so
  is writing a stage's `TASKS.JSON` in another letter case.
- **The `fetch` MCP server is the official one** (`uvx mcp-server-fetch`, needs uv; no longer selected by
  default). The old entry ran an npm package of that name, which the MCP project does not publish.

### Fixes

- **A repository with no commits** no longer blocks the scaffold: `spec-gate` stays open until the first
  commit on any branch, and session start says so. An orphan branch in a repo with history stays closed.
  The session context names the unborn branch instead of `HEAD`/`unknown`.
- **Session start warns about a hook that never runs** (a file in `.claude/hooks/` not registered in
  `settings*.json`, or not executable) and, once, when `jq` is missing (every guard then blocks every call).
- Hook commands quote the project dir (`"$CLAUDE_PROJECT_DIR"/.claude/hooks/…`), so a path with a space works.
- The install guard no longer reads a shell operator as a package: `pnpm install && pnpm test` is not an
  install.

### Removed

- The `post-edit-verify` hook. While any `*-plan.md` sat in `.claude/tmp/`, it pasted the file's diff into the
  context after every edit, including plans long finished (~40k tokens over 63 edits in one repo). The
  `/migration` skill still asks for the same check by hand.

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
