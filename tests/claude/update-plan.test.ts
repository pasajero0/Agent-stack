import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { buildHarnessFiles, planUpdate } from "../../src/claude/harness.js";
import { cleanupProjects, deployHarness, TS_PARAMS } from "../hooks/fixture.js";

afterAll(cleanupProjects);

describe("settings.local.json Read deny rules", () => {
  it("Q1: generate writes no Read(...) deny rules", () => {
    const f = buildHarnessFiles(TS_PARAMS).find((x) => x.path === ".claude/settings.local.json");
    expect(f?.content).not.toMatch(/Read\(/);
  });

  it("Q1: update leaves the file and warns with the lines to remove", () => {
    const dir = deployHarness();
    const file = join(dir, ".claude/settings.local.json");
    const mine = JSON.stringify({ permissions: { deny: ["Read(./**/node_modules/**)", "Bash(rm:*)"] } });
    writeFileSync(file, mine);
    const plan = planUpdate(dir, buildHarnessFiles(TS_PARAMS));
    expect(readFileSync(file, "utf-8")).toBe(mine);
    expect(plan.readDenyWarning).toContain("Read(./**/node_modules/**)");
    expect(plan.readDenyWarning).not.toContain("Bash(rm:*)");
    expect(plan.readDenyWarning).toContain("sandbox");
  });

  it("Q1: no warning when there are no Read rules", () => {
    const dir = deployHarness();
    expect(planUpdate(dir, buildHarnessFiles(TS_PARAMS)).readDenyWarning).toBeNull();
  });
});

describe("planUpdate", () => {
  it("re-running on an untouched harness changes nothing", () => {
    const dir = deployHarness();
    const plan = planUpdate(dir, buildHarnessFiles(TS_PARAMS));
    expect(plan.toWrite).toEqual([]);
    expect(plan.changed).toEqual([]);
  });

  it("keeps the user's seed files and harness files they changed; --force overwrites the latter", () => {
    const dir = deployHarness();
    writeFileSync(join(dir, "CLAUDE.md"), "# my own guide\n");
    writeFileSync(join(dir, ".claude/gates.json"), '{"mode":"autonomous"}\n');
    writeFileSync(join(dir, ".claude/hooks/guard-bash.sh"), "#!/bin/sh\nexit 0\n");

    const plan = planUpdate(dir, buildHarnessFiles(TS_PARAMS));
    expect(plan.kept).toEqual(expect.arrayContaining(["CLAUDE.md", ".claude/gates.json"]));
    expect(plan.edited).toEqual([".claude/hooks/guard-bash.sh"]);
    expect(plan.changed).toEqual([]);
    expect(plan.toWrite).toEqual([]);
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf-8")).toBe("# my own guide\n");

    const forced = planUpdate(dir, buildHarnessFiles(TS_PARAMS), { force: true });
    expect(forced.edited).toEqual([]);
    expect(forced.changed).toEqual([".claude/hooks/guard-bash.sh"]);
  });

  const manifestPath = (dir: string) => join(dir, ".claude/.harness.json");
  const sha = (t: string) => createHash("sha256").update(t).digest("hex");
  /** Record extra files in the deployed manifest, as if an earlier version had shipped them. */
  const recordInManifest = (dir: string, files: Record<string, string>) => {
    const m = JSON.parse(readFileSync(manifestPath(dir), "utf-8"));
    for (const [path, content] of Object.entries(files)) m.files[path] = sha(content);
    writeFileSync(manifestPath(dir), JSON.stringify(m, null, 2) + "\n");
  };
  const apply = (dir: string, plan: ReturnType<typeof planUpdate>) => {
    for (const f of plan.toWrite) writeFileSync(join(dir, f.path), f.content);
    for (const p of plan.removed) rmSync(join(dir, p));
  };

  it("deletes a file the harness no longer ships, keeps one the user changed, and settles", () => {
    const dir = deployHarness();
    writeFileSync(join(dir, ".claude/hooks/old-hook.sh"), "old\n");
    writeFileSync(join(dir, ".claude/hooks/old-mine.sh"), "mine, edited\n");
    recordInManifest(dir, { ".claude/hooks/old-hook.sh": "old\n", ".claude/hooks/old-mine.sh": "as shipped\n" });
    writeFileSync(join(dir, ".claude/hooks/guard-bash.sh"), "#!/bin/sh\nexit 0\n");

    const plan = planUpdate(dir, buildHarnessFiles(TS_PARAMS));
    expect(plan.removed).toEqual([".claude/hooks/old-hook.sh"]);
    expect(plan.orphaned).toEqual([".claude/hooks/old-mine.sh"]);
    expect(plan.changed).toEqual([".claude/.harness.json"]);
    apply(dir, plan);
    expect(existsSync(join(dir, ".claude/hooks/old-hook.sh"))).toBe(false);

    const again = planUpdate(dir, buildHarnessFiles(TS_PARAMS));
    expect(again.toWrite).toEqual([]);
    expect(again.edited).toEqual([".claude/hooks/guard-bash.sh"]); // still the user's
    expect(again.removed).toEqual([]);
  });

  it("never deletes through a manifest path outside the harness", () => {
    const dir = deployHarness();
    writeFileSync(join(dir, "README.md"), "x\n");
    writeFileSync(join(dir, ".claude/x.md"), "x\n");
    recordInManifest(dir, {
      "README.md": "x\n",
      "CLAUDE.md": readFileSync(join(dir, "CLAUDE.md"), "utf-8"),
      ".claude/../README.md": "x\n",
      ".claude/./x.md": "x\n",
    });
    mkdirSync(join(dir, ".claude/rules"), { recursive: true });
    writeFileSync(join(dir, ".claude/rules/mine.md"), "rule\n");
    recordInManifest(dir, { ".claude/rules/mine.md": "rule\n", ".claude/rules/": "" });
    const plan = planUpdate(dir, buildHarnessFiles(TS_PARAMS));
    expect(plan.removed).toEqual([]);
    expect(plan.orphaned).toEqual([]);
  });

  it("never deletes through a symlinked directory", () => {
    const dir = deployHarness();
    const outside = mkdtempSync(join(tmpdir(), "agent-stack-outside-"));
    writeFileSync(join(outside, "known.sh"), "known\n");
    symlinkSync(outside, join(dir, ".claude/linked"));
    recordInManifest(dir, { ".claude/linked/known.sh": "known\n" });
    const plan = planUpdate(dir, buildHarnessFiles(TS_PARAMS));
    expect(plan.removed).toEqual([]);
    expect(plan.orphaned).toEqual([".claude/linked/known.sh"]);
    rmSync(outside, { recursive: true, force: true });
  });

  it("keeps a file the harness never deployed here, and drops a permission it no longer generates", () => {
    const dir = deployHarness();
    rmSync(join(dir, ".claude/skills/spec/light-template.md"));
    const m = JSON.parse(readFileSync(manifestPath(dir), "utf-8"));
    delete m.files[".claude/skills/spec/light-template.md"]; // as if an older version did not ship it
    m.generatedAllow.push("Bash(old-tool:*)");
    writeFileSync(manifestPath(dir), JSON.stringify(m, null, 2) + "\n");
    writeFileSync(join(dir, ".claude/skills/spec/light-template.md"), "my own\n");
    const s = readSettings(dir);
    s.permissions.allow.push("Bash(old-tool:*)", "Bash(mine:*)");
    writeFileSync(settingsPath(dir), JSON.stringify(s, null, 2));

    const plan = planUpdate(dir, buildHarnessFiles(TS_PARAMS));
    expect(plan.edited).toEqual([".claude/skills/spec/light-template.md"]);
    const allow = plannedSettings(plan).permissions.allow;
    expect(allow).toContain("Bash(mine:*)");
    expect(allow).not.toContain("Bash(old-tool:*)");
  });

  it("a manifest without hashes (0.2) overwrites as before and says so once", () => {
    const dir = deployHarness();
    const m = JSON.parse(readFileSync(manifestPath(dir), "utf-8"));
    delete m.files;
    writeFileSync(manifestPath(dir), JSON.stringify(m, null, 2) + "\n");
    writeFileSync(join(dir, ".claude/hooks/guard-bash.sh"), "#!/bin/sh\nexit 0\n");

    const plan = planUpdate(dir, buildHarnessFiles(TS_PARAMS));
    expect(plan.noHashes).toBe(true);
    expect(plan.changed).toEqual(expect.arrayContaining([".claude/hooks/guard-bash.sh", ".claude/.harness.json"]));
    apply(dir, plan);
    const again = planUpdate(dir, buildHarnessFiles(TS_PARAMS));
    expect(again.noHashes).toBe(false);
    expect(again.toWrite).toEqual([]);
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
    s.permissions.allow.push("Bash(make:*)"); // the user's own permission and env survive (variant A2)
    s.permissions.deny = ["Bash(rm -rf:*)"];
    s.env = { FOO: "1" };
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
    expect(next.permissions.allow).toContain("Bash(make:*)");
    expect(next.permissions.allow).toContain("WebSearch");
    expect(next.permissions.deny).toEqual(["Bash(rm -rf:*)"]);
    expect(next.env).toEqual({ FOO: "1" });
    expect(plan.customSettings).toEqual(["env", "permissions.allow: Bash(make:*)", "permissions.deny"]);

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
