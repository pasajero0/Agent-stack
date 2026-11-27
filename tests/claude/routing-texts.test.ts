import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { buildHarnessFiles } from "../../src/claude/harness.js";
import { TS_PARAMS } from "../hooks/fixture.js";

// effort1 AC-22, AC-23: the model and effort of a task live in one place, `.claude/gates.json → routing`
// (default: templates/claude/_routing.json). The texts point to it and name no model per tier.

const ROOT = join(__dirname, "..", "..");
const T = join(ROOT, "templates", "claude");
const read = (p: string): string => readFileSync(p, "utf-8");

const filesUnder = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? filesUnder(p) : [p];
  });

const planSkill = (): string => read(join(T, "skills", "plan", "SKILL.md"));
const normative = (): string => read(join(T, "_normative.md"));

const glossaryTier = (): string => {
  const g = read(join(ROOT, "docs", "GLOSSARY.md"));
  const m = /^- \*\*Tier\*\*[\s\S]*?(?=^- \*\*|^#|(?![\s\S]))/m.exec(g);
  expect(m, "glossary entry Tier").not.toBeNull();
  return m![0];
};

const implementerDescription = (): string => {
  const m = /^description: (.*)$/m.exec(read(join(T, "agents", "implementer.md")));
  expect(m, "implementer description").not.toBeNull();
  return m![1]!;
};

const verifyHint = (): string => {
  const line = read(join(T, "bin", "verify"))
    .split("\n")
    .find((l) => l.includes("failed twice"));
  expect(line, "verify escalation hint").toBeDefined();
  return line!.replace(/\\`/g, "`"); // as bash prints it

};

const NEGATIVE = [
  /S\/M → sonnet/,
  /L → opus/,
  /low effort/,
  /retry runs on Opus/,
  /model (per|by) tier/,
  /tier[^|\n]*\|[^|\n]*\| *.?(sonnet|opus)/,
];

describe("routing texts", () => {
  it("effort1 AC-22: no file under src/ holds a route value", () => {
    for (const f of filesUnder(join(ROOT, "src"))) {
      expect(read(f), f).not.toMatch(/(opus|sonnet|haiku)·/);
    }
  });

  it("effort1 AC-22: the /plan skill, the glossary entry Tier and _normative.md point to routing", () => {
    for (const [name, text] of [
      ["plan skill", planSkill()],
      ["glossary Tier", glossaryTier()],
      ["_normative.md", normative()],
    ] as const) {
      expect(text, name).toContain("routing");
    }
  });

  it("effort1 AC-22: the /plan skill and the glossary entry Tier name no model", () => {
    for (const [name, text] of [
      ["plan skill", planSkill()],
      ["glossary Tier", glossaryTier()],
    ] as const) {
      expect(text, name).not.toMatch(/\b(opus|sonnet|haiku)\b/i);
      expect(text, name).not.toMatch(/model (per|by) tier/i);
    }
  });

  it("effort1 AC-22: _normative.md, the implementer description and the verify hint name no model per tier", () => {
    for (const [name, text] of [
      ["_normative.md", normative()],
      ["implementer description", implementerDescription()],
      ["verify hint", verifyHint()],
    ] as const) {
      for (const re of NEGATIVE) expect(text, `${name} ${re}`).not.toMatch(re);
    }
  });

  it("effort1 AC-22: the escalation uses the model of routing.retry", () => {
    expect(verifyHint()).toContain("a retry runs on the model of `routing.retry`");
    expect(planSkill().replace(/\s+/g, " ")).toContain("use the model of `routing.retry`");
    expect(implementerDescription()).toContain(".claude/gates.json → routing");
  });

  it("effort1 AC-22: the generated CLAUDE.md line on the implementer points to routing", () => {
    const claude = buildHarnessFiles(TS_PARAMS).find((f) => f.path === "CLAUDE.md")!.content;
    const line = claude.split("\n").find((l) => l.includes("**implementer**"));
    expect(line).toBeDefined();
    expect(line!.replace(/\*\*/g, "")).toContain(
      "implementer — the driver runs it, and .claude/gates.json → routing picks its model and effort; " +
        "a chat runs the work with /drive.",
    );
    expect(claude).not.toMatch(/model (per|by) tier/);
  });

  it("effort1 AC-22: the /drive skill shows the route in the start line", () => {
    const drive = read(join(T, "skills", "drive", "SKILL.md"));
    expect(drive).toContain('"implement:T1 started (sonnet · low)"');
    expect(drive).toContain("its route");
    expect(drive).not.toContain("its model");
  });

  it("effort1 AC-23: the /plan skill has a Complexity section with the four questions, the rule and splitReason", () => {
    const skill = planSkill();
    const m = /^## Complexity\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(skill);
    expect(m, "## Complexity section").not.toBeNull();
    const section = m![1]!;
    const flat = section.replace(/\s+/g, " ");
    const questions = [
      "Is there a pattern in the code to copy? (towards low)",
      "Is there more than one reasonable solution? (at least medium)",
      "Does the spec leave a decision open, or is the logic not obvious: edge cases, order, state? (at least medium)",
      "Does it touch security, money, data or concurrency? (high)",
    ];
    questions.forEach((q, i) => expect(flat).toContain(`${i + 1}. ${q}`));
    expect(section.match(/^\d+\. /gm)).toHaveLength(4);
    expect(flat).toMatch(/high when question 4 is yes/i);
    expect(flat).toMatch(/medium when question 2 or 3 is yes, or question 1 is no/i);
    expect(flat).toMatch(/else low/i);
    expect(section).toContain("splitReason");
    expect(flat).toMatch(/expand-contract/);
    expect(flat).toMatch(/atomic/);
    expect(flat).toMatch(/purely mechanical/);
  });

  it("effort1 AC-23: the tasks.json example shows complexity in every task and one L task with splitReason", () => {
    const m = /```json\n([\s\S]*?)```/.exec(planSkill());
    expect(m, "tasks.json example").not.toBeNull();
    const example = JSON.parse(m![1]!) as {
      tasks: { tier: string; complexity?: string; splitReason?: string }[];
    };
    expect(example.tasks.length).toBeGreaterThanOrEqual(2);
    for (const t of example.tasks) expect(["low", "medium", "high"]).toContain(t.complexity);
    const l = example.tasks.filter((t) => t.tier === "L");
    expect(l).toHaveLength(1);
    expect(l[0]!.splitReason?.trim()).toBeTruthy();
    for (const t of example.tasks.filter((x) => x.tier !== "L")) expect(t.splitReason).toBeUndefined();
  });
});
