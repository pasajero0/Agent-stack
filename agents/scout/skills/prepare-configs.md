# Prepare Configs

Given an AGENTS.md and detected providers, prepare provider-specific configuration
files for review.

## Steps

1. Read AGENTS.md content
2. For each detected provider (Claude Code, Kiro):
   - Map agent definitions to provider-specific format
   - Generate configuration file contents
3. Present the generated files for human review
4. Wait for approval before suggesting to apply

## Output

Markdown document with:
- Generated file paths and their contents
- Explanation of what each file configures
- Instructions: "copy these files or run `agent-stack generate` to apply"
