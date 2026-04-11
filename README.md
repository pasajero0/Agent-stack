# Agent-stack

CLI configurator for AI coding environments. Detect providers, manage MCP servers, generate agent configs from a single source of truth.

## Problem

There is no unified CLI tool that detects installed AI coding providers, configures them from a single source, and manages MCP servers cross-provider. Each tool (Claude Code, Kiro, Cursor, etc.) has its own config format, its own MCP setup, and its own agent definitions. Agent-stack fills this gap.

## How it works

```
npx agent-stack init
```

The wizard will:
1. **Detect** installed AI coding providers (Claude Code, Kiro)
2. **Install** a missing provider if needed
3. **Configure MCP servers** (GitHub, Fetch, Memory, Sequential Thinking)
4. **Create AGENTS.md** — a universal agent definition file
5. **Generate** provider-specific configs from AGENTS.md

## CLI Commands

| Command | Description |
|---------|-------------|
| `agent-stack init` | Full setup wizard |
| `agent-stack detect` | Detect installed providers |
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

## Supported Providers

| Provider | Status | Detection |
|----------|--------|-----------|
| Claude Code | v1 | `claude --version` |
| Kiro | v1 | `kiro` binary / Kiro.app |
| Cursor | planned | — |
| Windsurf | planned | — |

## MCP Server Catalog

| Server | Package | Description |
|--------|---------|-------------|
| GitHub | `@modelcontextprotocol/server-github` | Issues, PRs, repos |
| Fetch | `mcp-server-fetch` | Web content as markdown |
| Memory | `@modelcontextprotocol/server-memory` | Persistent knowledge graph |
| Sequential Thinking | `@modelcontextprotocol/server-sequential-thinking` | Structured reasoning |

## Architecture

```
src/
  cli.ts                  # Commander program
  commands/               # init, detect, mcp, generate, sync
  providers/              # Adapter per provider (claude-code, kiro)
  mcp/                    # MCP server catalog + installer
  agents/                 # AGENTS.md parser + config generator
  utils/                  # Shell helpers, logger
templates/
  AGENTS.md               # Default template
```

Adding a new provider = implement `ProviderAdapter` interface + register in registry.

## Development

```bash
pnpm install
pnpm run build
pnpm run test
pnpm run typecheck
```

## License

MIT
