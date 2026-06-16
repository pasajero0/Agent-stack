# agent-stack

CLI that deploys a **Claude Code harness** onto any repository and manages MCP servers. One command
drops in a battle-tested `.claude/` setup — deterministic guards, session/git context, a disciplined
migration loop, and scoped subagents — specialized to your project.

## Install

```bash
npx agent-stack init        # no install
# or
npm i -g agent-stack
```

Requires `git`, `jq`, and (for the verify hook) `python3` on PATH for the deployed hooks to run.

## What it deploys

`agent-stack generate` (or `init`) writes a `.claude/` tree plus `CLAUDE.md` / `CODEMAP.md`,
specialized to the detected project (package manager, lockfile, build outputs, default branch, forge):

```
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

The hooks are the core value: they enforce hard prohibitions at tool-call time and inject context,
deterministically, regardless of the model.

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
├── templates/claude/      # harness core (tokenized) — the source of truth
├── mcp/catalog.json       # MCP server catalog
└── tests/                 # vitest unit tests
```

`templates/claude/` holds the harness with `{{TOKEN}}` placeholders; the emitter in `src/claude/`
substitutes values from the detector and writes the tree. This tool targets **Claude Code only**.

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
