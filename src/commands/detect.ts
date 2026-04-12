import chalk from "chalk";
import { detectAll } from "../providers/registry.js";
import { detectProject } from "../detect/project.js";
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
  log.step("Detecting installed AI coding providers...");
  console.log();

  const results = await detectAll();

  for (const { info } of results) {
    const status = info.installed
      ? chalk.green("✔ installed")
      : chalk.dim("✖ not found");

    const version = info.version ? chalk.dim(` (${info.version})`) : "";
    console.log(`  ${info.displayName.padEnd(20)} ${status}${version}`);
  }

  console.log();

  const installed = results.filter((r) => r.info.installed);
  if (installed.length === 0) {
    log.warn("No AI coding providers detected.");
    log.info("Run 'agent-stack init' to install and configure one.");
  } else {
    log.success(`${installed.length} provider(s) detected.`);
  }
}
