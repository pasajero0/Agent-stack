import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export interface AgentDefault {
  title: string;
  role: string;
  systemPrompt: string;
  rules: string[];
}

function findAgentsDir(): string {
  const thisDir = dirname(fileURLToPath(import.meta.url));
  // Bundled (dist/index.js) → ../agents/
  // Dev (src/agents/defaults.ts) → ../../agents/
  const candidates = [
    join(thisDir, "..", "agents"),
    join(thisDir, "..", "..", "agents"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("Could not find agents/ directory");
}

function parseAgentMd(content: string): { systemPrompt: string; rules: string[] } {
  const lines = content.split("\n");
  let systemPrompt = "";
  const rules: string[] = [];

  // Extract description (everything between # Title and ## Rules)
  let inDescription = false;
  let inRules = false;

  for (const line of lines) {
    if (line.startsWith("# ") && !line.startsWith("## ")) {
      inDescription = true;
      continue;
    }
    if (line.startsWith("## Rules")) {
      inDescription = false;
      inRules = true;
      continue;
    }
    if (line.startsWith("## ") && inRules) {
      inRules = false;
      continue;
    }

    if (inDescription) {
      systemPrompt += line + "\n";
    }
    if (inRules && line.trim().startsWith("- ")) {
      rules.push(line.replace(/^\s*-\s*/, "").trim());
    }
  }

  return { systemPrompt: systemPrompt.trim(), rules };
}

export function loadAgentDefaults(): Record<string, AgentDefault> {
  const agentsDir = findAgentsDir();
  const defaults: Record<string, AgentDefault> = {};

  const entries = readdirSync(agentsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;

    const agentMdPath = join(agentsDir, entry.name, "AGENT.md");
    if (!existsSync(agentMdPath)) continue;

    const content = readFileSync(agentMdPath, "utf-8");

    // Extract title from first H1
    const titleMatch = content.match(/^# (.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : entry.name;

    const { systemPrompt, rules } = parseAgentMd(content);

    defaults[entry.name] = {
      title,
      role: entry.name,
      systemPrompt,
      rules,
    };
  }

  return defaults;
}
