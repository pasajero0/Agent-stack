import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { detectAll } from "../providers/registry.js";
import { parseAgentsFile } from "../agents/parser.js";
import { generateConfigs, writeGeneratedFiles } from "../agents/generator.js";
import { banner, log } from "../utils/logger.js";

export async function generateCommand(options: {
  path?: string;
}): Promise<void> {
  banner();

  const agentsPath = resolve(options.path ?? "AGENTS.md");
  if (!existsSync(agentsPath)) {
    log.error(`AGENTS.md not found at ${agentsPath}`);
    log.info("Run 'agent-stack init' to create one from a template.");
    process.exit(1);
  }

  log.step("Parsing AGENTS.md...");
  const config = await parseAgentsFile(agentsPath);
  log.success(`Found ${config.agents.length} agent(s): ${config.agents.map((a) => a.name).join(", ")}`);

  log.step("Detecting providers...");
  const results = await detectAll();
  const installed = results.filter((r) => r.info.installed);

  if (installed.length === 0) {
    log.error("No AI coding providers detected. Run 'agent-stack init' first.");
    process.exit(1);
  }

  const adapters = installed.map((r) => r.adapter);
  const projectDir = process.cwd();

  log.step("Generating provider configs...");
  const files = await generateConfigs(adapters, config.agents, projectDir);

  if (files.length === 0) {
    log.warn("No config files to generate.");
    return;
  }

  await writeGeneratedFiles(files, projectDir);

  console.log();
  log.success(`Generated ${files.length} config file(s).`);
}
