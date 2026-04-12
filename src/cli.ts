import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { detectCommand } from "./commands/detect.js";
import { mcpCommand } from "./commands/mcp.js";
import { generateCommand } from "./commands/generate.js";
import { syncCommand } from "./commands/sync.js";

export const program = new Command();

program
  .name("agent-stack")
  .description("CLI configurator for AI coding environments")
  .version("0.1.0");

program
  .command("init")
  .description("Full setup wizard: detect providers, install MCP servers, generate configs")
  .action(initCommand);

program
  .command("detect")
  .description("Detect installed AI coding providers")
  .action(detectCommand);

const mcp = program
  .command("mcp")
  .description("Manage MCP servers");

mcp
  .command("install")
  .description("Install and configure MCP servers for detected providers")
  .action(() => mcpCommand("install"));

mcp
  .command("list")
  .description("List configured MCP servers")
  .action(() => mcpCommand("list"));

program
  .command("generate")
  .description("Generate provider-specific configs from AGENTS.md")
  .option("-p, --path <path>", "Path to AGENTS.md", "AGENTS.md")
  .action(generateCommand);

program
  .command("sync")
  .description("Detect providers and regenerate configs from AGENTS.md")
  .action(syncCommand);
