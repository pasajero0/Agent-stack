import { existsSync } from "node:fs";
import { join } from "node:path";
import { emitHarness, RoutingTemplateError } from "../claude/harness.js";
import { missingSandboxTools, toolsLine } from "../claude/sandbox.js";
import { banner, log } from "../utils/logger.js";
import { commandExists } from "../utils/shell.js";
import { printNextSteps } from "./next-steps.js";

/** `templatesDir`, `platform` and `exists` are test seams: where templates are read from, and the tools check. */
export async function generateCommand(
  options: {
    force?: boolean;
    templatesDir?: string;
    platform?: string;
    exists?: (cmd: string) => Promise<boolean>;
  } = {}
): Promise<void> {
  banner();

  const projectDir = process.cwd();

  if (existsSync(join(projectDir, ".claude")) && !options.force) {
    log.error(".claude/ already exists.");
    log.info("Run `agent-stack update` to refresh the harness (preserves rules/ and tmp/),");
    log.info("or pass --force to overwrite everything — including your gates.json, CLAUDE.md and settings.local.json.");
    process.exit(1);
  }

  log.step("Detecting project and generating the Claude harness...");
  let files;
  try {
    files = await emitHarness(projectDir, options.templatesDir);
  } catch (e) {
    if (!(e instanceof RoutingTemplateError)) throw e;
    log.error(e.message);
    process.exit(1);
  }

  console.log();
  log.success(`Generated ${files.length} harness file(s).`);
  const missing = await missingSandboxTools(options.platform ?? process.platform, options.exists ?? commandExists);
  if (missing.length > 0) log.warn(toolsLine(missing));
  printNextSteps();
}
