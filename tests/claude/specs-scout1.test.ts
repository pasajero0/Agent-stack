import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string): string => readFileSync(resolve(__dirname, "../..", p), "utf8");

/** A section from its heading to the next heading of the same or a higher level. */
const section = (text: string, heading: string): string => {
  const start = text.indexOf(`\n${heading}`);
  expect(start, heading).toBeGreaterThan(-1);
  const level = heading.indexOf(" ");
  const rest = text.slice(start + 1 + heading.length);
  const end = rest.search(new RegExp(`\\n#{1,${level}} `));
  return rest.slice(0, end === -1 ? undefined : end);
};

describe("specs and changelog edited by scout1", () => {
  it("scout1 AC-25: the 0.4.8 entry holds scout.md and version 2", () => {
    const entry = section(read("CHANGELOG.md"), "## 0.4.8");
    expect(entry).toContain("scout.md");
    expect(entry).toContain("version 2");
  });

  it("scout1 AC-25: its Upgrading from 0.4.7 part holds routing.scout", () => {
    const entry = section(read("CHANGELOG.md"), "## 0.4.8");
    expect(section(entry, "### Upgrading from 0.4.7")).toContain("routing.scout");
  });

  it("scout1 AC-26: v04, effort1 and stats1 each have a Changes entry naming scout1", () => {
    for (const p of ["v04", "effort1", "stats1"]) {
      const entry = section(read(`docs/specs/${p}/SPEC.md`), "## Changes");
      expect(entry, p).toMatch(/^- \d{4}-\d{2}-\d{2} — .*scout1/ms);
      expect(entry, p).toMatch(/Why:/);
    }
  });
});
