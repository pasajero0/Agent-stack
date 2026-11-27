/**
 * Spec flow in the hooks (0.4.6): gates-lib's SPEC_FLOWS is a copy of src/run/spec-flow.ts's list, and
 * spec-gate in flow `branch` reads the spec from this branch. Spec: docs/specs/v04/SPEC.md, AC-83, AC-89.
 */
import { afterAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SPEC_FLOWS } from "../../src/run/spec-flow.js";
import { cleanupProjects, deployHarness, edit, git, patchGates, runHook, write } from "./fixture.js";

afterAll(cleanupProjects);

const RUN = "r-20261123-120000";
const LIVE = process.pid;
const SPEC = "docs/specs/B1/SPEC.md";
const TASKS = ".claude/tmp/B1/tasks.json";

/** A repo with the harness in flow `branch`, an initial commit on main, and work on `branch`. */
function repo(branch: string, flow: string = "branch"): string {
  const dir = deployHarness();
  patchGates(dir, { specFlow: flow, codeBy: "anyone" });
  git(dir, "init", "-q", "-b", "main");
  write(dir, "README.md", "# demo\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "-q", "-m", "init");
  git(dir, "checkout", "-q", "-b", branch);
  return dir;
}

/** The spec committed on the current branch, and the plan written, as a run in flow branch leaves them. */
function specAndPlan(dir: string): void {
  write(dir, SPEC, "# B1\n\n- **AC-1:** WHEN x, THE SYSTEM SHALL y.\n");
  git(dir, "add", SPEC);
  git(dir, "commit", "-q", "-m", "docs(b1): spec — greeting");
  write(dir, TASKS, JSON.stringify({ stage: "B1", tasks: [] }));
}

/** A live task run of stage B1 on `branch`, named by AGENT_STACK_RUN. */
function liveTaskRun(dir: string, branch: string): void {
  write(dir, `.claude/tmp/runs/${RUN}/run.json`, JSON.stringify({ id: RUN, mode: "task", status: "running", next: "implement:T1", branch, stage: "B1" }));
  write(dir, ".claude/tmp/runs/lock", JSON.stringify({ id: RUN, pid: LIVE }));
}

const ENV = { AGENT_STACK_RUN: RUN };
const NO_ENV = { AGENT_STACK_RUN: "" };
const codeEdit = (dir: string) => edit(join(dir, "src/app.ts"));

describe("spec flow: one list of names (AC-83)", () => {
  it("v04 AC-83: gates-lib's SPEC_FLOWS is the list in src/run/spec-flow.ts, in the same order", () => {
    const lib = readFileSync(join(__dirname, "../../templates/claude/hooks/gates-lib.sh"), "utf8");
    const m = /^SPEC_FLOWS="([^"]*)"$/m.exec(lib);
    expect(m?.[1]?.split(" ")).toEqual([...SPEC_FLOWS]);
  });

  it("v04 AC-83: spec-gate denies a code edit under an unknown flow and names the allowed ones", () => {
    const dir = repo("B1-greeting", "brnach");
    const r = runHook(dir, "spec-gate.sh", codeEdit(dir), NO_ENV);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("specFlow");
    expect(r.stderr).toContain("merge branch");
  });
});

describe("spec flow branch: spec-gate (AC-89)", () => {
  it("v04 AC-89: a spec committed on this branch and a plan open code edits, with no spec on main", () => {
    const dir = repo("B1-greeting");
    specAndPlan(dir);
    expect(runHook(dir, "spec-gate.sh", codeEdit(dir), NO_ENV).code).toBe(0);
  });

  it("v04 AC-89: the stage of the live task run comes first, so a branch like v2-login is not stage v2", () => {
    const dir = repo("v2-login");
    specAndPlan(dir);
    // Without the run, the branch name gives stage v2, which has no spec.
    expect(runHook(dir, "spec-gate.sh", codeEdit(dir), NO_ENV).code).toBe(2);
    liveTaskRun(dir, "v2-login");
    expect(runHook(dir, "spec-gate.sh", codeEdit(dir), ENV).code).toBe(0);
  });

  it("v04 AC-89: on a branch with no stage in its name, the live task run gives the stage", () => {
    const dir = repo("release/1.0");
    specAndPlan(dir);
    liveTaskRun(dir, "release/1.0");
    expect(runHook(dir, "spec-gate.sh", codeEdit(dir), ENV).code).toBe(0);
  });

  it("v04 AC-89: a spec not committed on this branch is denied", () => {
    const dir = repo("B1-greeting");
    write(dir, TASKS, JSON.stringify({ stage: "B1", tasks: [] }));
    const r = runHook(dir, "spec-gate.sh", codeEdit(dir), NO_ENV);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("not committed on this branch");
  });

  it("v04 AC-89: uncommitted spec edits close code edits", () => {
    const dir = repo("B1-greeting");
    specAndPlan(dir);
    write(dir, SPEC, "# B1\n\n- **AC-1:** WHEN x, THE SYSTEM SHALL z.\n");
    const r = runHook(dir, "spec-gate.sh", codeEdit(dir), NO_ENV);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("uncommitted changes");
  });

  it("v04 AC-89: the plan check holds", () => {
    const dir = repo("B1-greeting");
    write(dir, SPEC, "# B1\n");
    git(dir, "add", SPEC);
    git(dir, "commit", "-q", "-m", "docs(b1): spec — greeting");
    const r = runHook(dir, "spec-gate.sh", codeEdit(dir), NO_ENV);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("no task list yet");
  });

  it("v04 AC-89: with no stage found, it behaves as in flow merge", () => {
    const dir = repo("release/1.0");
    const r = runHook(dir, "spec-gate.sh", codeEdit(dir), NO_ENV);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("not on a stage branch");
  });

  it("v04 AC-89: in flow merge the same branch still needs the spec merged into main", () => {
    const dir = repo("B1-greeting", "merge");
    specAndPlan(dir);
    const r = runHook(dir, "spec-gate.sh", codeEdit(dir), NO_ENV);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("not merged");
  });
});
