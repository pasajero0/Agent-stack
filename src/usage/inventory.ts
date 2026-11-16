import { basename, join } from "node:path";
import type { UsageReport } from "./collect.js";
import { entries } from "./logs.js";

/** What the harness installed in `.claude/`, by kind. */
export interface Inventory {
  hooks: string[];
  bin: string[];
  agents: string[];
  skills: string[];
  commands: string[];
}

const NOT_A_HOOK = new Set(["gates-lib"]);

export function harnessInventory(projectDir: string): Inventory {
  const dir = join(projectDir, ".claude");
  return {
    hooks: names(join(dir, "hooks"), ".sh").filter((h) => !NOT_A_HOOK.has(h)),
    bin: names(join(dir, "bin"), ""),
    agents: names(join(dir, "agents"), ".md"),
    skills: dirs(join(dir, "skills")),
    commands: names(join(dir, "commands"), ".md"),
  };
}

/**
 * Installed parts with no event in the logs. A hook counts when it blocked or added context. Stop hooks
 * are left out: the log says a stop had output, not which hook (plugins run there too), so the report
 * shows their run counts separately instead of a verdict.
 */
export function neverActed(inv: Inventory, r: UsageReport): Inventory {
  const hookActed = (h: string) => (r.hookBlocks[h] ?? 0) > 0 || Object.hasOwn(r.stopRuns, h) || contextFrom(h, r);
  return {
    hooks: inv.hooks.filter((h) => !hookActed(h)),
    bin: inv.bin.filter((b) => !r.bin[b]),
    agents: inv.agents.filter((a) => !r.agents[a]),
    skills: inv.skills.filter((s) => !r.skills[s]),
    commands: inv.commands.filter((c) => !r.commands[c]),
  };
}

// Logs name the hook event, not the script, for added context: credit it to the one hook the harness
// ships for that event. A custom hook on the same event would share the credit.
const CONTEXT_EVENT = new Map([
  ["post-edit-lint", "PostToolUse"],
  ["session-start-context", "SessionStart"],
]);

function contextFrom(hook: string, r: UsageReport): boolean {
  const event = CONTEXT_EVENT.get(hook);
  return event !== undefined && Object.keys(r.hookContext).some((k) => k.startsWith(event));
}

function names(dir: string, ext: string): string[] {
  return entries(dir)
    .filter((e) => e.isFile() && !e.name.startsWith(".") && e.name.endsWith(ext))
    .map((e) => basename(e.name, ext))
    .sort();
}

function dirs(dir: string): string[] {
  return entries(dir)
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}
