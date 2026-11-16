import { afterAll, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildHarnessFiles, planUpdate } from "../../src/claude/harness.js";
import { cleanupProjects, deployHarness, TS_PARAMS } from "../hooks/fixture.js";

afterAll(cleanupProjects);

describe("planUpdate", () => {
  it("re-running on an untouched harness changes nothing", () => {
    const dir = deployHarness();
    const plan = planUpdate(dir, buildHarnessFiles(TS_PARAMS));
    expect(plan.toWrite).toEqual([]);
    expect(plan.changed).toEqual([]);
  });

  it("keeps the user's seed files and restores emitter-owned ones", () => {
    const dir = deployHarness();
    writeFileSync(join(dir, "CLAUDE.md"), "# my own guide\n");
    writeFileSync(join(dir, ".claude/gates.json"), '{"mode":"autonomous"}\n');
    writeFileSync(join(dir, ".claude/hooks/guard-bash.sh"), "#!/bin/sh\nexit 0\n");

    const plan = planUpdate(dir, buildHarnessFiles(TS_PARAMS));
    expect(plan.kept).toEqual(expect.arrayContaining(["CLAUDE.md", ".claude/gates.json"]));
    expect(plan.changed).toEqual([".claude/hooks/guard-bash.sh"]);
    expect(plan.toWrite.map((f) => f.path)).toEqual([".claude/hooks/guard-bash.sh"]);
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf-8")).toBe("# my own guide\n");
  });

  const settingsPath = (dir: string) => join(dir, ".claude/settings.json");
  const readSettings = (dir: string) => JSON.parse(readFileSync(settingsPath(dir), "utf-8"));
  const plannedSettings = (plan: ReturnType<typeof planUpdate>) =>
    JSON.parse(plan.toWrite.find((f) => f.path === ".claude/settings.json")!.content);

  it("carries the user's own hooks into the regenerated settings.json", () => {
    const dir = deployHarness();
    const s = readSettings(dir);
    s.hooks.PreToolUse[1].hooks.push({ type: "command", command: "$CLAUDE_PROJECT_DIR/.claude/hooks/docs-guard.sh" });
    s.hooks.Notification = [{ hooks: [{ type: "command", command: "say done" }] }];
    s.permissions.allow.push("Bash(make:*)"); // not a hook: still regenerated (variant A1)
    writeFileSync(settingsPath(dir), JSON.stringify(s, null, 2));

    const plan = planUpdate(dir, buildHarnessFiles(TS_PARAMS));
    expect(plan.customHooks).toEqual([
      "PreToolUse (Edit|Write|MultiEdit|NotebookEdit): $CLAUDE_PROJECT_DIR/.claude/hooks/docs-guard.sh",
      "Notification: say done",
    ]);
    const next = plannedSettings(plan);
    const edits = next.hooks.PreToolUse.find((e: { matcher: string }) => e.matcher.startsWith("Edit"));
    expect(edits.hooks.map((h: { command: string }) => h.command)).toContain(
      "$CLAUDE_PROJECT_DIR/.claude/hooks/docs-guard.sh"
    );
    expect(next.hooks.Notification).toEqual([{ hooks: [{ type: "command", command: "say done" }] }]);
    expect(next.permissions.allow).not.toContain("Bash(make:*)");

    // a second update keeps them and finds nothing else to change
    writeFileSync(settingsPath(dir), plan.toWrite.find((f) => f.path === ".claude/settings.json")!.content);
    const again = planUpdate(dir, buildHarnessFiles(TS_PARAMS));
    expect(again.changed).toEqual([]);
    expect(again.customHooks).toHaveLength(2);
  });

  it("replaces an old unquoted harness entry instead of keeping it twice", () => {
    const dir = deployHarness();
    const raw = readFileSync(settingsPath(dir), "utf-8").replaceAll('\\"$CLAUDE_PROJECT_DIR\\"/', "$CLAUDE_PROJECT_DIR/");
    writeFileSync(settingsPath(dir), raw);

    const plan = planUpdate(dir, buildHarnessFiles(TS_PARAMS));
    expect(plan.customHooks).toEqual([]);
    expect(plan.changed).toEqual([".claude/settings.json"]);
    const guards = plannedSettings(plan).hooks.PreToolUse[0].hooks;
    expect(guards).toEqual([{ type: "command", command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/guard-bash.sh' }]);
  });

  it("drops a hook the harness used to ship instead of keeping it as the user's", () => {
    const dir = deployHarness();
    const s = readSettings(dir);
    s.hooks.PostToolUse[0].hooks.push({ type: "command", command: "$CLAUDE_PROJECT_DIR/.claude/hooks/post-edit-verify.sh" });
    writeFileSync(settingsPath(dir), JSON.stringify(s, null, 2));

    const plan = planUpdate(dir, buildHarnessFiles(TS_PARAMS));
    expect(plan.customHooks).toEqual([]);
    expect(plan.retiredHooks).toEqual(["post-edit-verify.sh"]);
    expect(JSON.stringify(plannedSettings(plan))).not.toContain("post-edit-verify");
  });

  it("leaves a settings.json that is not valid JSON alone and flags it", () => {
    const dir = deployHarness();
    writeFileSync(settingsPath(dir), "{ broken");
    const plan = planUpdate(dir, buildHarnessFiles(TS_PARAMS));
    expect(plan.settingsUnreadable).toBe(true);
    expect(plan.kept).toContain(".claude/settings.json");
    expect(plan.toWrite.map((f) => f.path)).not.toContain(".claude/settings.json");
  });

  it("keeps a custom hook whole — extra fields, non-command types — and ignores odd event names", () => {
    const dir = deployHarness();
    const s = readSettings(dir);
    s.hooks.Stop[0].hooks.push({ type: "command", command: "./notify.sh", timeout: 5, async: true });
    s.hooks.UserPromptSubmit = [{ hooks: [{ type: "prompt", prompt: "Check the plan first." }] }];
    s.hooks.constructor = [{ hooks: [{ type: "command", command: "x" }] }];
    s.hooks.PreToolUse.push({ matcher: "Read", hooks: [{ type: "command", command: "~/.claude/hooks/guard-bash.sh" }] });
    writeFileSync(settingsPath(dir), JSON.stringify(s, null, 2));

    const plan = planUpdate(dir, buildHarnessFiles(TS_PARAMS));
    const next = plannedSettings(plan);
    expect(next.hooks.Stop[0].hooks).toContainEqual({ type: "command", command: "./notify.sh", timeout: 5, async: true });
    expect(next.hooks.UserPromptSubmit).toEqual([{ hooks: [{ type: "prompt", prompt: "Check the plan first." }] }]);
    expect(Object.hasOwn(next.hooks, "constructor")).toBe(false);
    // a guard-bash.sh outside the project is the user's, not the harness's
    expect(next.hooks.PreToolUse.find((e: { matcher: string }) => e.matcher === "Read")).toBeDefined();
    expect(plan.customHooks).toContain("UserPromptSubmit: prompt hook");
  });
});
