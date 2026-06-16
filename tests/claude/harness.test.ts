import { describe, it, expect } from "vitest";
import { buildHarnessFiles } from "../../src/claude/harness.js";
import type { HarnessParams } from "../../src/detect/harness-params.js";

const PARAMS: HarnessParams = {
  packageManager: "pnpm",
  forbiddenPms: "npm|yarn|bun",
  lockfile: "pnpm-lock.yaml",
  generatedGlobs: "*/dist/*|dist/*|*.d.ts|*.map",
  docsDir: "docs/",
  mainBranch: "main",
  forgeCli: "gh",
  commands: ["pnpm typecheck", "pnpm test"],
};

describe("buildHarnessFiles", () => {
  const files = buildHarnessFiles(PARAMS);
  const byPath = (p: string) => files.find((f) => f.path === p);

  it("emits hooks with tokens substituted", () => {
    const guard = byPath(".claude/hooks/guard-bash.sh");
    expect(guard).toBeDefined();
    expect(guard!.content).toContain("(npm|yarn|bun)");
    expect(guard!.content).toContain("pnpm only");
  });

  it("leaves no unsubstituted {{TOKEN}} anywhere", () => {
    for (const f of files) expect(f.content).not.toMatch(/\{\{[A-Z_]+\}\}/);
  });

  it("builds settings.json in the correct Claude Code schema", () => {
    const s = JSON.parse(byPath(".claude/settings.json")!.content);
    expect(s.hooks.PreToolUse[0].matcher).toBe("Bash");
    expect(s.hooks.PreToolUse[0].hooks[0].command).toContain(
      "$CLAUDE_PROJECT_DIR/.claude/hooks/guard-bash.sh"
    );
    expect(s.permissions.allow).toContain("Bash(pnpm typecheck:*)");
  });

  it("does not deploy generator-input files (_*)", () => {
    expect(byPath(".claude/_TOKENS.md")).toBeUndefined();
    expect(byPath(".claude/_normative.md")).toBeUndefined();
  });

  it("appends the normative sections to CLAUDE.md", () => {
    const claude = byPath("CLAUDE.md")!.content;
    expect(claude).toContain("Multi-step migrations");
    expect(claude).toContain("Scope discipline");
  });

  it("emits an empty rules dir via its README", () => {
    expect(byPath(".claude/rules/README.md")).toBeDefined();
  });
});
