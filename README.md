![CI](https://github.com/pasajero0/Agent-stack/actions/workflows/ci.yml/badge.svg)

# agent-stack

CLI that deploys a **Claude Code harness** onto any JS/TS repository and manages MCP servers. One command
drops in a battle-tested harness — a `.claude/` tree and a repo-root `CLAUDE.md` — with deterministic
guards, session/git context, a disciplined migration loop, and scoped subagents, specialized to your
project.

## Install

```bash
npx @pasajero_0/agent-stack init        # no install
# or
npm i -g @pasajero_0/agent-stack
```

Requires `git`, `jq`, and (for the verify hook) `python3` on PATH for the deployed hooks to run.

## What it deploys

The harness is a set of layers with different enforcement, not a single instruction file.
`agent-stack generate` (or `init`) writes them all — a `.claude/` tree together with a repo-root
`CLAUDE.md` / `CODEMAP.md` — specialized to the detected project (package manager, lockfile, build
outputs, default branch, forge):

```
CLAUDE.md                  # project guide — the soft, always-on layer (built by the emitter)
CODEMAP.md                 # where things live — generated stub, fill in
.claude/
├── settings.json          # hook registration + permission allow-list
├── settings.local.json    # read-deny for build/generated noise
├── hooks/                 # 6 deterministic shell hooks (run outside the model)
│   ├── guard-bash.sh        # block `git push` + foreign package managers
│   ├── guard-file.sh        # block edits to generated files / lockfile; confirm .env
│   ├── session-start-context.sh
│   ├── stop-flag-reflect.sh
│   ├── post-edit-lint.sh    # self-disables if no linter is installed
│   └── post-edit-verify.sh  # post-apply diff check during migrations
├── agents/                # task-analyzer, code-reviewer, test-writer, pattern-scout
├── commands/              # /reflect, /review
├── skills/                # migration, mr-description, + reference docs
└── rules/                 # EMPTY by design — generate per-repo (see below)
```

The layers differ in how strongly they bind. `CLAUDE.md` is always-on guidance the model can still
ignore; `rules/` are the same soft conventions but scoped to matching paths; `hooks/` are
deterministic scripts that run *outside* the model at tool-call time — a blocked `git push` returns
`exit 2` and cannot be skipped the way a `CLAUDE.md` line can. So `CLAUDE.md` is the first, softest
layer of the harness, not an add-on to it. The emitter deploys exactly what the tree above shows —
the `.claude/` tree and the root `CLAUDE.md` / `CODEMAP.md`. The manual guide,
[docs/HARNESS-SETUP.md](docs/HARNESS-SETUP.md), walks through the same harness **and** its
surroundings the emitter does not install (official plugins, linter, git hooks).

## Commands

| Command | Description |
|---------|-------------|
| `agent-stack init` | Wizard: detect environment → deploy harness → optionally install MCP servers |
| `agent-stack generate` | Deploy the harness into the current repo |
| `agent-stack sync` | `detect` + `generate` |
| `agent-stack detect` | Report project context + whether Claude Code is installed |
| `agent-stack mcp install` | Install MCP servers from the catalog |
| `agent-stack mcp list` | List configured MCP servers |

## After deploying

1. **Exclude the harness from git** (it is personal) — add to `.git/info/exclude`:
   ```
   .claude/
   CLAUDE.md
   CODEMAP.md
   ```
2. **Generate rules** — `.claude/rules/` ships empty on purpose: path-scoped rules must reflect *your*
   code, not another project's. Open `claude` in the repo and run the **pattern-scout** subagent; it
   drafts rules you review and keep.
3. **Smoke-test the guards** — a `git push` or a foreign package-manager command should be blocked;
   a normal command should pass.

## MCP server catalog

Defined in `mcp/catalog.json`, installed via `claude mcp add`:

| Server | Description |
|--------|-------------|
| GitHub | Issues, PRs, repos |
| Fetch | Web content as markdown |
| Memory | Persistent knowledge graph |
| Sequential Thinking | Structured reasoning |

## Architecture

```
agent-stack/
├── bin/cli.mjs            # executable shim → dist/index.js
├── src/
│   ├── cli.ts             # commander program
│   ├── commands/          # init, detect, generate, sync, mcp
│   ├── detect/            # project + harness-param detection
│   ├── claude/            # harness emitter (templates → .claude/)
│   ├── mcp/               # MCP catalog loader + installer
│   └── utils/             # shell helpers, logger
├── templates/claude/      # harness core (tokenized) — hooks/agents/skills (CLAUDE.md is built in code)
├── docs/HARNESS-SETUP.md  # manual deploy guide — the harness + setup the emitter doesn't install
├── mcp/catalog.json       # MCP server catalog
└── tests/                 # vitest unit tests
```

`templates/claude/` holds the harness with `{{TOKEN}}` placeholders; the emitter in `src/claude/`
substitutes values from the detector and writes the tree. `CLAUDE.md` / `CODEMAP.md` aren't in
`templates/` — the emitter builds them in code (`buildClaudeMd` from the detected params plus the
`_normative.md` generator input, `buildCodemap`) and writes them to the **repo root**, git-excluded —
see [After deploying](#after-deploying). This tool targets **Claude Code only**.

## Development

```bash
pnpm install      # pnpm only — npm/yarn/bun are not supported
pnpm build
pnpm test
pnpm typecheck    # the static gate (no linter yet)
```

## Conventions

[Conventional Commits](https://www.conventionalcommits.org/) enforced by commitlint + husky
(`commit-msg`). Default branch `main`; `git push` is manual. GitHub PRs (`gh`).

## License

MIT
