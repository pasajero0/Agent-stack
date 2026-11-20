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
    // The exceptions: RUNNERS (download-and-run commands of every ecosystem), JS_PMS and FROZEN_OK (the JS
    // install check) — the same in any repo, and kept in the hook because `update` never rewrites gates.json.
    const guardBash = byPath(".claude/hooks/guard-bash.sh")!.content;
    expect(guardBash).toMatch(/^RUNNERS=.*pnpm/m);
    expect(guardBash).toMatch(/^JS_PMS=.*pnpm/m);
    expect(guardBash.replace(/^(RUNNERS|JS_PMS|FROZEN_OK)=.*$/gm, "")).not.toContain("pnpm");
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
    expect(s.hooks.PreToolUse[0].hooks[0].command).toBe('"$CLAUDE_PROJECT_DIR"/.claude/hooks/guard-bash.sh');
    const readGuard = s.hooks.PreToolUse.find((e: { matcher: string }) => e.matcher === "Read|Grep");
    expect(readGuard.hooks[0].command).toBe('"$CLAUDE_PROJECT_DIR"/.claude/hooks/guard-file.sh');
    const commands = JSON.stringify(s.hooks).match(/"command":"[^"\\]*(\\"[^"\\]*)*"/g) ?? [];
    expect(commands.length).toBeGreaterThan(0);
    for (const c of commands) expect(c).toContain('\\"$CLAUDE_PROJECT_DIR\\"/'); // a space in the path cannot split it
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

  it("spec-reviewer recomputes every example from the contract, literally", () => {
    // A spec said greet() returns 'Hello, !' while its contract gave `Hello, ${name}!` with no default; in JS
    // that is 'Hello, undefined!'. The spec was consistent with itself, so only recomputing catches it.
    const rubric = byPath(".claude/agents/spec-reviewer.md")!.content;
    expect(rubric).toContain("**Examples hold.**");
    expect(rubric).toMatch(/recompute every example/i);
  });

  it("v04 AC-75: ships the drive skill for the operator chat with each instruction the spec lists", () => {
    const f = byPath(".claude/skills/drive/SKILL.md");
    expect(f).toBeDefined();
    expect(f!.content).toMatch(/^---\ndescription: /);
    const t = f!.content.replace(/\s+/g, " ");
    expect(t).toContain("in the background");
    expect(t).toContain("--status --json");
    expect(t).toContain("--resume <id> --answer");
    expect(t).toContain('Enter (accept the default) is `--answer ""`');
    expect(t).toContain("say which key you sent");
    expect(t).toContain("Do no step's work yourself");
    expect(t).toContain("Do not run `agent-stack update`");
    expect(t).toContain("Never merge, push or open a pull request yourself");
    expect(t).toContain("Follow the command's output with the Monitor tool");
    expect(t).toContain("A later fix is a new run");
    expect(t).toContain("not translated");
    expect(t).toContain("language.chat");
    expect(t).toMatch(/report in the chat language: what was done, the commits .* the cost from the run/);
  });

  it("0.4.3: the spec template asks for constraints, and grill and spec-reviewer ask about attacks and limits", () => {
    const template = byPath(".claude/skills/spec/template.md")!.content;
    expect(template).toContain("## Constraints");
    expect(template.indexOf("## Constraints")).toBeLessThan(template.indexOf("## Acceptance criteria"));
    for (const line of ["**Must not:**", "**Must keep:**", "**When goals conflict:**"]) expect(template).toContain(line);
    expect(byPath(".claude/skills/spec/light-template.md")!.content).toContain("**Must not:**");
    expect(byPath(".claude/skills/spec/SKILL.md")!.content).toMatch(/\*\*Constraints\*\* — fill `## Constraints`/);
    const grill = byPath(".claude/skills/grill/SKILL.md")!.content.replace(/\s+/g, " ");
    expect(grill).toContain("injection (SQL, shell), path traversal");
    expect(grill).toContain("fill the spec's `## Constraints`");
    const rubric = byPath(".claude/agents/spec-reviewer.md")!.content.replace(/\s+/g, " ");
    expect(rubric).toContain("Contract, Constraints, Acceptance criteria");
    expect(rubric).toContain("Constraints are checkable");
    expect(rubric).toContain("secrets in logs and error messages");
  });

  it("ships the spec-driven skills with their templates", () => {
    for (const skill of ["grill", "adr", "spec", "plan"]) {
      const f = byPath(`.claude/skills/${skill}/SKILL.md`);
      expect(f, skill).toBeDefined();
      expect(f!.content).toMatch(/^---\ndescription: /);
    }
    expect(byPath(".claude/skills/spec/template.md")!.content).toContain("IF <invalid input");
    expect(byPath(".claude/skills/adr/template.md")!.content).toContain("Alternatives considered");
    expect(byPath(".claude/skills/spec/light-template.md")!.content).toContain("light: true");
    expect(byPath(".claude/skills/adr/template.md")!.content).toContain("**Applies to:**");
    // The EARS pattern table is reference for the writer, so it lives in the skill: a spec copied from the
    // template does not carry it (seen in two real runs).
    expect(byPath(".claude/skills/spec/template.md")!.content).not.toContain("| Pattern | Form |");
    expect(byPath(".claude/skills/spec/SKILL.md")!.content).toContain("| Pattern | Form |");
    const codemap = byPath("CODEMAP.md")!.content;
    expect(codemap).toContain("## Specs");
    expect(codemap).toContain("docs/specs/");
    expect(codemap).not.toContain("`src/`");
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
