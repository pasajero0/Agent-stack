/**
 * spec-gate's codeBy check reads a missing value as "driver" (spec docs/specs/drive1/SPEC.md, AC-14, AC-15,
 * AC-17, AC-18, AC-20, AC-23). A chat's code edit gets the Contract's refusal line; a driver call of a live run
 * on this branch passes the check, and the rest of spec-gate decides.
 */
import { afterAll, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildGatesConfig } from "../../src/claude/gates.js";
import { cleanupProjects, deployHarness, edit, git, runHook, TS_PARAMS, write, writeTool } from "./fixture.js";

afterAll(cleanupProjects);

const NO_ENV = { AGENT_STACK_RUN: "" };
const RUN = "r-20261127-120000";
const OTHER = "r-20261127-130000";
const LIVE = process.pid;
const DEAD = 2 ** 22 + 12345; // above pid_max on macOS and Linux: never a live process
const BRANCH = "fix/login";

/** Merge `patch` into gates.json; a key set to `undefined` is removed. */
function setGates(dir: string, patch: Record<string, unknown>): void {
  const file = join(dir, ".claude/gates.json");
  const g = { ...JSON.parse(readFileSync(file, "utf-8")), ...patch };
  for (const [k, v] of Object.entries(patch)) if (v === undefined) delete g[k];
  writeFileSync(file, JSON.stringify(g, null, 2));
}

