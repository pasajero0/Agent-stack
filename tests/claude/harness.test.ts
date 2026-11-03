import { describe, it, expect } from "vitest";
import { buildHarnessFiles } from "../../src/claude/harness.js";
import { PY_PARAMS, TS_PARAMS as PARAMS } from "../hooks/fixture.js";

describe("buildHarnessFiles", () => {
  const files = buildHarnessFiles(PARAMS);
  const byPath = (p: string) => files.find((f) => f.path === p);

  it("puts stack-specific values in gates.json, not in the hooks", () => {
    const gates = JSON.parse(byPath(".claude/gates.json")!.content);
    expect(gates.packageManager).toBe("pnpm");
    expect(gates.forbiddenPackageManagers).toEqual(["npm", "yarn", "bun"]);
    expect(gates.protectedGlobs).toContain("*pnpm-lock.yaml");
    expect(gates.baseBranch).toBe("main");
    expect(gates.mode).toBe("interactive");
    expect(byPath(".claude/hooks/guard-bash.sh")!.content).not.toContain("pnpm");
  });

  it("emits a JS-free gate config for a non-JS stack", () => {
    const py = buildHarnessFiles(PY_PARAMS);
    const gates = JSON.parse(py.find((f) => f.path === ".claude/gates.json")!.content);
    expect(gates.forbiddenPackageManagers).toEqual([]);
    expect(gates.protectedGlobs).toEqual(["*/__pycache__/*", "*.pyc", "*uv.lock"]);
    expect(gates.commands.test).toBe("uv run pytest");
    const claude = py.find((f) => f.path === "CLAUDE.md")!.content;
    expect(claude).toContain("**uv** only");
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
    for (const section of [
      "## Explaining to the human",
      "## Spec-driven workflow",
      "## Report contract",
      "## Modes",
      "## Model routing",
      "## Multi-step migrations",
      "## Scope discipline",
      "## Subagent delegation",
    ]) {
      expect(claude).toContain(section);
    }
  });

  it("ships the spec-driven skills with their templates", () => {
    for (const skill of ["grill", "adr", "spec", "plan"]) {
      const f = byPath(`.claude/skills/${skill}/SKILL.md`);
      expect(f, skill).toBeDefined();
      expect(f!.content).toMatch(/^---\ndescription: /);
    }
    expect(byPath(".claude/skills/spec/template.md")!.content).toContain("IF <invalid input");
    expect(byPath(".claude/skills/adr/template.md")!.content).toContain("Alternatives considered");
  });

  it("gives every subagent a model and an effort level (routing)", () => {
    const agents = files.filter((f) => f.path.startsWith(".claude/agents/"));
    const expected: Record<string, string> = {
      "code-reviewer": "opus",
      "spec-reviewer": "opus",
      "task-analyzer": "opus",
      "pattern-scout": "opus",
      implementer: "sonnet",
      "test-writer": "sonnet",
      researcher: "haiku",
    };
    expect(agents.map((a) => a.path.replace(/^.*\/|\.md$/g, "")).sort()).toEqual(
      Object.keys(expected).sort()
    );
    for (const a of agents) {
      const front = a.content.split("---")[1];
      const name = /^name: (.+)$/m.exec(front)![1];
      expect(/^model: (.+)$/m.exec(front)![1], name).toBe(expected[name]);
      expect(/^effort: (low|medium|high|xhigh|max)$/m.test(front), name).toBe(true);
    }
  });

  it("emits an empty rules dir via its README", () => {
    expect(byPath(".claude/rules/README.md")).toBeDefined();
  });

  it("stamps a version manifest with template version + params", () => {
    const m = byPath(".claude/.harness.json");
    expect(m).toBeDefined();
    const parsed = JSON.parse(m!.content);
    expect(typeof parsed.templateVersion).toBe("string");
    expect(parsed.params.packageManager).toBe("pnpm");
  });
});
