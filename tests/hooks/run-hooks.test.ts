import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  cleanupProjects,
  deployHarness,
  edit,
  git,
  patchGates,
  readTool,
  runHook,
  write,
  writeTool,
} from "./fixture.js";

afterAll(cleanupProjects);

const RUN = "r-20261118-120000";
const OTHER = "r-20261118-130000";
const LIVE = process.pid;
const DEAD = 2 ** 22 + 12345; // above pid_max on macOS (99998) and Linux (at most 2^22): never a live process

interface RunFixture {
  id?: string;
  mode?: string;
  status?: string;
  branch?: string;
}

/** A git repo with the harness, an initial commit on main, and work on `branch`. */
function repo(branch: string): string {
  const dir = deployHarness();
  git(dir, "init", "-q", "-b", "main");
  write(dir, "README.md", "# demo\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "-q", "-m", "init");
  git(dir, "checkout", "-q", "-b", branch);
  return dir;
}

/** What the driver writes: the run file in the run folder. */
function writeRun(dir: string, run: RunFixture): void {
  const id = run.id ?? RUN;
  write(
    dir,
    `.claude/tmp/runs/${id}/run.json`,
    JSON.stringify({ id, mode: "quick", status: "running", next: "implement", branch: "fix/login", ...run })
  );
}

/** What the driver writes: the lock, as src/run/store.ts acquireLock does. */
function writeLock(dir: string, id: string, pid: unknown): void {
  write(dir, ".claude/tmp/runs/lock", JSON.stringify({ id, pid }));
}

const env = (id: string) => ({ AGENT_STACK_RUN: id });
const NO_ENV = { AGENT_STACK_RUN: "" };
const codeEdit = (dir: string) => edit(join(dir, "src/app.ts"));

describe("spec-gate: quick-run bypass", () => {
  it("v04 AC-26: a live quick run on the current branch may edit code without a stage spec or plan", () => {
    const dir = repo("fix/login");
    writeRun(dir, {});
    writeLock(dir, RUN, LIVE);
    expect(runHook(dir, "spec-gate.sh", codeEdit(dir), env(RUN)).code).toBe(0);
  });

  it("v04 AC-26: the bypass comes before the stage checks", () => {
    // A stage branch whose spec is not merged and has no tasks.json: blocked without the driver.
    const dir = repo("A0-fix");
    expect(runHook(dir, "spec-gate.sh", codeEdit(dir), NO_ENV).stderr).toContain("not merged");
    writeRun(dir, { branch: "A0-fix" });
    writeLock(dir, RUN, LIVE);
    expect(runHook(dir, "spec-gate.sh", codeEdit(dir), env(RUN)).code).toBe(0);
  });

  it("v04 AC-26: without AGENT_STACK_RUN there is no bypass", () => {
    const dir = repo("fix/login");
    writeRun(dir, {});
    writeLock(dir, RUN, LIVE);
    const r = runHook(dir, "spec-gate.sh", codeEdit(dir), NO_ENV);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("not on a stage branch");
  });

  it.each(["r-2026111-120000", "r-20261118-120000x", "x-20261118-120000", "../r-20261118-120000", "r-20261118-120000\n"])(
    "v04 AC-26: a malformed run id opens nothing, even with matching files: %j",
    (id) => {
      const dir = repo("fix/login");
      const clean = id.replace(/[^A-Za-z0-9-]/g, "") || "bad";
      writeRun(dir, { id: clean });
      writeLock(dir, id, LIVE);
      expect(runHook(dir, "spec-gate.sh", codeEdit(dir), env(id)).code).toBe(2);
    }
  );

  it("v04 AC-26: a dead driver pid opens nothing (interrupted run)", () => {
    const dir = repo("fix/login");
    writeRun(dir, {});
    writeLock(dir, RUN, DEAD);
    expect(runHook(dir, "spec-gate.sh", codeEdit(dir), env(RUN)).code).toBe(2);
  });

  it.each([0, -1, "123", 1.5, null])("v04 AC-26: a lock pid that is not a positive integer opens nothing: %j", (pid) => {
    // kill -0 0 and kill -0 -1 succeed in bash (process group / all processes): they must never count as live.
    const dir = repo("fix/login");
    writeRun(dir, {});
    writeLock(dir, RUN, pid);
    expect(runHook(dir, "spec-gate.sh", codeEdit(dir), env(RUN)).code).toBe(2);
  });

  it("v04 AC-26: a run on another branch opens nothing", () => {
    const dir = repo("fix/login");
    writeRun(dir, { branch: "fix/other" });
    writeLock(dir, RUN, LIVE);
    expect(runHook(dir, "spec-gate.sh", codeEdit(dir), env(RUN)).code).toBe(2);
  });

  it("v04 AC-26: a detached HEAD opens nothing", () => {
    const dir = repo("fix/login");
    git(dir, "checkout", "-q", "--detach");
    writeRun(dir, {});
    writeLock(dir, RUN, LIVE);
    expect(runHook(dir, "spec-gate.sh", codeEdit(dir), env(RUN)).code).toBe(2);
  });

  it.each(["waiting", "interrupted", "done", "cancelled"])("v04 AC-26: a run with status %s opens nothing", (status) => {
    const dir = repo("fix/login");
    writeRun(dir, { status });
    writeLock(dir, RUN, LIVE);
    expect(runHook(dir, "spec-gate.sh", codeEdit(dir), env(RUN)).code).toBe(2);
  });

  it("v04 AC-26: a task-mode run does not bypass spec-gate", () => {
    const dir = repo("fix/login");
    writeRun(dir, { mode: "task" });
    writeLock(dir, RUN, LIVE);
    expect(runHook(dir, "spec-gate.sh", codeEdit(dir), env(RUN)).code).toBe(2);
  });

  it("v04 AC-26: a lock naming another run opens nothing", () => {
    const dir = repo("fix/login");
    writeRun(dir, {});
    writeRun(dir, { id: OTHER });
    writeLock(dir, OTHER, LIVE);
    expect(runHook(dir, "spec-gate.sh", codeEdit(dir), env(RUN)).code).toBe(2);
  });

  it("v04 AC-26: no lock, or no run file, opens nothing", () => {
    const noLock = repo("fix/login");
    writeRun(noLock, {});
    expect(runHook(noLock, "spec-gate.sh", codeEdit(noLock), env(RUN)).code).toBe(2);
    const noRun = repo("fix/login");
    writeLock(noRun, RUN, LIVE);
    expect(runHook(noRun, "spec-gate.sh", codeEdit(noRun), env(RUN)).code).toBe(2);
  });
});

describe("guard-file: run folder", () => {
  const dir = deployHarness();

  it.each([
    ".claude/tmp/runs/lock",
    `.claude/tmp/runs/${RUN}/run.json`,
    `.claude/tmp/runs/${RUN}/calls/1-implement.json`,
    `.Claude/TMP/Runs/${RUN}/run.json`,
    `src/../.claude/tmp/runs/lock`,
    `.claude/./tmp//runs/lock`,
  ])("v04 AC-27: blocks Edit and Write to %s", (rel) => {
    for (const input of [edit(join(dir, rel)), writeTool(join(dir, rel), "{}")]) {
      const r = runHook(dir, "guard-file.sh", input);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("only the driver");
    }
  });

  it("v04 AC-27: blocks even while a driver run is live", () => {
    const live = repo("fix/login");
    writeRun(live, {});
    writeLock(live, RUN, LIVE);
    expect(runHook(live, "guard-file.sh", writeTool(join(live, ".claude/tmp/runs/lock"), "{}"), env(RUN)).code).toBe(2);
  });

  it("v04 AC-27: reading the run folder, and writing next to it, stay allowed", () => {
    expect(runHook(dir, "guard-file.sh", readTool(join(dir, `.claude/tmp/runs/${RUN}/run.json`))).code).toBe(0);
    for (const rel of [".claude/tmp/A0/notes.md", ".claude/tmp/runs.md", ".claude/tmp/runsheet/x.md"]) {
      expect(runHook(dir, "guard-file.sh", writeTool(join(dir, rel))).code).toBe(0);
    }
  });
});

describe("guard-file: symlinks are followed", () => {
  /** A link at `rel` pointing at `target` (as written: relative to the link's folder, or absolute). */
  function link(dir: string, rel: string, target: string): string {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    symlinkSync(target, full);
    return full;
  }

  it.each([
    ["notes/l.json", "../.claude/tmp/runs/lock", "only the driver"],
    ["notes/h.sh", "../.claude/hooks/x.sh", "enforcement layer"],
    ["notes/s.json", "../.claude/settings.json", "enforcement layer"],
    ["notes/b", "../.claude/bin/verify", "enforcement layer"],
  ])("v04 AC-27: a Write or Edit through %s -> %s is blocked", (rel, target, why) => {
    const dir = deployHarness();
    const path = link(dir, rel, target);
    for (const input of [edit(path), writeTool(path, "{}")]) {
      const r = runHook(dir, "guard-file.sh", input);
      expect(r.code).toBe(2);
      expect(r.stderr).toContain(why);
    }
  });

  it("v04 AC-27: a chain of links, an absolute target and a link reached through ../ are followed", () => {
    const dir = deployHarness();
    link(dir, "notes/b.json", join(dir, ".claude/tmp/runs/lock"));
    link(dir, "notes/a.json", "b.json");
    for (const p of [join(dir, "notes/a.json"), join(dir, "notes/new/../a.json"), "notes/a.json"]) {
      expect(runHook(dir, "guard-file.sh", writeTool(p, "{}")).code, p).toBe(2);
    }
  });

  it("v04 AC-27: a link to a normal file is allowed", () => {
    const dir = deployHarness();
    write(dir, "src/app.ts", "export {};\n");
    const path = link(dir, "notes/app.ts", "../src/app.ts");
    expect(runHook(dir, "guard-file.sh", writeTool(path, "x")).code).toBe(0);
  });

  it("v04 AC-27: a link loop does not hang the hook", () => {
    const dir = deployHarness();
    link(dir, "notes/x", "y");
    link(dir, "notes/y", "x");
    expect(runHook(dir, "guard-file.sh", writeTool(join(dir, "notes/x"), "x")).code).toBe(0);
  });
});

describe("spec-gate: codeBy driver (AC-71)", () => {
  /** A repo whose stage spec and plan would let code through, so only codeBy can block. */
  function open(codeBy: unknown, specGate = "off"): string {
    const dir = repo("fix/login");
    patchGates(dir, { codeBy, specGate });
    return dir;
  }

  it("v04 AC-71: with codeBy driver, a chat edit of code is denied even with specGate off; docs stay open", () => {
    const dir = open("driver");
    const r = runHook(dir, "spec-gate.sh", codeEdit(dir), NO_ENV);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("codeBy is \"driver\"");
    expect(r.stderr).toContain("/drive");
    expect(runHook(dir, "spec-gate.sh", edit(join(dir, "docs/notes.md")), NO_ENV).code).toBe(0);
    expect(runHook(dir, "spec-gate.sh", writeTool(join(dir, "src/new.ts")), NO_ENV).code).toBe(2);
  });

  it("v04 AC-71: a live driver call of any mode on its branch may edit code", () => {
    const dir = open("driver");
    writeRun(dir, { mode: "task" });
    writeLock(dir, RUN, LIVE);
    expect(runHook(dir, "spec-gate.sh", codeEdit(dir), env(RUN)).code).toBe(0);
    // The same run, interrupted: closed again.
    writeLock(dir, RUN, DEAD);
    expect(runHook(dir, "spec-gate.sh", codeEdit(dir), env(RUN)).code).toBe(2);
  });

  it("v04 AC-71: codeBy missing or anyone changes nothing; an unknown value is read as driver and says so", () => {
    expect(runHook(open("anyone"), "spec-gate.sh", codeEdit(open("anyone")), NO_ENV).code).toBe(0);
    const unset = repo("fix/login");
    patchGates(unset, { specGate: "off" });
    expect(runHook(unset, "spec-gate.sh", codeEdit(unset), NO_ENV).code).toBe(0);
    const typo = open("drivr");
    const r = runHook(typo, "spec-gate.sh", codeEdit(typo), NO_ENV);
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("\"drivr\" is unknown");
  });

  it("v04 AC-71: in a repo with no commits codeBy does not apply yet, and says so", () => {
    const dir = deployHarness();
    git(dir, "init", "-q", "-b", "main");
    patchGates(dir, { codeBy: "driver" });
    const r = runHook(dir, "spec-gate.sh", codeEdit(dir), NO_ENV);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).systemMessage).toContain("starts after the first commit");
  });
});
