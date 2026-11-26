import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const read = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), "utf8");

/** From the heading line to the next `## ` heading. */
function section(text: string, heading: string): string {
  const lines = text.split("\n");
  const start = lines.indexOf(heading);
  if (start < 0) return "";
  const rest = lines.slice(start + 1);
  const next = rest.findIndex((l) => l.startsWith("## "));
  return (next < 0 ? rest : rest.slice(0, next)).join("\n");
}

/** Top-level bullets of a section, each joined with its wrapped lines. */
function bullets(s: string): string[] {
  const out: string[] = [];
  for (const line of s.split("\n")) {
    if (line.startsWith("- ")) out.push(line);
    else if (line.startsWith("  ") && out.length > 0) out[out.length - 1] += ` ${line.trim()}`;
  }
  return out;
}

/** The paragraph before the first bullet, joined into one line. */
function intro(s: string): string {
  const lines = s.split("\n");
  const end = lines.findIndex((l) => l.startsWith("- "));
  return (end < 0 ? lines : lines.slice(0, end)).join(" ");
}

describe("causes1 docs", () => {
  it("causes1 AC-13: ci runs pnpm defects --check right after pnpm test:fast", () => {
    const lines = read(".github/workflows/ci.yml")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("#"));
    const i = lines.indexOf("- run: pnpm test:fast");
    expect(i).toBeGreaterThan(-1);
    expect(lines[i + 1]).toBe("- run: pnpm defects --check");
  });

  it("causes1 AC-19: CONTRIBUTING Defects links the rule and does not repeat it", () => {
    const s = section(read("CONTRIBUTING.md"), "## Defects");
    expect(s).not.toBe("");
    for (const w of ["Cause", "GLOSSARY.md", "pnpm defects"]) expect(s).toContain(w);
    for (const w of ["A class that repeats", "2 rows", "3 rows", "planned:"]) expect(s).not.toContain(w);
  });

  it("causes1 AC-19: the intro lists its cause, and one bullet names the cause, the link and pnpm defects", () => {
    const s = section(read("CONTRIBUTING.md"), "## Defects");
    expect(intro(s)).toContain("its class, its cause,");
    const all = bullets(s);
    expect(all.some((b) => b.startsWith("- **Classes:**"))).toBe(true);
    const cause = all.filter((b) => b.includes("names its cause"));
    expect(cause).toHaveLength(1);
    const b = cause[0] ?? "";
    expect(b).toMatch(/every row names its cause/i);
    expect(b).toMatch(/\[[^\]]*GLOSSARY\.md[^\]]*Cause[^\]]*\]\(docs\/GLOSSARY\.md[^)]*\)/);
    expect(b).toContain("`pnpm defects` counts the rows by cause");
  });

  it("causes1 AC-20: GLOSSARY Ideas has the Cause entry with the whole rule", () => {
    const ideas = section(read("docs/GLOSSARY.md"), "## Ideas");
    const entry = bullets(ideas).filter((b) => b.startsWith("- **Cause** —"));
    expect(entry).toHaveLength(1);
    const e = entry[0] ?? "";
    for (const w of ["2 rows", "3 rows", "planned: <version>", "pnpm defects --check"]) expect(e).toContain(w);
  });

  it("causes1 AC-21: CHANGELOG 0.5.2 names the Cause column, pnpm defects and --check in one bullet", () => {
    const e = section(read("CHANGELOG.md"), "## 0.5.2 — unreleased");
    expect(e).not.toBe("");
    const hit = bullets(e).filter((b) => b.includes("`Cause` column") && b.includes("pnpm defects"));
    expect(hit).toHaveLength(1);
    const b = hit[0] ?? "";
    expect(b).toContain("pnpm defects --check");
    expect(b).toContain("CI");
  });
});
