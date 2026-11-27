import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const changelog = readFileSync(new URL("../../CHANGELOG.md", import.meta.url), "utf8");

/** The 0.6.0 section: from its heading to the next `## ` heading. */
function section(): string {
  const start = changelog.indexOf("## 0.6.0 — ");
  if (start < 0) return "";
  const rest = changelog.slice(start + 3);
  const next = rest.indexOf("\n## ");
  return next < 0 ? rest : rest.slice(0, next);
}

describe("drive1 AC-32: CHANGELOG 0.6.0 section", () => {
  it("drive1 AC-32: the 0.6.0 section is the first '## ' section of the file", () => {
    const first = changelog.split("\n").find((l) => l.startsWith("## "));
    expect(first).toBeDefined();
    expect(first?.startsWith("## 0.6.0 — ")).toBe(true);
  });

  it("drive1 AC-32: the section names the break, the removed parts and the upgrade", () => {
    const s = section();
    expect(s).not.toBe("");
    for (const needle of [
      '"codeBy": "anyone"',
      "evidence-gate",
      "test-writer",
      "task-analyzer",
      "evidenceGate",
    ]) {
      expect(s).toContain(needle);
    }
  });
});

describe("drive1 AC-33: CLAUDE.md subagent delegation", () => {
  it("drive1 AC-33: 'Subagent delegation' names code-reviewer and pattern-scout, not task-analyzer or test-writer", () => {
    const claudeMd = readFileSync(new URL("../../CLAUDE.md", import.meta.url), "utf8");
    const start = claudeMd.indexOf("## Subagent delegation");
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = claudeMd.slice(start + 3);
    const next = rest.indexOf("\n## ");
    const s = next < 0 ? rest : rest.slice(0, next);
    expect(s).not.toContain("task-analyzer");
    expect(s).not.toContain("test-writer");
    expect(s).toContain("code-reviewer");
    expect(s).toContain("pattern-scout");
  });
});
