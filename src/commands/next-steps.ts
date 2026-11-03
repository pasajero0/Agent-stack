import { log } from "../utils/logger.js";

/** What to do right after the harness lands in a repo — shared by `generate` and `init`. */
export function printNextSteps(): void {
  log.dim("  Next steps:");
  log.dim("  • Review .claude/gates.json — base branch, specGate (strict|stage|off), test/lint commands, mode");
  log.dim("  • Exclude the harness from git: add .claude/, CLAUDE.md, CODEMAP.md to .git/info/exclude");
  log.dim("  • Work a stage: /grill → /spec <stage> → human merges the spec MR → /plan <stage> → implement");
  log.dim("  • Code edits stay blocked until the stage's spec is merged — that is the spec-gate working");
  log.dim("  • Generate rules: run the pattern-scout subagent (.claude/rules/ is empty by design)");
}
