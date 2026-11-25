import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const changelog = readFileSync(new URL("../../CHANGELOG.md", import.meta.url), "utf8");
const defects = readFileSync(new URL("../../docs/defects.md", import.meta.url), "utf8");

/** The 0.4.8 entry: from its heading to the next `## ` heading. */
function entry(): string {
  const start = changelog.indexOf("## 0.4.8");
  if (start < 0) return "";
  const rest = changelog.slice(start + 3);
  const next = rest.indexOf("\n## ");
  return next < 0 ? rest : rest.slice(0, next);
}

describe("effort1 AC-26: CHANGELOG 0.4.8 and defect #41", () => {
  it("effort1 AC-26: has a 0.4.8 entry with '### Upgrading from 0.4.7'", () => {
    const e = entry();
    expect(e).not.toBe("");
    expect(e).toContain("### Upgrading from 0.4.7");
  });

  it("effort1 AC-26: says to run agent-stack update for the routing block", () => {
    const up = entry().split("### Upgrading from 0.4.7")[1] ?? "";
    expect(up).toContain("agent-stack update");
    expect(up).toContain("routing");
    expect(up).toContain("gates.json");
  });

  it("effort1 AC-26: says a written plan stops with AC-15 (complexity, splitReason)", () => {
    const up = entry().split("### Upgrading from 0.4.7")[1] ?? "";
    expect(up).toContain("AC-15");
    expect(up).toContain("complexity");
    expect(up).toContain("splitReason");
    expect(up).toContain("gate:plan-approve");
    expect(up).toMatch(/runs plan again/);
  });

  it("effort1 AC-26: says the plan-approve card line and the implement head line changed", () => {
    const up = entry().split("### Upgrading from 0.4.7")[1] ?? "";
    expect(up).toMatch(/plan-approve card line/);
    expect(up).toMatch(/implement head line/);
  });

  it("effort1 AC-26: says run quick --cell and eval task.json cell", () => {
    const up = entry().split("### Upgrading from 0.4.7")[1] ?? "";
    expect(up).toContain("run quick --cell <tier>·<complexity>");
    expect(up).toContain("M·medium");
    expect(up).toContain("task.json");
    expect(up).toContain("`cell`");
  });

  it("effort1 AC-26: defects #41 is marked fixed in 0.4.8", () => {
    const row = defects.split("\n").find((l) => l.startsWith("| 41 |")) ?? "";
    expect(row).toContain("fixed in 0.4.8");
    expect(row).not.toContain("open");
  });
});
