import chalk from "chalk";
import { detect } from "../claude/provider.js";
import { sandboxReadiness } from "../claude/sandbox.js";
import { detectProject } from "../detect/project.js";
import { commandExists } from "../utils/shell.js";
import { banner, log } from "../utils/logger.js";

export async function detectCommand(): Promise<void> {
  banner();

  // Project detection
  const project = await detectProject(process.cwd());
  if (project.scenario === "existing") {
    const name = project.projectName
      ? chalk.cyan(project.projectName)
      : chalk.dim("unnamed");
    log.info(`Existing project detected: ${name}`);
  } else {
    log.info("Empty directory — no existing project detected");
  }
  console.log();

  // Provider detection
  log.step("Detecting Claude Code...");
  console.log();

  const info = await detect();
  const status = info.installed ? chalk.green("✔ installed") : chalk.dim("✖ not found");
  const version = info.version ? chalk.dim(` (${info.version})`) : "";
  console.log(`  ${info.displayName.padEnd(20)} ${status}${version}`);
  const sandbox = await sandboxReadiness(process.platform, commandExists);
  console.log(`  ${"OS sandbox".padEnd(20)} ${sandbox}`);
  console.log();

  if (info.installed) {
    log.success("Claude Code detected.");
  } else {
    log.warn("Claude Code not detected.");
    log.info("Run 'agent-stack init' to install and configure it.");
  }
}
