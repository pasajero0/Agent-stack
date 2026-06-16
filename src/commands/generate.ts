import { existsSync } from "node:fs";
import { join } from "node:path";
import { emitHarness } from "../claude/harness.js";
import { banner, log } from "../utils/logger.js";

export async function generateCommand(options: { force?: boolean } = {}): Promise<void> {
  banner();

  const projectDir = process.cwd();

  if (existsSync(join(projectDir, ".claude")) && !options.force) {
    log.error(".claude/ already exists.");
    log.info("Run `agent-stack update` to refresh the harness (preserves rules/ and tmp/),");
    log.info("or pass --force to overwrite from scratch.");
    process.exit(1);
  }

  log.step("Detecting project and generating the Claude harness...");
  const files = await emitHarness(projectDir);

  console.log();
  log.success(`Generated ${files.length} harness file(s).`);
  log.dim("  Next steps:");
  log.dim(
    "  • Exclude the harness from git: add .claude/, CLAUDE.md, CODEMAP.md to .git/info/exclude"
  );
  log.dim(
    "  • Generate rules: open `claude` and run the pattern-scout subagent (.claude/rules/ is empty by design)"
  );
  log.dim("  • Smoke-test the guards: a `git push` or foreign package-manager command should block");
}
