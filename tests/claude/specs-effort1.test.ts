import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const read = (p: string): string => readFileSync(resolve(__dirname, "../..", p), "utf8");
const v04 = read("docs/specs/v04/SPEC.md");
const evals1 = read("docs/specs/evals1/SPEC.md");
const glossary = read("docs/GLOSSARY.md");

/** The `## Changes` section, up to the next `## ` heading. */
const changes = (spec: string): string => section(spec, "## Changes");
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
/** A list item of a glossary-style list: `- **<name>**` up to the next top-level item. */
const item = (text: string, name: string): string => {
  const start = text.indexOf(`- **${name}`);
  expect(start, name).toBeGreaterThan(-1);
  const rest = text.slice(start + 3);
  const end = rest.search(/\n- \*\*|\n#{2,3} /);
  return rest.slice(0, end === -1 ? undefined : end);
};
const row = (spec: string, prefix: string): string => {
  const line = spec.split("\n").find((l) => l.startsWith(prefix));
  expect(line, prefix).toBeDefined();
  return line ?? "";
};

describe("specs edited by effort1", () => {
  it("effort1 AC-27: both specs have a dated Changes entry naming effort1", () => {
    for (const spec of [v04, evals1]) {
      const entry = changes(spec);
      expect(entry).toMatch(/^- \d{4}-\d{2}-\d{2} — .*/m);
      expect(entry).toMatch(/effort1/);
      expect(entry).toMatch(/Why:/);
    }
    expect(changes(evals1)).not.toMatch(/None: this is the first version/);
  });

  it("effort1 AC-27: v04 AC-13 and AC-16 take the route from effort1", () => {
    for (const id of ["AC-13", "AC-16"]) {
      const text = criterion(v04, id);
      expect(text, id).toMatch(/effort1( chooses)? \(AC-2 to\s+AC-5\)/);
      expect(text, id).not.toMatch(/on Opus|be Sonnet/);
    }
    expect(criterion(v04, "AC-16")).toMatch(/retry route/);
    expect(criterion(v04, "AC-13")).toMatch(/risky route/);
  });

  it("effort1 AC-27: v04 AC-12 and AC-68 use effort1's card line and the card source holds the routes", () => {
    const ac12 = criterion(v04, "AC-12");
    expect(ac12).toMatch(/card line of\s+effort1 \(AC-8\)/);
    expect(ac12).toMatch(/routes \(effort1 AC-21\)/);
    const ac68 = criterion(v04, "AC-68");
    expect(ac68).toMatch(/card line of effort1 \(AC-8\)/);
    expect(ac68).toMatch(/<tier> · <complexity> -> <model> · <effort>/);
    expect(ac68).not.toMatch(/<tier> · <model>\[/);
  });

  it("effort1 AC-27: v04 AC-17 says a retry runs on the retry route", () => {
    expect(criterion(v04, "AC-17")).toMatch(/under the driver, a retry runs on the retry route/);
    expect(criterion(v04, "AC-17")).not.toMatch(/on Opus/);
  });

  it("effort1 AC-27: v04 has no 'on Opus' left in AC-31, AC-60, AC-66 and the gate:limit row", () => {
    for (const id of ["AC-31", "AC-60", "AC-66"]) {
      expect(criterion(v04, id), id).not.toMatch(/on Opus/);
      expect(criterion(v04, id), id).toMatch(/on the retry route/);
    }
    const limit = row(v04, "| gate:limit | retry");
    expect(limit).not.toMatch(/on Opus/);
    expect(limit).toMatch(/on the retry route/);
  });

  it("effort1 AC-27: v04 AC-78 and AC-79 name effort1's implement head line", () => {
    for (const id of ["AC-78", "AC-79"]) {
      expect(criterion(v04, id), id).toMatch(/head line of an implement call is effort1's \(AC-7\)/);
    }
  });

  it("effort1 AC-27: v04 Decisions 'Models' follow routing", () => {
    const models = item(section(v04, "## Decisions"), "Models:");
    expect(models).toMatch(/implementation follows routing \(effort1\)/);
    expect(models).not.toMatch(/(risky task|retry) runs on Opus|follows the task tier/);
    expect(models).toMatch(/judgment roles run on Opus/);
  });

  it("effort1 AC-27: v04 Terms 'Valid plan' needs complexity and an L task's splitReason", () => {
    const valid = item(section(v04, "## Terms"), "Valid plan");
    expect(valid).toMatch(/`complexity`/);
    expect(valid).toMatch(/L task, a non-empty `splitReason`/);
    expect(valid).toMatch(/effort1 AC-6, AC-14/);
  });

  it("effort1 AC-27: v04 Contract names --effort, the new card line and source, --cell and the run file cell", () => {
    const contract = section(v04, "## Contract");
    expect(contract).toMatch(/--model <model> \[--effort <effort>\]/);
    expect(contract).toMatch(/`--effort <effort>` follows `--model` for implement\s+and scout only/);
    expect(contract).toMatch(/"T1 {2}S · low -> sonnet · low · AC-/);
    expect(contract).toMatch(/"source": "sha256 of tasks\.json and the 11 route values/);
    expect(contract).toMatch(/the 11 route values of `routing` \(effort1 AC-21\)/);
    expect(contract).toMatch(/run quick \[--cell <tier>·<complexity>\]/);
    expect(contract).toMatch(/effort1 \(AC-28, AC-30\)/);
    expect(row(contract, "| `cell` |")).toMatch(/effort1 AC-28, AC-31/);
  });

  it("effort1 AC-27: evals1 AC-18 and AC-24 count every eval task, 5 + 2", () => {
    expect(criterion(evals1, "AC-18")).toMatch(/each eval task in `evals\/tasks\/` \(the 5 of AC-24 and the 2 of effort1 AC-25\)/);
    expect(criterion(evals1, "AC-18")).not.toMatch(/each of the 5 eval tasks/);
    expect(criterion(evals1, "AC-24")).toMatch(/the 2 of effort1 AC-25: 7 in all/);
    expect(criterion(evals1, "AC-24")).not.toMatch(/these 5 eval tasks/);
  });

  it("effort1 AC-27: evals1 task.json table, start row and AC-4 name the cell and --cell", () => {
    const field = row(evals1, "| `cell` |");
    expect(field).toMatch(/optional/);
    expect(field).toMatch(/run quick --cell <cell> <description>/);
    expect(row(evals1, "| start |")).toMatch(/--cell <cell>/);
    expect(criterion(evals1, "AC-4")).toMatch(/run quick --cell <cell> <description>/);
    expect(criterion(evals1, "AC-4")).toMatch(/effort1 AC-29/);
  });

  it("effort1 AC-27: evals1 AC-8 excludes answers and cell from the required fields", () => {
    expect(criterion(evals1, "AC-8")).toMatch(/\(all but `answers` and `cell`\)/);
  });

  it("effort1 AC-27: evals1 NFR says 7 × 3 = 21 tries, about $2.10", () => {
    const nfr = evals1.slice(evals1.indexOf("\n## Non-functional"));
    expect(nfr).toMatch(/7\s+eval tasks with k = 3 is 7 × 3 = 21 tries, about \$2\.10/);
  });

  it("effort1 AC-27: the glossary entry Eval task names the routing cell", () => {
    expect(item(glossary, "Eval task")).toMatch(/routing\s+cell/);
  });
});
