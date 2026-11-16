import { existsSync } from "node:fs";
import { join } from "node:path";
import { detectHarnessParams } from "../detect/harness-params.js";
import { buildHarnessFiles, planUpdate, writeHarnessFiles, type UpdatePlan } from "../claude/harness.js";
import { banner, log } from "../utils/logger.js";

export async function updateCommand(options: { dryRun?: boolean } = {}): Promise<void> {
  banner();

  const projectDir = process.cwd();
  if (!existsSync(join(projectDir, ".claude"))) {
    log.error("No .claude/ found. Run `agent-stack generate` to deploy the harness first.");
    process.exit(1);
  }

  const params = await detectHarnessParams(projectDir);
  const plan = planUpdate(projectDir, buildHarnessFiles(params));

  if (options.dryRun) {
    log.step("Harness update preview (dry run):");
    plan.created.forEach((p) => console.log(`  + ${p}`));
    plan.changed.forEach((p) => console.log(`  ~ ${p}`));
    plan.kept.forEach((p) => console.log(`  = ${p} (yours — kept)`));
    reportHooks(plan);
    console.log();
    log.dim(`  ${plan.unchanged} unchanged. rules/ and tmp/ are preserved (not emitter-owned).`);
    return;
  }

  log.step("Updating the Claude harness...");
  await writeHarnessFiles(projectDir, plan.toWrite);

  console.log();
  log.success(
    `Harness updated: ${plan.created.length} added, ${plan.changed.length} changed, ` +
      `${plan.unchanged} unchanged, ${plan.kept.length} kept as yours.`
  );
  log.dim("  .claude/rules/, .claude/tmp/ and your seed files (CLAUDE.md, gates.json…) were left untouched.");
  reportHooks(plan);
}

function reportHooks(plan: UpdatePlan): void {
  plan.customHooks.forEach((h) => log.dim(`  kept your hook in settings.json — ${h}`));
  plan.retiredHooks.forEach((h) =>
    log.dim(`  dropped ${h} from settings.json — no longer part of the harness; delete .claude/hooks/${h}`)
  );
  if (plan.settingsUnreadable) {
    log.warn(".claude/settings.json is not valid JSON, so it was left as is. Fix it, then run update again.");
  }
}