/** A repo with one commit on main and work on `branch`. */
function repo(codeBy: unknown, specGate = "off", branch = BRANCH): string {
  const dir = deployHarness();
  setGates(dir, { codeBy, specGate });
  git(dir, "init", "-q", "-b", "main");
  write(dir, "README.md", "# demo\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "-q", "-m", "init");
  git(dir, "checkout", "-q", "-b", branch);
  return dir;
}

/** A repo with the harness and no commits yet. */
function emptyRepo(codeBy: unknown): string {
  const dir = deployHarness();
  setGates(dir, { codeBy });
  git(dir, "init", "-q", "-b", "main");
  return dir;
}

interface RunFixture {
  id?: string;
  mode?: string;
  status?: string;
  branch?: string;
}

/** What the driver writes: the run file and the lock. */
function driverRun(dir: string, run: RunFixture = {}, lock: { id?: string; pid?: unknown } = {}): void {
  const id = run.id ?? RUN;
  write(
    dir,
    `.claude/tmp/runs/${id}/run.json`,
    JSON.stringify({ id, mode: "task", status: "running", next: "implement", branch: BRANCH, ...run })
  );
  write(dir, ".claude/tmp/runs/lock", JSON.stringify({ id: lock.id ?? id, pid: lock.pid ?? LIVE }));
}

const gate = (dir: string, input: unknown, env: Record<string, string> = NO_ENV) =>
  runHook(dir, "spec-gate.sh", input, env);
const codeEdit = (dir: string) => edit(join(dir, "src/app.ts"));
/** Every edit tool spec-gate is registered for, with the path spec-gate prints for it. */
const codeEdits = (dir: string): Array<[string, unknown]> => [
  ["src/app.ts", edit(join(dir, "src/app.ts"))],
  ["src/new.ts", writeTool(join(dir, "src/new.ts"))],
  ["lib/util.ts", { tool_name: "MultiEdit", tool_input: { file_path: join(dir, "lib/util.ts"), edits: [] } }],
  ["nb/a.ipynb", { tool_name: "NotebookEdit", tool_input: { notebook_path: join(dir, "nb/a.ipynb"), new_source: "x" } }],
];

/** The Contract's refusal line for `path`, with `why` from its table. */
const refusal = (path: string, why: string) =>
  `Blocked by spec-gate (${path}): only the driver edits code here — ${why}. Run the work through the driver: /drive in this chat, or agent-stack run task "<goal>" (agent-stack run quick "<fix>" for a small fix). If the driver itself is broken, a human opens the emergency exit: set "codeBy": "anyone" in .claude/gates.json by hand.\n`;
const NOT_SET = 'gates.json → codeBy is not set, so it is "driver"';
const DRIVER = 'gates.json → codeBy is "driver"';
const unknown = (v: string) => `gates.json → codeBy is "${v}", which is unknown, so it is read as "driver"`;

/** The values that read as "driver", with the <why> of each. */
const DRIVER_VALUES: Array<[string, unknown, string]> = [
  ["missing", undefined, NOT_SET],
  ["null", null, NOT_SET],
  ['""', "", NOT_SET],
  ['"driver"', "driver", DRIVER],
];
/** Unknown values, with the value as gate_get prints it. */
const UNKNOWN_VALUES: Array<[string, unknown, string]> = [
  ['"Anyone"', "Anyone", "Anyone"],
  ["true", true, "true"],
  ["false", false, "false"],
  ["1", 1, "1"],
  ['"drivr"', "drivr", "drivr"],
];

describe("a chat's code edit is refused when codeBy reads as driver", () => {
  it.each(DRIVER_VALUES)(
    "drive1 AC-14: codeBy %s refuses every edit tool with the refusal line, even with specGate off",
    (_name, codeBy, why) => {
      for (const specGate of ["off", "stage", "strict"]) {
        const dir = repo(codeBy, specGate);
        for (const [rel, input] of codeEdits(dir)) {
          const r = gate(dir, input);
          expect(r.code, `${specGate} ${rel}`).toBe(2);
          expect(r.stderr, `${specGate} ${rel}`).toBe(refusal(rel, why));
          expect(r.stdout).toBe("");
        }
      }
    }
  );

  it("drive1 AC-14: the refusal comes before the stage checks, and docs stay open", () => {
    // A stage branch with no merged spec: without codeBy the stage check would answer.
    const dir = repo(undefined, "strict", "A0-work");
    expect(gate(dir, codeEdit(dir)).stderr).toBe(refusal("src/app.ts", NOT_SET));
    expect(gate(dir, edit(join(dir, "docs/notes.md"))).code).toBe(0);
  });

  it.each(UNKNOWN_VALUES)("drive1 AC-18: codeBy %s is read as driver and the refusal line names it", (_name, codeBy, v) => {
    const dir = repo(codeBy);
    for (const [rel, input] of codeEdits(dir)) {
      const r = gate(dir, input);
      expect(r.code, rel).toBe(2);
      expect(r.stderr, rel).toBe(refusal(rel, unknown(v)));
    }
  });
});

describe("a driver call of a live run on this branch passes the codeBy check", () => {
  it.each([...DRIVER_VALUES, ...UNKNOWN_VALUES])(
    "drive1 AC-15: codeBy %s lets a live task or quick run edit code; with specGate off nothing else holds it",
    (_name, codeBy) => {
      for (const mode of ["task", "quick"]) {
        const dir = repo(codeBy);
        driverRun(dir, { mode });
        for (const [rel, input] of codeEdits(dir)) {
          const r = gate(dir, input, { AGENT_STACK_RUN: RUN });
          expect(r.code, `${mode} ${rel}`).toBe(0);
          expect(r.stdout + r.stderr).toBe("");
        }
        // Partner: the same edit from a chat is refused by codeBy.
        expect(gate(dir, codeEdit(dir)).code).toBe(2);
      }
    }
  );

  it.each(DRIVER_VALUES)("drive1 AC-15: with codeBy %s the rest of spec-gate then decides for a live task run", (_name, codeBy) => {
    // A stage branch whose spec is not merged: the stage check refuses the task run, not codeBy.
    const dir = repo(codeBy, "strict", "A0-work");
    driverRun(dir, { mode: "task", branch: "A0-work" });
    const r = gate(dir, codeEdit(dir), { AGENT_STACK_RUN: RUN });
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("not merged");
    expect(r.stderr).not.toContain("codeBy");
    // A quick run skips the stage checks as before.
    const quick = repo(codeBy, "strict", "A0-fix");
    driverRun(quick, { mode: "quick", branch: "A0-fix" });
    expect(gate(quick, codeEdit(quick), { AGENT_STACK_RUN: RUN }).code).toBe(0);
  });
});

describe("a run that is not live, on another branch, or with a bad id opens nothing", () => {
  const cases: Array<[string, (dir: string) => void, string]> = [
    ["a dead driver pid", (d) => driverRun(d, {}, { pid: DEAD }), RUN],
    ["a lock pid of 0", (d) => driverRun(d, {}, { pid: 0 }), RUN],
    ["a waiting run", (d) => driverRun(d, { status: "waiting" }), RUN],
    ["a done run", (d) => driverRun(d, { status: "done" }), RUN],
    ["no lock", (d) => write(d, `.claude/tmp/runs/${RUN}/run.json`, JSON.stringify({ id: RUN, mode: "task", status: "running", branch: BRANCH })), RUN],
    ["a lock naming another run", (d) => driverRun(d, {}, { id: OTHER }), RUN],
    ["a run on another branch", (d) => driverRun(d, { branch: "fix/other" }), RUN],
    ["a malformed id", (d) => driverRun(d, { id: "r-2026112-120000" }), "r-2026112-120000"],
    ["an id that leaves the runs folder", (d) => driverRun(d), `../runs/${RUN}`],
    ["an id with a trailing newline", (d) => driverRun(d), `${RUN}\n`],
  ];

  for (const [name, codeBy, why] of DRIVER_VALUES) {
    it.each(cases)(`drive1 AC-23: codeBy ${name}: %s gets the refusal line`, (_what, setup, id) => {
      const dir = repo(codeBy);
      setup(dir);
      const r = gate(dir, codeEdit(dir), { AGENT_STACK_RUN: id });
      expect(r.code).toBe(2);
      expect(r.stderr).toBe(refusal("src/app.ts", why));
    });
  }

  it("drive1 AC-23: the same run passes while live, and is refused once its pid is dead", () => {
    const dir = repo(undefined);
    driverRun(dir);
    expect(gate(dir, codeEdit(dir), { AGENT_STACK_RUN: RUN }).code).toBe(0);
    driverRun(dir, {}, { pid: DEAD });
    expect(gate(dir, codeEdit(dir), { AGENT_STACK_RUN: RUN }).stderr).toBe(refusal("src/app.ts", NOT_SET));
  });
});

describe("a repo with no commits", () => {
  const message = (v: string) => `spec-gate: codeBy "${v}" starts after the first commit; this edit is not held by it.`;

  it.each([
    ...DRIVER_VALUES.map(([n, c]): [string, unknown, string] => [n, c, "driver"]),
    ...UNKNOWN_VALUES,
  ])("drive1 AC-17: codeBy %s does not apply yet: the system message, exit 0", (_name, codeBy, v) => {
    const dir = emptyRepo(codeBy);
    for (const [rel, input] of codeEdits(dir)) {
      const r = gate(dir, input);
      expect(r.code, rel).toBe(0);
      expect(r.stderr, rel).toBe("");
      expect(JSON.parse(r.stdout), rel).toEqual({ systemMessage: message(v) });
    }
  });
});

describe("generate writes codeBy", () => {
  it('drive1 AC-20: buildGatesConfig and the deployed gates.json have "codeBy": "driver" right after specGate', () => {
    const built = buildGatesConfig(TS_PARAMS, {});
    const keys = Object.keys(built);
    expect(built).toHaveProperty("codeBy", "driver");
    expect(keys[keys.indexOf("specGate") + 1]).toBe("codeBy");
    const deployed = JSON.parse(readFileSync(join(deployHarness(), ".claude/gates.json"), "utf-8"));
    const dkeys = Object.keys(deployed);
    expect(deployed.codeBy).toBe("driver");
    expect(dkeys[dkeys.indexOf("specGate") + 1]).toBe("codeBy");
  });

  it("drive1 AC-20: the deployed gates.json, unchanged, refuses a chat's code edit", () => {
    const dir = deployHarness();
    git(dir, "init", "-q", "-b", "main");
    write(dir, "README.md", "# demo\n");
    git(dir, "add", "README.md");
    git(dir, "commit", "-q", "-m", "init");
    expect(gate(dir, codeEdit(dir)).stderr).toBe(refusal("src/app.ts", DRIVER));
  });
});
