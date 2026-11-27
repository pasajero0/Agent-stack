import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");
const glossary = readFileSync(new URL("../../docs/GLOSSARY.md", import.meta.url), "utf8");

/** A `## ` section of a Markdown text: from its heading to the next `## ` heading. */
function section(text: string, heading: string): string {
  const start = text.indexOf(heading);
  if (start < 0) return "";
  const rest = text.slice(start + 3);
  const next = rest.indexOf("\n## ");
  return next < 0 ? rest : rest.slice(0, next);
}

describe("Q1: probe in the glossary and the README", () => {
  it("Q1: the glossary has the Probe entry in Harness parts", () => {
    expect(section(glossary, "## Harness parts")).toContain("- **Probe** —");
  });

  it("Q1: README no longer says the write-deny rule is not yet checked by a live probe", () => {
    expect(readme).not.toContain("not yet checked by a live probe");
  });
});
