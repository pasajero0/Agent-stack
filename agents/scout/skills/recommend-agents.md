# Recommend Agents

Given a project profile from scan-project, recommend the optimal agent team.

## Steps

1. Review the project profile
2. Select relevant agents from the available roster:
   - **Architect** — for projects with complex structure or design decisions ahead
   - **Coder** — always recommended, core implementation agent
   - **Reviewer** — for projects with security concerns, payment handling, or team collaboration
   - **Test Writer** — for projects with existing tests or testing requirements
   - **Researcher** — for projects using unfamiliar APIs or requiring documentation research
3. Customize agent rules based on detected conventions
4. Suggest MCP servers based on project needs:
   - GitHub MCP if .git remote points to GitHub
   - Postgres MCP if database dependencies detected
   - Fetch MCP for projects with external API integrations

## Output

Markdown document with:
- Recommended agents and why
- Customized rules per agent (based on project conventions)
- Recommended MCP servers
- Ready-to-use AGENTS.md content
