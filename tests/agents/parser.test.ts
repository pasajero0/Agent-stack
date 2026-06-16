import { describe, it, expect } from "vitest";
import { parseAgentsContent } from "../../src/agents/parser.js";

const SAMPLE_AGENTS_MD = `---
version: 1
project: test-project
defaults:
  model: claude-sonnet-4-20250514
  temperature: 0
---

## Architect

<!-- role: architect -->
<!-- providers: claude-code -->

### System Prompt

You are a software architect.

### Rules

- Always read existing code
- Produce a plan before editing

### Hooks

- before:commit: npm run lint

---

## Reviewer

<!-- role: reviewer -->
<!-- providers: claude-code -->

### System Prompt

You review pull requests for correctness.

### Rules

- Check for hardcoded secrets
`;

describe("parseAgentsContent", () => {
  it("parses frontmatter correctly", () => {
    const config = parseAgentsContent(SAMPLE_AGENTS_MD);
    expect(config.version).toBe(1);
    expect(config.project).toBe("test-project");
    expect(config.defaults?.model).toBe("claude-sonnet-4-20250514");
    expect(config.defaults?.temperature).toBe(0);
  });

  it("parses all agents", () => {
    const config = parseAgentsContent(SAMPLE_AGENTS_MD);
    expect(config.agents).toHaveLength(2);
    expect(config.agents[0].name).toBe("Architect");
    expect(config.agents[1].name).toBe("Reviewer");
  });

  it("parses agent metadata from HTML comments", () => {
    const config = parseAgentsContent(SAMPLE_AGENTS_MD);
    const architect = config.agents[0];
    expect(architect.role).toBe("architect");
    expect(architect.providers).toEqual(["claude-code"]);

    const reviewer = config.agents[1];
    expect(reviewer.role).toBe("reviewer");
    expect(reviewer.providers).toEqual(["claude-code"]);
  });

  it("parses system prompts", () => {
    const config = parseAgentsContent(SAMPLE_AGENTS_MD);
    expect(config.agents[0].systemPrompt).toContain("software architect");
    expect(config.agents[1].systemPrompt).toContain("review pull requests");
  });

  it("parses rules as list items", () => {
    const config = parseAgentsContent(SAMPLE_AGENTS_MD);
    expect(config.agents[0].rules).toEqual([
      "Always read existing code",
      "Produce a plan before editing",
    ]);
    expect(config.agents[1].rules).toEqual(["Check for hardcoded secrets"]);
  });

  it("parses hooks", () => {
    const config = parseAgentsContent(SAMPLE_AGENTS_MD);
    expect(config.agents[0].hooks).toEqual([
      { event: "before", command: "commit: npm run lint" },
    ]);
  });

  it("handles agents with no providers (applies to all)", () => {
    const md = `---
version: 1
---

## General Agent

### System Prompt

A general agent.
`;
    const config = parseAgentsContent(md);
    expect(config.agents[0].providers).toBeUndefined();
  });

  it("handles empty content", () => {
    const config = parseAgentsContent("---\nversion: 1\n---\n");
    expect(config.agents).toHaveLength(0);
  });
});
