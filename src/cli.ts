import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { detectCommand } from "./commands/detect.js";
import { mcpCommand } from "./commands/mcp.js";
import { generateCommand } from "./commands/generate.js";
import { updateCommand } from "./commands/update.js";
import { syncCommand } from "./commands/sync.js";

export const program = new Command();

program
  .name("agent-stack")
  .description("CLI that deploys a Claude Code harness and manages MCP servers")
  .version("0.1.0");

program
  .command("init")
  .description("Setup wizard: detect Claude Code, deploy the harness, install MCP servers")
  .action(initCommand);

program
  .command("detect")
  .description("Detect the project and whether Claude Code is installed")
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
  .description("Deploy the Claude harness into the current repo (fresh)")
  .option("-f, --force", "Overwrite an existing .claude/ harness")
  .action(generateCommand);

program
  .command("update")
  .description("Update an existing harness to the current version (preserves rules/ and tmp/)")
  .option("--dry-run", "Show what would change without writing")
  .action(updateCommand);

program
  .command("sync")
  .description("Detect Claude Code and generate or update the harness")
  .action(syncCommand);
