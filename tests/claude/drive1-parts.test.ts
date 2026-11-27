import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildHarnessFiles } from "../../src/claude/harness.js";
import { TS_PARAMS } from "../hooks/fixture.js";

const TEMPLATES = join(__dirname, "..", "..", "templates");
const files = buildHarnessFiles(TS_PARAMS);
const paths = files.map((f) => f.path);
const byPath = (p: string) => files.find((f) => f.path === p);

const walk = (dir: string): string[] =>
  readdirSync(dir).flatMap((n) => {
    const full = join(dir, n);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });

describe("drive1 generated harness", () => {
  it("drive1 AC-7: no test-name example in a templates .md file except implementer.md", () => {
    const re = /it\("[^"]*AC-[0-9]+|def test_[A-Za-z0-9_]*AC_[0-9]+/;
    const hits = walk(TEMPLATES)
      .filter((f) => f.endsWith(".md") && !f.endsWith(join("claude", "agents", "implementer.md")))
      .filter((f) => readFileSync(f, "utf-8").split("\n").some((l) => re.test(l)));
    expect(hits).toEqual([]);
  });

  it("drive1 AC-8: .claude/agents/ holds exactly the five agents", () => {
    const agents = paths.filter((p) => p.startsWith(".claude/agents/")).sort();
    expect(agents).toEqual(
      ["code-reviewer", "implementer", "pattern-scout", "researcher", "spec-reviewer"].map(
        (a) => `.claude/agents/${a}.md`
      )
    );
  });

  it("drive1 AC-8: every keep-list part is written and no removed part is", () => {
    for (const h of [
      "guard-bash", "guard-file", "spec-gate", "cheat-guard", "arch-guard",
      "session-start-context", "stop-flag-reflect", "post-edit-lint", "gates-lib",
    ]) {
      expect(byPath(`.claude/hooks/${h}.sh`), h).toBeDefined();
    }
    for (const s of ["adr", "drive", "grill", "migration", "plan", "spec"]) {
      expect(byPath(`.claude/skills/${s}/SKILL.md`), s).toBeDefined();
    }
    for (const c of ["review", "reflect"]) expect(byPath(`.claude/commands/${c}.md`), c).toBeDefined();
    for (const b of ["verify", "trace", "health"]) expect(byPath(`.claude/bin/${b}`), b).toBeDefined();
    for (const gone of [
      ".claude/hooks/evidence-gate.sh",
      ".claude/skills/ci-testing-patterns.md",
      ".claude/skills/repo-structure.md",
      ".claude/skills/team-conventions.md",
      ".claude/_TOKENS.md",
    ]) {
      expect(byPath(gone), gone).toBeUndefined();
    }
    const gates = JSON.parse(byPath(".claude/gates.json")!.content);
    expect(gates.evidenceGate).toBeUndefined();
    const stop = JSON.parse(byPath(".claude/settings.json")!.content).hooks.Stop;
    expect(stop).toHaveLength(1);
    expect(JSON.stringify(stop)).toContain("stop-flag-reflect.sh");
  });

  it("drive1 AC-8: CLAUDE.md has the sections in Contract order and no Report contract", () => {
    const claude = byPath("CLAUDE.md")!.content;
    const order = [
      "## Tooling",
      "## Subagent delegation",
      "## Explaining to the human",
      "## Spec-driven workflow",
      "## Modes",
      "## Model routing",
      "## Multi-step migrations",
      "## Scope discipline",
    ];
    const idx = order.map((h) => claude.indexOf(`${h}\n`));
    idx.forEach((i, n) => expect(i, order[n]).toBeGreaterThanOrEqual(0));
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
    expect(claude).not.toContain("## Report contract");
    expect(claude).not.toContain("test-writer");
    expect(claude).not.toContain("task-analyzer");
  });
});
