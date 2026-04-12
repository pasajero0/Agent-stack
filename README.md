# Agent-stack

CLI configurator for AI coding environments. Detect providers, manage MCP servers, generate agent configs from a single source of truth.

## Problem

There is no unified CLI tool that detects installed AI coding providers, configures them from a single source, and manages MCP servers cross-provider. Each tool (Claude Code, Kiro, Cursor, etc.) has its own config format, its own MCP setup, and its own agent definitions. Agent-stack fills this gap.

## How it works

```
npx agent-stack init
```

The wizard auto-detects the scenario and adapts:

```
Existing project (has package.json/src/.git):
  → fewer questions, project name from package.json
  → agents pre-selected based on context

Empty directory:
  → asks project name, language, full configuration
```

Four steps:
1. **detect()** — existing project or empty? which providers installed?
2. **wizard()** — questions adapted to scenario, agent selection, MCP servers
3. **generateAGENTS()** — filled AGENTS.md from agent defaults + answers
4. **deployAdapters()** — provider configs (.claude/, .kiro/) + MCP servers

## CLI Commands

| Command | Description |
|---------|-------------|
| `agent-stack init` | Full setup wizard (4-step flow) |
| `agent-stack detect` | Detect project context + installed providers |
| `agent-stack mcp install` | Install MCP servers |
| `agent-stack mcp list` | List configured MCP servers |
| `agent-stack generate` | Generate provider configs from AGENTS.md |
| `agent-stack sync` | Detect + generate (shortcut) |

## AGENTS.md — Single Source of Truth

One file defines all agent roles. The wizard generates provider-specific configs from it:

- **Claude Code** — `CLAUDE.md`, `.claude/settings.json`
- **Kiro** — `.kiro/rules/*.md`

```markdown
---
version: 1
defaults:
  model: claude-sonnet-4-20250514
---

## Architect
<!-- role: architect -->
<!-- providers: claude-code, kiro -->

### System Prompt
You are a software architect...

### Rules
- Always read existing code before proposing changes
- Produce a plan before editing files
```

## Agents

Six built-in agents, each defined as `agents/<name>/AGENT.md`:

| Agent | Role | Description |
|-------|------|-------------|
| **Scout** | Advisory (v0.2) | Scans existing projects, recommends agent configuration |
| **Architect** | Planning | Explores codebases, designs implementation plans |
| **Coder** | Implementation | Implements features, fixes bugs, follows conventions |
| **Reviewer** | Quality | Reviews code for correctness, security, performance |
| **Test Writer** | Testing | Writes tests that verify behavior and catch regressions |
| **Researcher** | Research | Investigates APIs, libraries, documentation |

Agent defaults are loaded from `agents/*/AGENT.md` at runtime — single source of truth.

## Supported Providers

| Provider | Status | Detection |
|----------|--------|-----------|
| Claude Code | v0.1 | `claude --version` |
| Kiro | v0.1 | `kiro` binary / Kiro.app |
| Cursor | planned | — |
| Windsurf | planned | — |

## MCP Server Catalog

Defined in `mcp/catalog.json`:

| Server | Package | Description |
|--------|---------|-------------|
| GitHub | `@modelcontextprotocol/server-github` | Issues, PRs, repos |
| Fetch | `mcp-server-fetch` | Web content as markdown |
| Memory | `@modelcontextprotocol/server-memory` | Persistent knowledge graph |
| Sequential Thinking | `@modelcontextprotocol/server-sequential-thinking` | Structured reasoning |

## Architecture

```
agent-stack/
├── agents/                  # Agent definitions (AGENT.md + skills/)
│   ├── scout/               # Advisory agent (v0.2)
│   ├── architect/
│   ├── coder/
│   ├── reviewer/
│   ├── test-writer/
│   └── researcher/
├── bin/cli.mjs              # Entry point
├── mcp/catalog.json         # MCP server catalog (JSON)
├── src/
│   ├── cli.ts               # Commander program
│   ├── detect/              # Project detection (existing/empty)
│   ├── commands/            # init, detect, mcp, generate, sync
│   ├── providers/           # Adapter per provider (claude-code, kiro)
│   ├── mcp/                 # MCP catalog loader + installer
│   ├── agents/              # AGENTS.md parser, defaults loader, generator
│   └── utils/               # Shell helpers, logger
├── templates/AGENTS.md      # Default template (5 agents)
└── tests/                   # 22 tests
```

Adding a new provider = implement `ProviderAdapter` interface + register in registry.

## Development

```bash
pnpm install        # also installs husky hooks via prepare script
pnpm run build
pnpm run test
pnpm run typecheck
```

## Git Conventions

### Versioning

[Semver](https://semver.org/) — version reflects the nature of changes:

```
v0.1.0
  │ │ │
  │ │ └── patch: bug fixes, minor corrections
  │ └──── minor: new functionality, backwards compatible
  └────── major: breaking changes
```

Commit types map to version bumps:
- `feat` → minor (0.1.0 → 0.2.0)
- `fix` → patch (0.1.0 → 0.1.1)
- `docs`, `refactor`, `test`, `chore`, `ci`, `style`, `perf`, `build` → patch or no bump

### Branches

Branches and commits use the same type prefixes.

Allowed types: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `ci`, `style`, `perf`, `build`, `revert`.

```
<type>/<short-description>

feat/scout-agent
fix/mcp-env-placeholder
refactor/init-flow
docs/update-readme
chore/commitlint-setup
```

### Commits

[Conventional Commits](https://www.conventionalcommits.org/) enforced by commitlint + husky.

```
<type>: <description>

feat: add project detection for existing/empty directories
fix: handle empty env vars with placeholder
docs: update README with v0.1 architecture
refactor: split init into 4-step flow
test: add project detection tests
chore: move MCP catalog to JSON
```

Commits that don't follow this format will be rejected by the commit-msg hook.

## License

MIT
