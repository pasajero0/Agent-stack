import { afterAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { cleanupProjects, deployHarness, git, patchGates, runHook, write } from "./fixture.js";

afterAll(cleanupProjects);

const SPEC = `---
stage: A0
---
## Acceptance criteria
- **AC-1:** WHEN a valid batch arrives, THE SYSTEM SHALL accept it.
- **AC-2:** IF the batch is empty, THEN THE SYSTEM SHALL reject it.
* AC-3: WHEN an eventId repeats, THE SYSTEM SHALL count it.
Mentions of AC-9 in prose do not define a criterion.
## Changes
`;

/** Repo on the A0 stage branch with the spec merged into main. */
function stageRepo(): string {
  const dir = deployHarness();
  git(dir, "init", "-q", "-b", "main");
  write(dir, "docs/specs/A0/SPEC.md", SPEC);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "spec: A0");
  git(dir, "checkout", "-q", "-b", "A0-ingest");
  return dir;
}

const trace = (dir: string, ...args: string[]) => {
  const r = spawnSync(join(dir, ".claude/bin/trace"), args, { cwd: dir, encoding: "utf-8" });
  return { code: r.status, out: r.stdout + r.stderr };
};

describe("trace", () => {
  it("reports criteria without tests and tests for criteria the spec lacks", () => {
    const dir = stageRepo();
    write(dir, "src/ingest.test.ts", 'it("A0 AC-1: accepts", f);\nit("A0 AC-9: invented", f);\n');
    write(dir, "tests/test_ingest.py", "def test_A0_AC_2_rejects_empty(): ...\n");
    write(dir, "src/ingest.ts", "// A0 AC-3 is mentioned here, but this is not a test file\n");
    const r = trace(dir);
    expect(r.code).toBe(1);
    expect(r.out).toContain("trace A0: 2/3 criteria have tests");
    expect(r.out).toContain("missing tests: AC-3");
    expect(r.out).toContain("not in the spec: AC-9");
  });

  it("passes when every criterion is traced and nothing is invented", () => {
    const dir = stageRepo();
    write(dir, "src/ingest.test.ts", 'it("A0 AC-1", f); it("A0.AC-2", f); it("A0-AC-3", f);\n');
    write(dir, "src/other.test.ts", 'it("A1 AC-7: another stage, ignored", f);\n');
    const r = trace(dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain("3/3");
  });

  it("does not ask a light spec for tests; light: outside the frontmatter does not count", () => {
    const dir = stageRepo();
    write(dir, "docs/specs/A0/SPEC.md", "---\nstage: A0\nlight: true\n---\n- **AC-1:** build passes. Check: `pnpm build`\n");
    let r = trace(dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain("light spec");
    write(dir, "docs/specs/A0/SPEC.md", "---\r\nstage: A0\r\nlight: true\r\n---\r\n- **AC-1:** x\r\n");
    expect(trace(dir).code).toBe(0); // CRLF line endings
    write(dir, "docs/specs/A0/SPEC.md", SPEC + "light: true\n");
    r = trace(dir);
    expect(r.code).toBe(1);
    expect(r.out).toContain("missing tests");
  });

  it("cannot run without a stage or a spec", () => {
    const dir = stageRepo();
    expect(trace(dir, "B7").code).toBe(2);
    git(dir, "checkout", "-q", "main");
    expect(trace(dir).out).toContain("no stage");
  });

  it("evidence-gate refuses DONE while criteria and tests do not line up", () => {
    const dir = stageRepo();
    write(dir, ".claude/tmp/A0/tasks.json", JSON.stringify({ tasks: [{ id: "T1", verify: "true", passes: true }] }));
    write(dir, "src/ingest.test.ts", 'it("A0 AC-1", f);\n');
    const done = { stop_hook_active: false, last_assistant_message: "STATUS: DONE\nEVIDENCE: verify 1/1" };
    const r = runHook(dir, "evidence-gate.sh", done);
    expect(JSON.parse(r.stdout).decision).toBe("block");
    expect(JSON.parse(r.stdout).reason).toContain("missing tests: AC-2 AC-3");

    write(dir, "src/ingest.test.ts", 'it("A0 AC-1", f); it("A0 AC-2", f); it("A0 AC-3", f);\n');
    expect(runHook(dir, "evidence-gate.sh", done).stdout).toBe("");
  });
});

describe("trace: spec terms against the glossary", () => {
  const ALL_TESTS = 'it("A0 AC-1", f); it("A0 AC-2", f); it("A0 AC-3", f);\n';
  const GLOSSARY = "# Glossary\n\n- **Batch** — a set of readings.\n  - **Event id** — nested headwords count too.\n";
  const withTerms = (terms: string): string => SPEC.replace("## Acceptance criteria", `## Terms\n${terms}\n## Acceptance criteria`);

  /** A traced stage whose spec has `terms` and whose glossary is docs/GLOSSARY.md. */
  function termsRepo(terms: string, glossary: string | null = GLOSSARY): string {
    const dir = stageRepo();
    write(dir, "docs/specs/A0/SPEC.md", withTerms(terms));
    if (glossary !== null) write(dir, "docs/GLOSSARY.md", glossary);
    write(dir, "src/ingest.test.ts", ALL_TESTS);
    return dir;
  }

  it("fails on a Terms entry that is neither in the glossary nor marked (local), and names it", () => {
    const dir = termsRepo("- **Batch** — as in the glossary.\n- **Decision** — a new reason.\n- **Retry window**: new too.\n");
    const r = trace(dir);
    expect(r.code).toBe(1);
    expect(r.out).toContain("3/3 criteria have tests");
    expect(r.out).toContain("terms not in docs/GLOSSARY.md: Decision, Retry window");
    expect(r.out).toContain("(local)");
  });

  it("passes when each term is a glossary headword (any case, nested too) or marked (local)", () => {
    const dir = termsRepo("- **batch** — case does not matter.\n- **Event id**: nested in the glossary.\n- **Lock** (local): this spec only.\n  - **Sub item** — a nested line is not a term.\n");
    const r = trace(dir);
    expect(r.code, r.out).toBe(0);
    expect(r.out).not.toContain("terms not in");
  });

  it("checks nothing without a glossary file, and with gates.json glossary set to an empty string", () => {
    expect(trace(termsRepo("- **Decision** — new.\n", null)).code).toBe(0);
    const dir = termsRepo("- **Decision** — new.\n");
    patchGates(dir, { glossary: "" });
    expect(trace(dir).code).toBe(0);
  });

  it("reads the glossary from gates.json glossary when it is set, and checks against that file", () => {
    const dir = termsRepo("- **Decision** — new.\n", null);
    write(dir, "handbook/words.md", "- **Batch** — no Decision here.\n");
    patchGates(dir, { glossary: "handbook/words.md" });
    let r = trace(dir);
    expect(r.code).toBe(1);
    expect(r.out).toContain("terms not in handbook/words.md: Decision");
    write(dir, "handbook/words.md", "- **Decision** — defined here.\n");
    expect(trace(dir).code).toBe(0);
    patchGates(dir, { glossary: join(dir, "handbook/words.md") }); // an absolute path works too
    expect(trace(dir).code).toBe(0);
  });

  it("says so on stderr when gates.json names a glossary that does not exist, and checks nothing", () => {
    const dir = termsRepo("- **Decision** — new.\n");
    patchGates(dir, { glossary: "docs/Glosary.md" });
    const r = trace(dir);
    expect(r.code).toBe(0);
    expect(r.out).toContain("gates.json → glossary names docs/Glosary.md, which does not exist");
  });

  it("ignores bold words outside the Terms section", () => {
    const dir = termsRepo("- **Batch** — fine.\n");
    write(dir, "docs/specs/A0/SPEC.md", withTerms("- **Batch** — fine.\n") + "- **Not a term** — in Changes.\n");
    expect(trace(dir).code).toBe(0);
  });

  it("accepts text after the Terms heading and a colon inside the bold", () => {
    const dir = termsRepo("- **Batch:** colon inside the bold.\n");
    write(dir, "docs/specs/A0/SPEC.md", withTerms("- **Batch:** fine.\n- **Novel** — not listed.\n").replace("## Terms", "## Terms (domain words)"));
    const r = trace(dir);
    expect(r.code).toBe(1);
    expect(r.out).toContain("terms not in docs/GLOSSARY.md: Novel");
    expect(r.out).not.toContain("Batch");
  });

  it("--terms checks only the terms, so a spec with no tests yet can be checked before hand-over", () => {
    const dir = stageRepo();
    write(dir, "docs/GLOSSARY.md", GLOSSARY);
    write(dir, "docs/specs/A0/SPEC.md", withTerms("- **Batch** — fine.\n"));
    expect(trace(dir).code).toBe(1); // the full trace: no tests yet
    let r = trace(dir, "--terms");
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("trace A0: spec terms ok");
    write(dir, "docs/specs/A0/SPEC.md", withTerms("- **Batch** — fine.\n- **Novel** — new.\n"));
    r = trace(dir, "--terms", "A0");
    expect(r.code).toBe(1);
    expect(r.out).toContain("terms not in docs/GLOSSARY.md: Novel");
    expect(trace(dir, "--terms", "B7").code).toBe(2);
  });

  it("checks the terms of a light spec too", () => {
    const dir = stageRepo();
    write(dir, "docs/GLOSSARY.md", GLOSSARY);
    write(dir, "docs/specs/A0/SPEC.md", "---\nstage: A0\nlight: true\n---\n## Terms\n- **Novel** — new.\n## Checklist\n- **AC-1:** x\n");
    const r = trace(dir);
    expect(r.code).toBe(1);
    expect(r.out).toContain("light spec");
    expect(r.out).toContain("terms not in docs/GLOSSARY.md: Novel");
  });

  it("evidence-gate names a term failure as a trace failure, not as criteria and tests out of line", () => {
    const dir = termsRepo("- **Novel** — new.\n");
    write(dir, ".claude/tmp/A0/tasks.json", JSON.stringify({ tasks: [{ id: "T1", verify: "true", passes: true }] }));
    const done = { stop_hook_active: false, last_assistant_message: "STATUS: DONE\nEVIDENCE: verify 1/1" };
    const reason = JSON.parse(runHook(dir, "evidence-gate.sh", done).stdout).reason as string;
    expect(reason).toContain("trace failed");
    expect(reason).toContain("Novel");
    expect(reason).not.toContain("do not line up");
  });
});
