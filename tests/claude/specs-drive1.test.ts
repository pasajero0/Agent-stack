import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string): string => readFileSync(resolve(__dirname, "../..", p), "utf8");
const v04 = read("docs/specs/v04/SPEC.md");

/** A section from its heading to the next heading of the same or a higher level. */
const section = (spec: string, heading: string): string => {
  const start = spec.indexOf(`\n${heading}`);
  expect(start, heading).toBeGreaterThan(-1);
  const level = heading.indexOf(" ");
  const rest = spec.slice(start + 1 + heading.length);
  const end = rest.search(new RegExp(`\\n#{1,${level}} `));
  return rest.slice(0, end === -1 ? undefined : end);
};
/** The line of a criterion, with its continuation lines, up to the next criterion or heading. */
const criterion = (spec: string, id: string): string => {
  const start = spec.indexOf(`- **${id}:**`);
  expect(start, id).toBeGreaterThan(-1);
  const rest = spec.slice(start + 3);
  const end = rest.search(/\n- \*\*AC-\d+:\*\*|\n#{2,3} /);
  return rest.slice(0, end === -1 ? undefined : end);
};
/** A top-level list item `- **<name>` up to the next top-level item or heading. */
const item = (text: string, name: string): string => {
  const start = text.indexOf(`- **${name}`);
  expect(start, name).toBeGreaterThan(-1);
  const rest = text.slice(start + 3);
  const end = rest.search(/\n- \*\*|\n#{2,3} /);
  return rest.slice(0, end === -1 ? undefined : end);
};
/** The Contract paragraph under a bold title, up to the next bold title or heading. */
const paragraph = (text: string, title: string): string => {
  const start = text.indexOf(`**${title}**`);
  expect(start, title).toBeGreaterThan(-1);
  const rest = text.slice(start + title.length + 4);
  const end = rest.search(/\n\*\*|\n#{2,3} /);
  return rest.slice(0, end === -1 ? undefined : end);
};

describe("v04 edited by drive1", () => {
  it("drive1 AC-29: v04 has a Changes entry dated 2026-11-27 naming drive1, with a Why", () => {
    const line = section(v04, "## Changes")
      .split("\n- ").find((e) => e.includes("2026-11-27") && e.includes("drive1"));
    expect(line).toBeDefined();
    expect(line).toMatch(/Why:/);
    expect(line).toMatch(/AC-18/);
    expect(line).toMatch(/AC-67/);
    expect(line).toMatch(/AC-71/);
  });

  it("drive1 AC-29: AC-18 is deleted from v04", () => {
    expect(v04).not.toMatch(/- \*\*AC-18:\*\*/);
  });

  it("drive1 AC-29: the first sub-bullet of AC-67 gives the implementer one mode section, 'Under the driver'", () => {
    const ac67 = criterion(v04, "AC-67");
    const first = ac67.split("\n  - ")[1] ?? "";
    expect(first).toMatch(/one mode section, "Under the driver"/);
    expect(ac67).not.toMatch(/"In a chat"/);
    expect(ac67).not.toMatch(/two sections/);
  });

  it("drive1 AC-29: AC-71 reads a missing key as driver, names anyone as the emergency exit, and generate writes the key", () => {
    const ac71 = criterion(v04, "AC-71");
    expect(ac71).toMatch(/key missing, spec-gate acts as for `"driver"`/);
    expect(ac71).toMatch(/`"anyone"`, the emergency exit/);
    expect(ac71).toMatch(/refusal line names `"anyone"`/);
    expect(ac71).toMatch(/`generate` writes the key/);
    expect(ac71).not.toMatch(/key missing or `"anyone"`/);
  });

  it("drive1 AC-29: the Contract codeBy paragraph makes driver the default", () => {
    const codeBy = paragraph(section(v04, "## Contract"), "`.claude/gates.json` → `codeBy`");
    expect(codeBy).toMatch(/`"driver"` is the default/);
    expect(codeBy).toMatch(/missing key, `null` or `""` reads as `"driver"`/);
    expect(codeBy).toMatch(/`"anyone"` is the emergency exit/);
    expect(codeBy).toMatch(/refusal line names it/);
    expect(codeBy).toMatch(/`generate` writes\s+`"codeBy": "driver"`/);
    expect(codeBy).not.toMatch(/the default when the key is missing/);
  });

  it("drive1 AC-29: the Decisions sentence says codeBy driver is the default, not opt-in", () => {
    const chat = item(section(v04, "## Decisions"), "The driver from a chat");
    expect(chat).toMatch(/`codeBy: "driver"` is the default/);
    expect(chat).not.toMatch(/opt-in/);
  });

  it("drive1 AC-29: the other v04 mentions of AC-18 and evidence-gate stay", () => {
    expect(v04).toMatch(/cheat-guard, evidence-gate, guard-bash/);
    expect(v04).toMatch(/The three bypasses \(AC-18,/);
    expect(v04).toMatch(/hook tests for AC-18, AC-26/);
  });
});
