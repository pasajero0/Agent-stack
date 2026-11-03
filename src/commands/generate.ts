import { existsSync } from "node:fs";
import { join } from "node:path";
import { emitHarness } from "../claude/harness.js";
import { banner, log } from "../utils/logger.js";
import { printNextSteps } from "./next-steps.js";

export async function generateCommand(options: { force?: boolean } = {}): Promise<void> {
  banner();

  const projectDir = process.cwd();

  if (existsSync(join(projectDir, ".claude")) && !options.force) {
    log.error(".claude/ already exists.");
    log.info("Run `agent-stack update` to refresh the harness (preserves rules/ and tmp/),");
    log.info("or pass --force to overwrite everything — including your gates.json, CLAUDE.md and settings.local.json.");
    process.exit(1);
  }

  log.step("Detecting project and generating the Claude harness...");
  const files = await emitHarness(projectDir);

  console.log();
  log.success(`Generated ${files.length} harness file(s).`);
  printNextSteps();
}
