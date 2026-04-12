import matter from "gray-matter";
import { readFile } from "node:fs/promises";
import type { AgentsConfig, AgentDefinition, HookDefinition } from "./types.js";

export async function parseAgentsFile(filePath: string): Promise<AgentsConfig> {
  const raw = await readFile(filePath, "utf-8");
  return parseAgentsContent(raw);
}

export function parseAgentsContent(raw: string): AgentsConfig {
  const { data: frontmatter, content } = matter(raw);

  const config: AgentsConfig = {
    version: (frontmatter["version"] as number) ?? 1,
    project: frontmatter["project"] as string | undefined,
    defaults: frontmatter["defaults"] as AgentsConfig["defaults"],
    agents: [],
  };

  // Split content by H2 headings
  const agentBlocks = content.split(/^## /m).filter(Boolean);

  for (const block of agentBlocks) {
    const lines = block.split("\n");
    const name = (lines[0] ?? "").trim();
    if (!name) continue;

    const body = lines.slice(1).join("\n");
    const agent = parseAgentBlock(name, body);
    config.agents.push(agent);
  }

  return config;
}

function parseAgentBlock(name: string, body: string): AgentDefinition {
  const agent: AgentDefinition = { name };

  // Parse HTML comment metadata
  const roleMatch = body.match(/<!--\s*role:\s*(.+?)\s*-->/);
  if (roleMatch) agent.role = roleMatch[1];

  const providersMatch = body.match(/<!--\s*providers:\s*(.+?)\s*-->/);
  if (providersMatch) {
    agent.providers = providersMatch[1].split(",").map((s) => s.trim());
  }

  // Parse H3 subsections
  const sections = splitH3Sections(body);

  if (sections["System Prompt"]) {
    agent.systemPrompt = sections["System Prompt"].trim();
  }

  if (sections["Rules"]) {
    agent.rules = parseListItems(sections["Rules"]);
  }

  if (sections["Hooks"]) {
    agent.hooks = parseHooks(sections["Hooks"]);
  }

  if (sections["Sub-agents"]) {
    agent.subAgents = parseListItems(sections["Sub-agents"]);
  }

  return agent;
}

function splitH3Sections(body: string): Record<string, string> {
  const sections: Record<string, string> = {};
  const parts = body.split(/^### /m);

  for (const part of parts.slice(1)) {
    const lines = part.split("\n");
    const heading = (lines[0] ?? "").trim();
    const content = lines.slice(1).join("\n");
    sections[heading] = content;
  }

  return sections;
}

function parseListItems(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.replace(/^\s*-\s*/, "").trim())
    .filter(Boolean);
}

function parseHooks(text: string): HookDefinition[] {
  const hooks: HookDefinition[] = [];
  const lines = text.split("\n").filter(Boolean);

  for (const line of lines) {
    const match = line.match(/^\s*-\s*(.+?):\s*(.+)$/);
    if (match) {
      hooks.push({ event: match[1].trim(), command: match[2].trim() });
    }
  }

  return hooks;
}
