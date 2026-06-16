import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { detectHarnessParams } from "../detect/harness-params.js";
import { buildHarnessFiles, writeHarnessFiles } from "../claude/harness.js";
import { banner, log } from "../utils/logger.js";

export async function updateCommand(options: { dryRun?: boolean } = {}): Promise<void> {
  banner();

  const projectDir = process.cwd();
  if (!existsSync(join(projectDir, ".claude"))) {
    log.error("No .claude/ found. Run `agent-stack generate` to deploy the harness first.");
    process.exit(1);
  }

  const params = await detectHarnessParams(projectDir);
  const files = buildHarnessFiles(params);

  // Classify against what's on disk (emitter-owned files only).
  const created: string[] = [];
  const changed: string[] = [];
  let unchanged = 0;
  for (const f of files) {
    const full = join(projectDir, f.path);
    if (!existsSync(full)) created.push(f.path);
    else if (readFileSync(full, "utf-8") !== f.content) changed.push(f.path);
    else unchanged++;
  }

  if (options.dryRun) {
    log.step("Harness update preview (dry run):");
    created.forEach((p) => console.log(`  + ${p}`));
    changed.forEach((p) => console.log(`  ~ ${p}`));
    console.log();
    log.dim(`  ${unchanged} unchanged. rules/ and tmp/ are preserved (not emitter-owned).`);
    return;
  }

  log.step("Updating the Claude harness...");
  await writeHarnessFiles(projectDir, files);

  console.log();
  log.success(
    `Harness updated: ${created.length} added, ${changed.length} changed, ${unchanged} unchanged.`
  );
  log.dim("  .claude/rules/ and .claude/tmp/ were left untouched.");
}
