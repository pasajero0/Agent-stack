import { existsSync } from "node:fs";
import { join } from "node:path";
import { detectHarnessParams } from "../detect/harness-params.js";
import {
  buildHarnessFiles,
  planUpdate,
  removeHarnessFiles,
  RoutingTemplateError,
  writeHarnessFiles,
  type UpdatePlan,
} from "../claude/harness.js";
import { missingSandboxTools, toolsLine } from "../claude/sandbox.js";
import { banner, log } from "../utils/logger.js";
import { commandExists } from "../utils/shell.js";

/** `templatesDir`, `platform` and `exists` are test seams: where templates are read from, and the tools check. */
export async function updateCommand(
  options: {
    dryRun?: boolean;
    force?: boolean;
    templatesDir?: string;
    platform?: string;
    exists?: (cmd: string) => Promise<boolean>;
  } = {}
): Promise<void> {
  banner();

  const projectDir = process.cwd();
  if (!existsSync(join(projectDir, ".claude"))) {
    log.error("No .claude/ found. Run `agent-stack generate` to deploy the harness first.");
    process.exit(1);
  }

  const params = await detectHarnessParams(projectDir);
  let built;
  try {
    built = buildHarnessFiles(params, options.templatesDir);
  } catch (e) {
    if (!(e instanceof RoutingTemplateError)) throw e;
    log.error(e.message);
    process.exit(1);
  }
  const plan = planUpdate(projectDir, built, { force: options.force });
  const keys = plan.routingKeysAdded;
  const missing = await missingSandboxTools(options.platform ?? process.platform, options.exists ?? commandExists);

  if (options.dryRun) {
    log.step("Harness update preview (dry run):");
    plan.created.forEach((p) => console.log(`  + ${p}`));
    plan.changed.forEach((p) => console.log(`  ~ ${p}`));
    plan.removed.forEach((p) => console.log(`  - ${p} (no longer part of the harness)`));
    plan.kept.forEach((p) =>
      console.log(
        p === ".claude/gates.json" && plan.routingAdded
          ? `  ~ ${p} (routing block added)`
          : p === ".claude/gates.json" && keys.length
            ? `  ~ ${p} (${keys.map((k) => `routing.${k}`).join(", ")} added)`
            : `  = ${p} (yours — kept)`
      )
    );
    plan.edited.forEach((p) => console.log(`  = ${p} (you changed it — kept; --force overwrites)`));
    reportExtras(projectDir, plan, missing);
    console.log();
    log.dim(`  ${plan.unchanged} unchanged. rules/ and tmp/ are preserved (not emitter-owned).`);
    return;
  }

  log.step("Updating the Claude harness...");
  await writeHarnessFiles(projectDir, plan.gatesWithRouting ? [...plan.toWrite, plan.gatesWithRouting] : plan.toWrite);
  await removeHarnessFiles(projectDir, plan.removed);

  console.log();
  log.success(
    `Harness updated: ${plan.created.length} added, ${plan.changed.length} changed, ` +
      `${plan.removed.length} removed, ${plan.unchanged} unchanged, ` +
      `${plan.kept.length + plan.edited.length} kept as yours.`
  );
  if (plan.routingAdded) log.dim("  added the routing block to .claude/gates.json");
  if (keys.length) log.dim(`  added ${keys.map((k) => `routing.${k}`).join(", ")} to .claude/gates.json`);
  log.dim(
    "  .claude/rules/, .claude/tmp/ and your seed files (CLAUDE.md, gates.json…) were left untouched" +
      (plan.routingAdded
        ? ", except the routing block added to gates.json."
        : keys.length
          ? ", except the routing keys added to gates.json."
          : ".")
  );
  plan.edited.forEach((p) => log.dim(`  kept ${p} — you changed it since it was deployed; --force overwrites`));
  reportExtras(projectDir, plan, missing);
}

function reportExtras(projectDir: string, plan: UpdatePlan, missingTools: readonly string[]): void {
  plan.customHooks.forEach((h) => log.dim(`  kept your hook in settings.json — ${h}`));
  plan.customSettings.forEach((s) => log.dim(`  kept your setting in settings.json — ${s}`));
  plan.retiredHooks.forEach((h) => {
    const path = `.claude/hooks/${h}`;
    // The delete clause only when the file is there and update neither deletes it nor lists it as orphaned.
    const ask = existsSync(join(projectDir, path)) && !plan.removed.includes(path) && !plan.orphaned.includes(path);
    log.dim(`  dropped ${h} from settings.json — no longer part of the harness${ask ? `; delete ${path}` : ""}`);
  });
  plan.orphaned.forEach((p) =>
    log.dim(`  left ${p} — no longer part of the harness, but you changed it; delete it if unused`)
  );
  if (plan.noHashes) {
    log.warn(
      "This harness predates file hashes, so your own edits cannot be told apart this time: every `~` file " +
        "is overwritten, hand edits included. Copy any you changed first. From the next update on, " +
        "files you change are kept."
    );
  }
  if (plan.gatesWarning) log.warn(plan.gatesWarning);
  if (plan.settingsUnreadable) {
    log.warn(".claude/settings.json is not valid JSON, so it was left as is. Fix it, then run update again.");
  }
  if (plan.readDenyWarning) log.warn(plan.readDenyWarning);
  plan.permissionLines.forEach((l) => log.warn(l));
  plan.sandboxLines.forEach((l) => (l.kind === "warn" ? log.warn(l.text) : log.dim(l.text)));
  if (missingTools.length > 0) log.warn(toolsLine(missingTools));
}
