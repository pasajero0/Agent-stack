import chalk from "chalk";
import { checkbox, input } from "@inquirer/prompts";
import { detectAll } from "../providers/registry.js";
import { MCP_CATALOG } from "../mcp/catalog.js";
import { installMcpServers } from "../mcp/installer.js";
import { banner, log } from "../utils/logger.js";

export async function mcpCommand(action: "install" | "list"): Promise<void> {
  banner();

  const results = await detectAll();
  const installed = results.filter((r) => r.info.installed);

  if (installed.length === 0) {
    log.error("No AI coding providers detected. Run 'agent-stack init' first.");
    process.exit(1);
  }

  if (action === "list") {
    for (const { adapter, info } of installed) {
      console.log();
      log.step(`${info.displayName} MCP servers:`);
      const servers = await adapter.listMcp();
      if (servers.length === 0) {
        log.dim("  No MCP servers configured");
      } else {
        for (const s of servers) {
          console.log(`  ${chalk.cyan(s.name.padEnd(25))} ${chalk.dim(s.command)} ${s.args.join(" ")}`);
        }
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
        const value = await input({
          message: prompt,
        });
        envValues[key] = value;
      }
    }
  }

  const adapters = installed.map((r) => r.adapter);
  await installMcpServers(adapters, servers, envValues);

  console.log();
  log.success("MCP servers configured successfully!");
}
