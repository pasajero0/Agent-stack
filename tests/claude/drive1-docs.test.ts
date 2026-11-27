import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
const read = (p: string): string => readFileSync(join(ROOT, p), "utf8");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** The text from the line that starts with `start` up to (not including) the next line matching `end`. */
function section(text: string, start: string, end: RegExp): string {
  const lines = text.split("\n");
  const from = lines.findIndex((l) => l.startsWith(start));
  if (from < 0) return "";
  const rest = lines.slice(from + 1);
  const to = rest.findIndex((l) => end.test(l));
  return [lines[from], ...(to < 0 ? rest : rest.slice(0, to))].join("\n");
}

/** A glossary entry: the `- **name**` line and its indented continuation lines. */
function entry(text: string, name: string): string {
  return section(text, `- **${name}**`, /^(- |\S|  - )/);
}

const RETIRED =
  /evidence-gate|evidenceGate|test-writer|task-analyzer|_TOKENS|ci-testing-patterns|repo-structure\.md|team-conventions|Report contract|STATUS: DONE/;

/** Lines of the given files that match RETIRED, minus the two exceptions of AC-27. */
function retiredHits(files: string[]): string[] {
  const hits: string[] = [];
  for (const f of files) {
    readFileSync(f, "utf8")
      .split("\n")
      .forEach((line, i) => {
        if (!RETIRED.test(line)) return;
        if (f.endsWith(join("src", "claude", "update-plan.ts")) && /^const RETIRED_HOOKS\b/.test(line)) return;
        if (line.includes("removed in 0.6.0")) return;
        hits.push(`${relative(ROOT, f)}:${i + 1}: ${line.trim()}`);
      });
  }
  return hits;
}

