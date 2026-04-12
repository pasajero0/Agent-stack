import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { select, checkbox, input, confirm } from "@inquirer/prompts";
import chalk from "chalk";
import { detectProject, type ProjectContext } from "../detect/project.js";
import { detectAll, getAllAdapters } from "../providers/registry.js";
import type { ProviderAdapter } from "../providers/types.js";
import { MCP_CATALOG } from "../mcp/catalog.js";
import type { McpServerDefinition } from "../mcp/types.js";
import { installMcpServers } from "../mcp/installer.js";
import { loadAgentDefaults, type AgentDefault } from "../agents/defaults.js";
import { parseAgentsContent } from "../agents/parser.js";
import { generateConfigs, writeGeneratedFiles } from "../agents/generator.js";
import { banner, log } from "../utils/logger.js";

interface WizardAnswers {
  projectName?: string;
  selectedAgents: string[];
  mcpServers: McpServerDefinition[];
  envValues: Record<string, string>;
  providerIds: string[];
}

export async function initCommand(): Promise<void> {
  banner();

  // ── Step 1: detect() ──────────────────────────────────────────
  log.step("Detecting environment...");

  const project = await detectProject(process.cwd());
  if (project.scenario === "existing") {
    const name = project.projectName
      ? chalk.cyan(project.projectName)
      : chalk.dim("unnamed");
    log.info(`Existing project: ${name}`);
  } else {
    log.info("Empty directory — fresh setup");
  }

  console.log();
  const providerResults = await detectAll();

  for (const { info } of providerResults) {
    const status = info.installed
      ? chalk.green("  ✔ " + info.displayName)
      : chalk.dim("  ✖ " + info.displayName);
    const version = info.version ? chalk.dim(` (${info.version})`) : "";
    console.log(`${status}${version}`);
  }
  console.log();

  const installed = providerResults.filter((r) => r.info.installed);
  const notInstalled = providerResults.filter((r) => !r.info.installed);

  let activeAdapters: ProviderAdapter[] = installed.map((r) => r.adapter);

  if (installed.length === 0) {
    log.warn("No AI coding providers detected.");
    const toInstall = await select({
      message: "Which provider would you like to install?",
      choices: notInstalled.map((r) => ({
        name: r.info.displayName,
        value: r.adapter.id,
      })),
    });

    const adapter = getAllAdapters().find((a) => a.id === toInstall);
    if (adapter) {
      await adapter.install();
      activeAdapters = [adapter];
    }
  } else if (notInstalled.length > 0) {
    const installMore = await confirm({
      message: `Install additional providers? (${notInstalled.map((r) => r.info.displayName).join(", ")})`,
      default: false,
    });

    if (installMore) {
      for (const { adapter } of notInstalled) {
        await adapter.install();
        activeAdapters.push(adapter);
      }
    }
  }

  if (activeAdapters.length === 0) {
    log.error("No providers available. Exiting.");
    process.exit(1);
  }

  // ── Step 2: wizard() ──────────────────────────────────────────
  console.log();
  log.step("Configuration");

  let answers: WizardAnswers;
  if (project.scenario === "existing") {
    answers = await runExistingProjectWizard(project, activeAdapters);
  } else {
    answers = await runEmptyProjectWizard(activeAdapters);
  }

  // ── Step 3: generateAGENTS() ──────────────────────────────────
  console.log();
  log.step("Generating AGENTS.md...");

  const agentsContent = renderAgentsTemplate(answers);
  const agentsPath = resolve(process.cwd(), "AGENTS.md");

  if (existsSync(agentsPath)) {
    const overwrite = await confirm({
      message: "AGENTS.md already exists. Overwrite?",
      default: false,
    });
    if (!overwrite) {
      log.info("Keeping existing AGENTS.md");
    } else {
      await writeFile(agentsPath, agentsContent, "utf-8");
      log.success("Updated AGENTS.md");
    }
  } else {
    await writeFile(agentsPath, agentsContent, "utf-8");
    log.success("Created AGENTS.md");
  }

  // ── Step 4: deployAdapters() ──────────────────────────────────
  console.log();
  log.step("Deploying provider configs...");

  const finalContent = existsSync(agentsPath)
    ? await readFile(agentsPath, "utf-8")
    : agentsContent;

  const config = parseAgentsContent(finalContent);
  const projectDir = process.cwd();

  const files = await generateConfigs(activeAdapters, config.agents, projectDir);
  if (files.length > 0) {
    await writeGeneratedFiles(files, projectDir);
  }

  if (answers.mcpServers.length > 0) {
    console.log();
    await installMcpServers(activeAdapters, answers.mcpServers, answers.envValues);
  }

  // ── Summary ───────────────────────────────────────────────────
  console.log();
  console.log(chalk.bold.green("  Setup complete!"));
  console.log();
  log.dim("  Next steps:");
  log.dim("  • Edit AGENTS.md to customize agent definitions");
  log.dim("  • Run 'agent-stack generate' to regenerate provider configs");
  log.dim("  • Run 'agent-stack sync' for detect + generate in one step");
  log.dim("  • Run 'agent-stack mcp list' to verify MCP servers");
  console.log();
}

