import { checkbox, input, confirm } from "@inquirer/prompts";
import chalk from "chalk";
import { detectProject } from "../detect/project.js";
import { detectAll } from "../providers/registry.js";
import type { ProviderAdapter } from "../providers/types.js";
import { MCP_CATALOG } from "../mcp/catalog.js";
import type { McpServerDefinition } from "../mcp/types.js";
import { installMcpServers } from "../mcp/installer.js";
import { emitHarness } from "../claude/harness.js";
import { banner, log } from "../utils/logger.js";

export async function initCommand(): Promise<void> {
  banner();

  // ── Step 1: detect ────────────────────────────────────────────
  log.step("Detecting environment...");

  const project = await detectProject(process.cwd());
  if (project.scenario === "existing") {
    const name = project.projectName ? chalk.cyan(project.projectName) : chalk.dim("unnamed");
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
  const activeAdapters: ProviderAdapter[] = installed.map((r) => r.adapter);

  if (installed.length === 0) {
    log.warn("Claude Code is not installed.");
    const doInstall = await confirm({ message: "Install Claude Code now?", default: true });
    if (doInstall) {
      for (const { adapter } of notInstalled) {
        await adapter.install();
        activeAdapters.push(adapter);
      }
    }
  }

  if (activeAdapters.length === 0) {
    log.error("No provider available. Exiting.");
    process.exit(1);
  }

  // ── Step 2: deploy the Claude harness ─────────────────────────
  console.log();
  log.step("Generating the Claude harness...");
  await emitHarness(process.cwd());

  // ── Step 3: MCP servers (optional) ────────────────────────────
  const { mcpServers, envValues } = await collectMcpConfig();
  if (mcpServers.length > 0) {
    console.log();
    await installMcpServers(activeAdapters, mcpServers, envValues);
  }

  // ── Summary ───────────────────────────────────────────────────
  console.log();
  console.log(chalk.bold.green("  Setup complete!"));
  console.log();
  log.dim("  Next steps:");
  log.dim("  • Exclude the harness from git: add .claude/, CLAUDE.md, CODEMAP.md to .git/info/exclude");
  log.dim("  • Generate rules: open `claude` and run the pattern-scout subagent (.claude/rules/ is empty by design)");
  log.dim("  • Smoke-test the guards: a `git push` or foreign package-manager command should block");
  console.log();
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
        const value = await input({ message: prompt + chalk.dim(" (enter to skip)") });
        envValues[key] = value || "<your-token-here>";
      }
    }
  }

  return { mcpServers, envValues };
}
