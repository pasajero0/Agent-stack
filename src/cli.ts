import { Command } from "commander";
import { initCommand } from "./commands/init.js";
import { detectCommand } from "./commands/detect.js";
import { mcpCommand } from "./commands/mcp.js";
import { generateCommand } from "./commands/generate.js";
import { updateCommand } from "./commands/update.js";
import { syncCommand } from "./commands/sync.js";
import { usageCommand } from "./commands/usage.js";
import { runAction } from "./commands/run.js";
import { toolVersion } from "./claude/harness.js";

export const program = new Command();

program
  .name("agent-stack")
  .description("CLI that deploys a Claude Code harness and manages MCP servers")
  .version(toolVersion());

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
  .description("Install and configure MCP servers for Claude Code")
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
  .description("Update an existing harness to the current version (keeps seed files, rules/ and tmp/)")
  .option("--dry-run", "Show what would change without writing")
  .option("-f, --force", "Also overwrite harness files you changed since they were deployed")
  .action(updateCommand);

program
  .command("sync")
  .description("Detect Claude Code and generate or update the harness")
  .action(syncCommand);

program
  .command("usage")
  .description("Report what the harness did in this project's Claude Code session logs")
  .option("--days <n>", "Only count the last n days")
  .option("--logs <dir>", "Read logs from this directory instead of ~/.claude/projects/<project>")
  .option("--json", "Print the report as JSON")
  .option("--save", "Also save the summary to .claude/tmp/usage/<date>.json (counts only, no conversation text)")
  .action(usageCommand);

program
  .command("run")
  .description('Drive the pipeline: run quick|task "<description>", or --resume / --status / --cancel a run')
  .argument("[mode]", "quick or task")
  .argument("[description]", "what to build or fix")
  .option("--stage <id>", "stage id the task gate proposes (still validated)")
  .option("--resume [id]", "continue a waiting or interrupted run (default: the locked one)")
  .option("--status [id]", "print the run; change nothing")
  .option("--cancel [id]", "cancel a waiting or interrupted run")
  .action(runAction);
