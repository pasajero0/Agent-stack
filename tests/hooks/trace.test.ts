import { afterAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { cleanupProjects, deployHarness, git, runHook, write } from "./fixture.js";

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
