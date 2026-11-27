/**
 * spec-gate's codeBy check stays open where it must (spec docs/specs/drive1/SPEC.md, AC-16, AC-19, AC-24).
 * Each "pass" below has a partner in the same fixture that the codeBy check refuses, so a pass proves the
 * check was skipped, not that nothing was checked.
 */
import { afterAll, describe, expect, it } from "vitest";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupProjects, deployHarness, edit, git, runHook, write, writeTool } from "./fixture.js";

afterAll(cleanupProjects);

const NO_ENV = { AGENT_STACK_RUN: "" };
const RUN = "r-20261127-120000";
const STAGE = "drive1";
const BRANCH = `${STAGE}-work`;

/** Merge `patch` into gates.json; a key set to `undefined` is removed (patchGates cannot remove one). */
function setGates(dir: string, patch: Record<string, unknown>): void {
  const file = join(dir, ".claude/gates.json");
  const g = { ...JSON.parse(readFileSync(file, "utf-8")), ...patch };
  for (const [k, v] of Object.entries(patch)) if (v === undefined) delete g[k];
  writeFileSync(file, JSON.stringify(g, null, 2));
}

/** A repo with one commit on main and work on `branch`; nothing else lets code through. */
function repo(codeBy: unknown, branch = "fix/login"): string {
  const dir = deployHarness();
  setGates(dir, { codeBy });
  git(dir, "init", "-q", "-b", "main");
  write(dir, "README.md", "# demo\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "-q", "-m", "init");
  git(dir, "checkout", "-q", "-b", branch);
  return dir;
}

/** A repo where every later spec-gate step lets code through: spec merged into main, plan written. */
function stageRepo(codeBy: unknown): string {
  const dir = deployHarness();
  setGates(dir, { codeBy });
  git(dir, "init", "-q", "-b", "main");
  write(dir, `docs/specs/${STAGE}/SPEC.md`, "# spec\n\n- **AC-1:** THE SYSTEM SHALL exist.\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "spec");
  git(dir, "checkout", "-q", "-b", BRANCH);
  write(dir, `.claude/tmp/${STAGE}/tasks.json`, JSON.stringify({ stage: STAGE, tasks: [{ id: "T1", passes: false }] }));
  return dir;
}

/** A repo with the harness and no commits yet (codeBy only prints its system message there). */
function emptyRepo(codeBy: unknown): string {
  const dir = deployHarness();
  setGates(dir, { codeBy });
  git(dir, "init", "-q", "-b", "main");
  return dir;
}

/** What the driver writes for a live task run on `branch`: the run file and the lock. */
function liveTaskRun(dir: string, branch: string): void {
  write(
    dir,
    `.claude/tmp/runs/${RUN}/run.json`,
    JSON.stringify({ id: RUN, mode: "task", status: "running", next: "spec", branch, stage: STAGE })
  );
  write(dir, ".claude/tmp/runs/lock", JSON.stringify({ id: RUN, pid: process.pid }));
}

const gate = (dir: string, input: unknown, env: Record<string, string> = NO_ENV) =>
  runHook(dir, "spec-gate.sh", input, env);
const multiEdit = (file_path: string) => ({
  tool_name: "MultiEdit",
  tool_input: { file_path, edits: [{ old_string: "y", new_string: "x" }] },
});
const notebookEdit = (notebook_path: string) => ({
  tool_name: "NotebookEdit",
  tool_input: { notebook_path, new_source: "x" },
});
/** Every edit tool spec-gate is registered for, on code paths outside openPaths. */
const codeEdits = (dir: string) => [
  edit(join(dir, "src/app.ts")),
  writeTool(join(dir, "src/new.ts")),
  multiEdit(join(dir, "lib/util.ts")),
  notebookEdit(join(dir, "nb/analysis.ipynb")),
];

/** Values the codeBy check refuses a chat's code edit with, before and after the default flips. */
const CLOSED: unknown[] = ["driver", "Anyone", true, 1];
/** Every codeBy value: missing, null and "" too (read as "driver" once the default flips). */
const ALL: unknown[] = [undefined, null, "", ...CLOSED, "anyone"];
const named = (values: unknown[]): Array<[string, unknown]> => values.map((v) => [JSON.stringify(v) ?? "missing", v]);

describe("codeBy anyone skips the codeBy check", () => {
  it("drive1 AC-16: every edit tool passes where the later steps allow code; codeBy driver refuses the same edits", () => {
    const open = stageRepo("anyone");
    const closed = stageRepo("driver");
    for (const input of codeEdits(open)) {
      const r = gate(open, input);
      expect(r.code, JSON.stringify(input)).toBe(0);
      expect(r.stdout + r.stderr).toBe("");
    }
    for (const input of codeEdits(closed)) {
      const r = gate(closed, input);
      expect(r.code, JSON.stringify(input)).toBe(2);
      expect(r.stderr).toContain("codeBy");
    }
  });

  it("drive1 AC-16: with codeBy anyone the later steps decide, and their refusal does not name codeBy", () => {
    const dir = repo("anyone"); // fix/login: not a stage branch, specGate strict
    const r = gate(dir, edit(join(dir, "src/app.ts")));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("not on a stage branch");
    expect(r.stderr).not.toContain("codeBy");
    // The same check answers whether or not the call names a driver run.
    expect(gate(dir, edit(join(dir, "src/app.ts")), { AGENT_STACK_RUN: RUN }).stderr).toContain("not on a stage branch");
  });

  it("drive1 AC-16: with codeBy anyone a repo with no commits gets no codeBy system message", () => {
    const open = emptyRepo("anyone");
    for (const input of codeEdits(open)) {
      const r = gate(open, input);
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("");
    }
    // Partner: codeBy driver in the same repo prints the message, so the check did run there.
    const held = emptyRepo("driver");
    expect(JSON.parse(gate(held, edit(join(held, "src/app.ts"))).stdout).systemMessage).toContain("codeBy");
  });
});

describe("spec-gate exits 0 before the codeBy check", () => {
  /** The inputs of AC-19 that have a gates.json: an openPaths path, a path outside the project, no file path. */
  const earlyExits = (dir: string): Array<[string, unknown]> => [
    ["openPaths path", edit(join(dir, "src/open/a.ts"))],
    ["openPaths path by Write", writeTool(join(dir, "src/open/b.ts"))],
    ["absolute path outside the project", edit("/etc/outside.ts")],
    ["path that leaves the project through ..", writeTool(join(dir, "../outside-of-project.ts"))],
    ["Edit with no file path", { tool_name: "Edit", tool_input: { old_string: "y", new_string: "x" } }],
    ["no tool_input at all", { tool_name: "Write" }],
  ];

  it.each(named(CLOSED))(
    "drive1 AC-19: an openPaths path, a path outside the project or no file path exits 0 with codeBy %s",
    (_name, codeBy) => {
      const dir = repo(codeBy);
      setGates(dir, { openPaths: ["src/open/*"] });
      for (const [what, input] of earlyExits(dir)) {
        const r = gate(dir, input);
        expect(r.code, what).toBe(0);
        expect(r.stdout + r.stderr, what).toBe("");
      }
      // Partner: a code path in the same repo reaches the codeBy check and is refused by it.
      const r = gate(dir, edit(join(dir, "src/app.ts")));
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("codeBy");
    }
  );

  it("drive1 AC-19: in a repo with no commits these inputs exit 0 before the codeBy system message", () => {
    const dir = emptyRepo("driver");
    setGates(dir, { openPaths: ["src/open/*"] });
    for (const [what, input] of earlyExits(dir)) {
      const r = gate(dir, input);
      expect(r.code, what).toBe(0);
      expect(r.stdout, what).toBe("");
    }
    // Partner: a code path reaches the check, which prints its message.
    expect(gate(dir, edit(join(dir, "src/app.ts"))).stdout).toContain("starts after the first commit");
  });

  it("drive1 AC-19: with no gates.json spec-gate exits 0 for a code edit, silently", () => {
    const dir = repo("driver");
    expect(gate(dir, edit(join(dir, "src/app.ts"))).code).toBe(2); // with the file: refused
    rmSync(join(dir, ".claude/gates.json"));
    for (const input of codeEdits(dir)) {
      const r = gate(dir, input);
      expect(r.code).toBe(0);
      expect(r.stdout + r.stderr).toBe("");
    }
    const empty = emptyRepo("driver");
    rmSync(join(empty, ".claude/gates.json"));
    expect(gate(empty, edit(join(empty, "src/app.ts"))).stdout).toBe("");
  });
});

describe("the generated openPaths keep docs and the harness open with any codeBy", () => {
  const SPEC_AND_GLOSSARY = [`docs/specs/${STAGE}/SPEC.md`, "docs/GLOSSARY.md"];
  const CHAT_MD = ["README.md", "notes/todo.md", "src/README.md"];
  const CHAT_CLAUDE = [".claude/rules/api.md", `.claude/tmp/${STAGE}/notes.txt`, ".claude/skills/own/SKILL.md"];

  it("drive1 AC-24: the fixture uses the openPaths that generate writes", () => {
    const g = JSON.parse(readFileSync(join(deployHarness(), ".claude/gates.json"), "utf-8"));
    expect(g.openPaths).toEqual(["docs/*", "*.md", ".claude/*", ".gitignore"]);
  });

  it.each(named(ALL))(
    "drive1 AC-24: a driver role writes the spec and the glossary with codeBy %s",
    (_name, codeBy) => {
      // A live task run on a stage branch whose spec is not merged yet: code is still closed for it.
      const dir = repo(codeBy, BRANCH);
      liveTaskRun(dir, BRANCH);
      const env = { AGENT_STACK_RUN: RUN };
      for (const p of SPEC_AND_GLOSSARY) {
        for (const input of [writeTool(join(dir, p)), edit(join(dir, p))]) {
          expect(gate(dir, input, env).code, p).toBe(0);
        }
      }
      // Partner: the same driver call may not write code yet, so the spec passed through openPaths.
      const code = gate(dir, edit(join(dir, "src/app.ts")), env);
      expect(code.code).toBe(2);
      expect(code.stderr).toContain("not merged");
    }
  );

  it.each(named(ALL))(
    "drive1 AC-24: a chat edits *.md files and the .claude/ files guard-file allows with codeBy %s",
    (_name, codeBy) => {
      const dir = repo(codeBy);
      for (const p of [...CHAT_MD, ...CHAT_CLAUDE, ...SPEC_AND_GLOSSARY]) {
        const input = edit(join(dir, p));
        expect(runHook(dir, "guard-file.sh", input, NO_ENV).code, `guard-file ${p}`).toBe(0);
        const r = gate(dir, input);
        expect(r.code, p).toBe(0);
        expect(r.stdout + r.stderr, p).toBe("");
      }
      // Partner: a code edit in the same chat is refused (by codeBy, or by the stage check with "anyone").
      expect(gate(dir, edit(join(dir, "src/app.ts"))).code).toBe(2);
    }
  );
});
