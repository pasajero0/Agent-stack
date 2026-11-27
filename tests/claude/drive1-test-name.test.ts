import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const T = join(__dirname, "..", "..", "templates", "claude");
const read = (p: string): string => readFileSync(join(T, p), "utf-8");
const flat = (s: string): string => s.replace(/\s+/g, " ");

describe("drive1 test-name rule", () => {
  it("drive1 AC-3: implementer rule 1 holds both forms and the two phrases", () => {
    const t = flat(read("agents/implementer.md"));
    expect(t).toContain('it("A0 AC-3: counts duplicates")');
    expect(t).toContain("def test_A0_AC_3_counts_duplicates()");
    expect(t).toContain("Read the existing tests in the same folder first");
    expect(t).toContain("Write unhappy-path criteria as tests too");
  });

  it("drive1 AC-3: /plan names implementer.md and gives no example of its own", () => {
    const t = flat(read("skills/plan/SKILL.md"));
    expect(t).toContain(".claude/agents/implementer.md");
    expect(t).not.toContain("counts_duplicates");
    expect(t).not.toContain("counts duplicates");
    expect(t).not.toContain("test-writer");
  });

  it("drive1 AC-3: test-writer no longer holds the test-name rule", () => {
    const t = read("agents/test-writer.md");
    expect(t).not.toContain("counts duplicates");
    expect(t).not.toContain("counts_duplicates");
  });
});