describe("drive1 docs", () => {
  it("drive1 AC-25: drive skill rule 1 names the default codeBy and the emergency exit", () => {
    const text = read("templates/claude/skills/drive/SKILL.md");
    const description = text.split("\n").find((l) => l.startsWith("description:")) ?? "";
    expect(description).not.toBe("");
    expect(description).not.toContain('when gates.json sets codeBy to "driver"');
    expect(description).not.toContain("codeBy");

    const rule1 = section(text, "1. **Do no step's work yourself**", /^2\. /);
    expect(rule1).not.toBe("");
    expect(rule1).toContain('spec-gate refuses your code edits anyway, because `codeBy` is `"driver"` by default');
    expect(rule1).toContain("Only a human opens the emergency exit");
    expect(rule1).toContain('`"codeBy": "anyone"`');
    expect(rule1).not.toContain('With `codeBy: "driver"`');
  });

  it("drive1 AC-26: README describes codeBy as the Contract does and one way to write code", () => {
    const text = read("README.md");
    const lines = text.split("\n");

    // codeBy in the gates.json table (was line 136): default "driver", in the seed, "anyone" the emergency exit.
    const codeByRow = lines.find((l) => l.startsWith("| `codeBy` |")) ?? "";
    expect(codeByRow).toContain('`"driver"` (default, in the seed)');
    expect(codeByRow).toContain('`"anyone"` is the emergency exit');
    expect(codeByRow).not.toMatch(/Default `"anyone"`|not in the seed/);

    // codeBy in "From a chat" (was line 229): no longer "set codeBy to driver to hold that".
    const fromChat = section(text, "**From a chat.**", /^$/);
    expect(fromChat).not.toBe("");
    expect(fromChat).not.toContain('set `"codeBy": "driver"`');
    expect(fromChat).toContain('`codeBy` is `"driver"` by default');
    expect(fromChat).toContain('`"codeBy": "anyone"`');
    expect(fromChat).toContain("emergency exit");

    // The workflow: steps 4-5 through the driver, no step 6 "Report".
    const workflow = section(text, "## The workflow", /^## /);
    expect(workflow).not.toBe("");
    const step4 = section(workflow, "4. ", /^\d+\. |^$/);
    const step5 = section(workflow, "5. ", /^\d+\. |^$/);
    expect(step4).toContain("through the driver");
    expect(step5).toContain("through the driver");
    expect(workflow).not.toMatch(/^6\. /m);
    expect(workflow).not.toContain("**Report**");
    expect(workflow).not.toMatch(/EVIDENCE|NOT DONE|evidence-gate/);

    // The CLAUDE.md line of the tree (was line 37): no report contract.
    const claudeMdLine = lines.find((l) => l.startsWith("CLAUDE.md ")) ?? "";
    expect(claudeMdLine).not.toBe("");
    expect(claudeMdLine.toLowerCase()).not.toContain("report contract");

    // No evidence-gate, test-writer or task-analyzer outside the measured-history rows.
    const removed = lines.filter((l) => /evidence-gate|test-writer|task-analyzer/.test(l));
    expect(removed.filter((l) => !l.includes("removed in 0.6.0"))).toEqual([]);

    // No "reference docs to fill in" under skills/ (was line 66).
    expect(text).not.toContain("reference docs to fill in");
    const agentsLine = lines.find((l) => l.startsWith("├── agents/")) ?? "";
    expect(agentsLine).toContain("spec-reviewer, implementer, code-reviewer");
  });

  it("drive1 AC-27: no retired words in src, templates, README, CODEMAP, GLOSSARY", () => {
    const files = [
      ...walk(join(ROOT, "src")),
      ...walk(join(ROOT, "templates")),
      join(ROOT, "README.md"),
      join(ROOT, "CODEMAP.md"),
      join(ROOT, "docs", "GLOSSARY.md"),
    ];
    // The walk reaches the files AC-27 names.
    for (const p of [
      "src/usage/collect.ts",
      "src/detect/harness-params.ts",
      "src/claude/update-plan.ts",
      "templates/claude/bin/health",
      "templates/claude/hooks/guard-file.sh",
      "templates/claude/hooks/spec-gate.sh",
    ]) {
      expect(files).toContain(join(ROOT, p));
    }
    expect(retiredHits(files)).toEqual([]);

    // The exceptions are narrow: the RETIRED_HOOKS definition stays, and other lines still count.
    const updatePlan = read("src/claude/update-plan.ts");
    expect(updatePlan).toMatch(/^const RETIRED_HOOKS = .*evidence-gate\.sh/m);
    expect(RETIRED.test("| `evidence-gate` hook | ran 580 times — a candidate for removal |")).toBe(true);
  });

  it("drive1 AC-27: the usage table keeps its history and marks removed parts", () => {
    const text = read("README.md");
    const lines = text.split("\n");
    const row = (start: string): string[] => lines.filter((l) => l.startsWith(start));

    const evidence = row("| `evidence-gate` hook |");
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatch(/ran 218 times, stopped nothing \| ran 580 times, output once — removed in 0\.6\.0 \|$/);

    // Row 425 is split into two rows.
    expect(lines.some((l) => l.startsWith("| `task-analyzer`, `pattern-scout`"))).toBe(false);
    const analyzer = row("| `task-analyzer` subagent |");
    expect(analyzer).toHaveLength(1);
    expect(analyzer[0]).toMatch(/\| never called \| never called; removed in 0\.6\.0 \|$/);
    const scout = row("| `pattern-scout` subagent |");
    expect(scout).toHaveLength(1);
    expect(scout[0]).toMatch(/\| never called \| never called; the driver does not use it \|$/);

    // Line 433: "Proven in use" no longer lists test-writer, and keeps the rest.
    const proven = section(text, "Proven in use:", /^$/);
    expect(proven).not.toBe("");
    expect(proven).not.toContain("test-writer");
    expect(proven).toContain("`researcher`");
    expect(proven).toContain("`implementer` and `code-reviewer`");

    // CODEMAP.md:19: the templates row no longer names _TOKENS.md.
    const codemapRow = read("CODEMAP.md").split("\n").find((l) => l.startsWith("| `templates/claude/`")) ?? "";
    expect(codemapRow).not.toBe("");
    expect(codemapRow).not.toContain("_TOKENS");
    expect(codemapRow).toContain("`_normative.md` (CLAUDE.md sections)");
  });

  it("drive1 AC-28: GLOSSARY entries", () => {
    const text = read("docs/GLOSSARY.md");

    const gates = entry(text, "Gates (hooks)");
    expect(gates).not.toBe("");
    expect(gates).not.toMatch(/evidence/i);
    expect(gates).toContain("**spec-gate**");
    expect(gates).toContain("**cheat-guard**");
    expect(gates).toContain("**arch-guard**");

    const liveRun = entry(text, "Live run");
    expect(liveRun.replace(/\s+/g, " ")).toContain(
      "spec-gate steps aside for a live run on its own branch: its `codeBy` check in any mode, its spec and plan checks in quick mode",
    );
    expect(liveRun).not.toMatch(/evidence-gate|Two hooks/);

    const operator = entry(text, "Operator chat");
    expect(operator).toContain("It does no step's work itself");
    expect(operator).toContain('By default (`codeBy` `"driver"`) spec-gate holds this');
    expect(operator).not.toContain('With `codeBy: "driver"` a hook holds this');

    expect(text).not.toMatch(/^- \*\*Evidence\*\*/m);

    // codeBy and Emergency exit stay as the spec commit (014c0ba) added them.
    expect(text).toContain(
      [
        "- **`codeBy`** — `gates.json` → `codeBy`: who may edit code outside `openPaths`. spec-gate reads it.",
        "  **driver** (the default, also when the key is missing): only a driver call of a live run on this branch. A chat",
        "  runs the work with `/drive`, also a small fix (`run quick`).",
        "  - **Emergency exit** — `\"codeBy\": \"anyone\"`: every chat may edit code again. Only a human sets it, by hand, when",
        "    the driver itself is broken.",
      ].join("\n"),
    );
  });
});