async function runExistingProjectWizard(
  project: ProjectContext,
  adapters: ProviderAdapter[]
): Promise<WizardAnswers> {
  const defaults = loadAgentDefaults();
  const agentNames = Object.keys(defaults).filter((n) => n !== "scout");

  const selectedAgents = await checkbox({
    message: "Which agents to configure?",
    choices: agentNames.map((name) => ({
      name: `${defaults[name].title} — ${defaults[name].systemPrompt.slice(0, 60)}...`,
      value: name,
      checked: true,
    })),
  });

  const { mcpServers, envValues } = await collectMcpConfig();

  return {
    projectName: project.projectName,
    selectedAgents,
    mcpServers,
    envValues,
    providerIds: adapters.map((a) => a.id),
  };
}

async function runEmptyProjectWizard(
  adapters: ProviderAdapter[]
): Promise<WizardAnswers> {
  const projectName = await input({
    message: "Project name:",
    default: "my-project",
  });

  const defaults = loadAgentDefaults();
  const agentNames = Object.keys(defaults).filter((n) => n !== "scout");

  const selectedAgents = await checkbox({
    message: "Which agents to configure?",
    choices: agentNames.map((name) => ({
      name: `${defaults[name].title} — ${defaults[name].systemPrompt.slice(0, 60)}...`,
      value: name,
      checked: true,
    })),
  });

  const { mcpServers, envValues } = await collectMcpConfig();

  return {
    projectName,
    selectedAgents,
    mcpServers,
    envValues,
    providerIds: adapters.map((a) => a.id),
  };
}

async function collectMcpConfig(): Promise<{
  mcpServers: McpServerDefinition[];
  envValues: Record<string, string>;
}> {
  const selectedNames = await checkbox({
    message: "Select MCP servers to install:",
    choices: MCP_CATALOG.map((s) => ({
      name: `${s.displayName} — ${s.description}`,
      value: s.name,
      checked: !s.optional,
    })),
  });

  const mcpServers = MCP_CATALOG.filter((s) => selectedNames.includes(s.name));
  const envValues: Record<string, string> = {};

  for (const server of mcpServers) {
    if (server.envPrompts) {
      for (const [key, prompt] of Object.entries(server.envPrompts)) {
        const value = await input({
          message: prompt + chalk.dim(" (enter to skip)"),
        });
        envValues[key] = value || "<your-token-here>";
      }
    }
  }

  return { mcpServers, envValues };
}

function renderAgentsTemplate(answers: WizardAnswers): string {
  const defaults = loadAgentDefaults();

  let content = `---\nversion: 1\n`;
  if (answers.projectName) {
    content += `project: ${answers.projectName}\n`;
  }
  content += `defaults:\n  model: claude-sonnet-4-20250514\n---\n`;

  for (const agentName of answers.selectedAgents) {
    const agent = defaults[agentName];
    if (!agent) continue;

    content += `\n## ${agent.title}\n\n`;
    content += `<!-- role: ${agent.role} -->\n`;
    content += `<!-- providers: ${answers.providerIds.join(", ")} -->\n\n`;

    content += `### System Prompt\n\n`;
    content += `${agent.systemPrompt}\n\n`;

    if (agent.rules.length > 0) {
      content += `### Rules\n\n`;
      for (const rule of agent.rules) {
        content += `- ${rule}\n`;
      }
    }

    content += `\n---\n`;
  }

  return content;
}
