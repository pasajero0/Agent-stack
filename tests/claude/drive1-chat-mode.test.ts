import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const T = join(__dirname, "..", "..", "templates", "claude");
const read = (p: string): string => readFileSync(join(T, p), "utf-8");
const flat = (s: string): string => s.replace(/\s+/g, " ");
const harnessSrc = readFileSync(join(__dirname, "..", "..", "src", "claude", "harness.ts"), "utf-8");

describe("drive1 chat mode removed", () => {
  it("drive1 AC-13: implementer.md has no chat section and no STATUS line, and keeps rules and the driver section", () => {
    const t = read("agents/implementer.md");
    expect(t).not.toContain("## In a chat");
    expect(t).not.toContain("STATUS:");
    expect(t).toContain("## Rules");
    expect(t).toContain("## Under the driver");
    const description = /^description: (.*)$/m.exec(t)![1]!;
    expect(description).toContain("driver");
    expect(description).toContain("/drive");
    expect(description).not.toContain("by hand");
  });

  it("drive1 AC-13: _normative.md has no Report contract and no 'by hand' with the implementer", () => {
    const t = flat(read("_normative.md"));
    expect(t).not.toContain("## Report contract");
    expect(t).not.toMatch(/by hand, (spawn|use)/i);
  });

  it("drive1 AC-13: the /plan skill ends with one sentence for a chat and has no 'by hand' routing", () => {
    const t = read("skills/plan/SKILL.md");
    const then = /^## Then\n([\s\S]*)$/m.exec(t)![1]!;
    expect(then).not.toContain("By hand");
    expect(then).not.toContain("Report with the contract");
    expect(flat(then)).toContain("A chat runs the code with `/drive`.");
    expect(flat(t)).not.toMatch(/by hand, (spawn|use)/i);
  });

  it("drive1 AC-13: the Subagent delegation text and the verify hint have no 'by hand'", () => {
    const line = harnessSrc.split("\n").find((l) => l.includes("**implementer**"))!;
    expect(line).toBeDefined();
    expect(line).not.toContain("by hand");
    expect(line).toContain("/drive");
    expect(read("bin/verify")).not.toContain("by hand");
  });
});
