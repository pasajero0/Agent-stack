import chalk from "chalk";
import { checkbox, input } from "@inquirer/prompts";
import { detect, listMcp } from "../claude/provider.js";
import { MCP_CATALOG } from "../mcp/catalog.js";
import { installMcpServers } from "../mcp/installer.js";
import { banner, log } from "../utils/logger.js";

export async function mcpCommand(action: "install" | "list"): Promise<void> {
  banner();

  const info = await detect();
  if (!info.installed) {
    log.error("Claude Code not detected. Run 'agent-stack init' first.");
    process.exit(1);
  }

  if (action === "list") {
    console.log();
    log.step(`${info.displayName} MCP servers:`);
    const servers = await listMcp();
    if (servers.length === 0) {
      log.dim("  No MCP servers configured");
    } else {
      for (const s of servers) {
        console.log(`  ${chalk.cyan(s.name.padEnd(25))} ${chalk.dim(s.command)} ${s.args.join(" ")}`);
      }
    }
    console.log();
    return;
  }

  // install flow
  const selectedServers = await checkbox({
    message: "Select MCP servers to install:",
    choices: MCP_CATALOG.map((s) => ({
      name: `${s.displayName} — ${s.description}`,
      value: s.name,
      checked: !s.optional,
    })),
  });

  const servers = MCP_CATALOG.filter((s) => selectedServers.includes(s.name));

  // Collect env vars
  const envValues: Record<string, string> = {};
  for (const server of servers) {
    if (server.envPrompts) {
      for (const [key, prompt] of Object.entries(server.envPrompts)) {
        const value = await input({ message: prompt });
        envValues[key] = value;
      }
    }
  }

  await installMcpServers(servers, envValues);

  console.log();
  log.success("MCP servers configured successfully!");
}
