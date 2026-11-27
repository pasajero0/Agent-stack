import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// drive1 AC-1, AC-2: `## Spec-driven workflow` in _normative.md is the pipeline section of the Contract, and
// `## Multi-step migrations` is one line that points to the migration skill.

const T = join(__dirname, "..", "..", "templates", "claude");
const read = (p: string): string => readFileSync(p, "utf-8");
const normative = (): string => read(join(T, "_normative.md"));
const migrationSkill = (): string => read(join(T, "skills", "migration", "SKILL.md"));
const flat = (s: string): string => s.replace(/\s+/g, " ");

const section = (text: string, heading: string): string => {
  const start = text.indexOf(`${heading}\n`);
  expect(start, heading).toBeGreaterThanOrEqual(0);
  const rest = text.slice(start + heading.length + 1);
  const next = rest.search(/^## /m);
  return next < 0 ? rest : rest.slice(0, next);
};

const STEP_FILES: readonly (readonly [string, string])[] = [
  ["questions (grill, clarify)", "`.claude/skills/grill/SKILL.md`"],
  ["spec", "`.claude/skills/spec/SKILL.md`, `.claude/agents/spec-reviewer.md`"],
  ["plan", "`.claude/skills/plan/SKILL.md`"],
  ["implement", "`.claude/agents/implementer.md`"],
  ["checks", "`.claude/bin/verify`, `.claude/bin/trace`, `.claude/bin/health`"],
  ["review", "`.claude/agents/code-reviewer.md`"],
];

describe("drive1 pipeline section", () => {
  it("drive1 AC-1: the pipeline section says the driver runs the steps and spec-gate refuses a chat's code edit", () => {
    const s = flat(section(normative(), "## Spec-driven workflow"));
    expect(s).toContain("`agent-stack run`");
    expect(s).toContain("`/drive`");
    expect(s).toMatch(/the driver runs (the|these|its) steps/i);
    expect(s).toMatch(/spec-gate refuses a chat's code edit/);
    expect(s).toContain("`codeBy`");
  });

  it("drive1 AC-1: the pipeline section has a table that names the file of each step", () => {
    const s = section(normative(), "## Spec-driven workflow");
    expect(s).toContain("| Step | Rules in |");
    for (const [step, files] of STEP_FILES) expect(s).toContain(`| ${step} | ${files} |`);
    const rows = s.split("\n").filter((l) => /^\| /.test(l) && !/^\| (Step|---) /.test(l));
    expect(rows).toHaveLength(STEP_FILES.length);
  });

  it("drive1 AC-1: the pipeline section gives no rule of a step", () => {
    const s = section(normative(), "## Spec-driven workflow");
    for (const word of ["test-writer", "evidence-gate", "STATUS", "AC-n:", "Tests first"]) {
      expect(s, word).not.toContain(word);
    }
  });

  it("drive1 AC-1: the Drift paragraph stays after the table", () => {
    const s = section(normative(), "## Spec-driven workflow");
    const drift = s.indexOf("**Drift, measured like a service.**");
    expect(drift).toBeGreaterThan(s.lastIndexOf("| review |"));
    expect(flat(s)).toContain(
      "**Drift, measured like a service.** `.claude/bin/health` measures what the branch changed (file size, new " +
        "dependencies, project metrics such as complexity) against SLOs in `.claude/gates.json` and appends each run " +
        "to `.claude/tmp/health.jsonl`. arch-guard blocks new imports across layer boundaries. A broken SLO or " +
        "boundary is fixed — or justified in an ADR, after which the human raises the limit.",
    );
  });

  it("drive1 AC-2: Multi-step migrations is the one line of the Contract", () => {
    const s = section(normative(), "## Multi-step migrations").trim();
    expect(s).toBe(
      "Before a multi-file migration or refactor, follow the migration skill (.claude/skills/migration/SKILL.md).",
    );
  });

  it("drive1 AC-2: step 2 of the migration skill gains the autonomous-mode sentence", () => {
    const skill = migrationSkill();
    const step2 = /^2\. [\s\S]*?(?=^3\. )/m.exec(skill);
    expect(step2, "step 2").not.toBeNull();
    expect(flat(step2![0])).toContain(
      "In autonomous mode, put the plan check in the commit body instead of waiting, and list deviations under " +
        "NEEDS HUMAN DECISION.",
    );
  });

  it("drive1 AC-2: ОТКЛОНЕНИЕ ОТ ПЛАНА and Plan check: appear in the skill and not in _normative.md", () => {
    for (const word of ["ОТКЛОНЕНИЕ ОТ ПЛАНА", "Plan check:"]) {
      expect(migrationSkill(), word).toContain(word);
      expect(normative(), word).not.toContain(word);
    }
  });
});
