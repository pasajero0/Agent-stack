import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupProjects, git, write } from "../hooks/fixture.js";
import { abortOnSignals, cancelRun, resumeRun, startRun, statusRun } from "../../src/run/engine/index.js";
import { listRuns, readLock, writeRun } from "../../src/run/store.js";
import { BRANCH, DEAD_PID, DESC, impl, makeFakeExecutable, repo, sh, text } from "./engine-fixture.js";

beforeAll(makeFakeExecutable);
afterEach(() => cleanupProjects());

describe("gates, resume and the lock", () => {
  it("v04 AC-29: without a terminal or gate input the gate is recorded, --resume printed, exit 3; resume answers it", async () => {
    const r = repo();
    r.script([impl({ writes: { "README.md": "# demo\nfixed\n" } })]);
    expect(await startRun({ ...r.opts(), mode: "quick", description: DESC })).toBe(3);
    let run = r.run();
    expect(run.status).toBe("waiting");
    expect(run.next).toBe("gate:accept");
    expect(text(r)).toContain(`agent-stack run --resume ${run.id}`);
    expect(readLock(r.dir)?.id).toBe(run.id);

    expect(await resumeRun({ ...r.opts({ gate: ["a"] }) })).toBe(0);
    run = r.run();
    expect(run.status).toBe("finished");
    expect(readLock(r.dir)).toBeNull();
  });

  it("v04 AC-28: --cancel of a waiting run marks it cancelled, removes the lock and keeps the branch", async () => {
    const r = repo();
    r.script([impl({ writes: { "README.md": "# demo\nfixed\n" } })]);
    expect(await startRun({ ...r.opts(), mode: "quick", description: DESC })).toBe(3);
    const head = sh(r.dir, "rev-parse", "HEAD");
    expect(await cancelRun({ ...r.opts() })).toBe(0);
    expect(r.run().status).toBe("cancelled");
    expect(readLock(r.dir)).toBeNull();
    expect(sh(r.dir, "rev-parse", BRANCH)).toBe(head);
    expect(text(r)).toContain(BRANCH);
  });

  it("v04 AC-28: --cancel removes a lock whose run folder is missing (AC-55)", async () => {
    const r = repo();
    write(r.dir, ".claude/tmp/runs/lock", JSON.stringify({ id: "r-20260101-000000", pid: DEAD_PID }));
    expect(await cancelRun({ ...r.opts() })).toBe(0);
    expect(readLock(r.dir)).toBeNull();
  });

  it("v04 AC-23: --status prints id, mode, status, next, branch, attempts, calls, cost and fuse, changing nothing", async () => {
    const r = repo();
    r.script([impl({ writes: { "README.md": "# demo\nfixed\n" } })]);
    expect(await startRun({ ...r.opts(), mode: "quick", description: DESC })).toBe(3);
    const run = r.run();
    const file = join(r.dir, ".claude/tmp/runs", run.id, "run.json");
    const before = readFileSync(file, "utf8");
    r.out.length = 0;
    expect(await statusRun({ ...r.opts() })).toBe(0);
    const t = text(r);
    for (const want of [run.id, "quick", "waiting", "gate:accept", BRANCH, "Q1", "attempts 1", "over 1 calls", "$0.01", "calls 40"]) {
      expect(t).toContain(want);
    }
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("v04 AC-1: a new run while a lock exists removes its own folder and names the locked run (AC-50)", async () => {
    const r = repo();
    r.script([impl({ writes: { "README.md": "# demo\nfixed\n" } })]);
    expect(await startRun({ ...r.opts(), mode: "quick", description: DESC })).toBe(3);
    const first = r.run().id;
    r.out.length = 0;
    expect(await startRun({ ...r.opts(), mode: "quick", description: "another fix" })).toBe(1);
    expect(listRuns(r.dir)).toEqual([first]);
    const t = text(r);
    for (const want of [first, `--resume ${first}`, `--status ${first}`, `--cancel ${first}`]) expect(t).toContain(want);
    expect(sh(r.dir, "branch", "--list", "quick/another-fix")).toBe("");
  });

  it("v04 AC-50: a live run refuses --resume and --cancel (stop it first)", async () => {
    const r = repo();
    r.script([{ stdout: "not json", exit: 1 }]);
    expect(await startRun({ ...r.opts({ pid: process.pid }), mode: "quick", description: DESC })).toBe(1);
    r.out.length = 0;
    expect(await resumeRun({ ...r.opts() })).toBe(1);
    expect(text(r)).toMatch(/live/);
    r.out.length = 0;
    expect(await cancelRun({ ...r.opts() })).toBe(1);
    expect(text(r)).toContain("stop it first (Ctrl-C)");
    expect(r.run().status).toBe("running");
  });

  it("v04 AC-51: an abort stops the Claude child, writes the run file and exits 1; resume continues it (AC-30)", async () => {
    const r = repo();
    r.script([
      { ...impl({ writes: { "late.txt": "x\n" } }), sleepMs: 5000 },
      impl({ writes: { "README.md": "# demo\nfixed\n" } }),
    ]);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 800);
    const started = Date.now();
    expect(await startRun({ ...r.opts({ signal: ac.signal }), mode: "quick", description: DESC })).toBe(1);
    expect(Date.now() - started).toBeLessThan(4000);
    let run = r.run();
    expect(run.status).toBe("running");
    expect(run.next).toBe("implement:Q1");
    expect(existsSync(join(r.dir, "late.txt"))).toBe(false);

    const code = await resumeRun({ ...r.opts({ gate: ["a"] }) });
    expect(code, text(r)).toBe(0);
    run = r.run();
    expect(run.tasks[0]?.attempts).toBe(1);
    expect(run.tasks[0]?.lastFeedback).toContain("git status");
  });

  it("v04 AC-52: --resume on a branch other than the run's refuses and names the branch", async () => {
    const r = repo();
    r.script([impl({ writes: { "README.md": "# demo\nfixed\n" } })]);
    expect(await startRun({ ...r.opts(), mode: "quick", description: DESC })).toBe(3);
    git(r.dir, "checkout", "-q", "main");
    r.out.length = 0;
    expect(await resumeRun({ ...r.opts({ gate: ["a"] }) })).toBe(1);
    expect(text(r)).toContain(BRANCH);
    expect(r.run().status).toBe("waiting");
  });

  it("v04 AC-53: a missing, absent or finished run is reported; --resume and --cancel exit 1, --status exits 0", async () => {
    const r = repo();
    expect(await resumeRun({ ...r.opts() })).toBe(1);
    expect(await cancelRun({ ...r.opts() })).toBe(1);
    expect(await resumeRun({ ...r.opts(), id: "r-20990101-000000" })).toBe(1);
    expect(text(r)).toContain("r-20990101-000000");
    expect(await statusRun({ ...r.opts() })).toBe(0);

    r.script([impl({})]);
    expect(await startRun({ ...r.opts({ gate: ["a"] }), mode: "quick", description: DESC })).toBe(0);
    const id = r.run().id;
    r.out.length = 0;
    expect(await resumeRun({ ...r.opts(), id })).toBe(1);
    expect(await cancelRun({ ...r.opts(), id })).toBe(1);
    expect(text(r)).toContain("finished");
    r.out.length = 0;
    expect(await statusRun({ ...r.opts(), id })).toBe(0);
    expect(text(r)).toContain(id);
  });
});

/** Whether any process of group `pgid` is still alive. */
function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch {
    return false;
  }
}

async function groupGone(pgid: number): Promise<boolean> {
  for (let i = 0; i < 40 && groupAlive(pgid); i++) await new Promise((res) => setTimeout(res, 50));
  return !groupAlive(pgid);
}

describe("kills and resume after a side effect", () => {
  it("v04 AC-51: an abort during a check kills the check's process group and leaves the step interrupted", async () => {
    const r = repo({ test: "echo $$ > .git/check.pid; sleep 30; true" });
    r.script([]);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 800);
    const started = Date.now();
    expect(await startRun({ ...r.opts({ signal: ac.signal }), mode: "quick", description: DESC })).toBe(1);
    expect(Date.now() - started).toBeLessThan(4000);
    const pgid = Number(readFileSync(join(r.dir, ".git/check.pid"), "utf8"));
    expect(pgid).toBeGreaterThan(0);
    expect(await groupGone(pgid)).toBe(true);
    const run = r.run();
    expect(run.status).toBe("running");
    expect(run.next).toBe("base-check");
    expect(text(r)).toContain("Interrupted at base-check");
  });

  it("v04 AC-51: SIGINT through abortOnSignals reaches the current Claude call", async () => {
    const r = repo();
    r.script([{ ...impl({ writes: { "late.txt": "x\n" } }), sleepMs: 5000 }]);
    const listeners = process.listenerCount("SIGINT");
    const sig = abortOnSignals();
    try {
      expect(process.listenerCount("SIGINT")).toBe(listeners + 1);
      setTimeout(() => process.emit("SIGINT"), 800);
      const started = Date.now();
      expect(await startRun({ ...r.opts({ signal: sig.signal }), mode: "quick", description: DESC })).toBe(1);
      expect(Date.now() - started).toBeLessThan(4000);
      expect(sig.signal.aborted).toBe(true);
    } finally {
      sig.dispose();
    }
    expect(process.listenerCount("SIGINT")).toBe(listeners);
    expect(existsSync(join(r.dir, "late.txt"))).toBe(false);
    expect(r.run().next).toBe("implement:Q1");
    expect(text(r)).toContain("Interrupted at implement:Q1");
  });

  it("v04 AC-55: a kill after the task commit is resumed by recording HEAD, without a second commit", async () => {
    const r = repo();
    r.script([impl({ writes: { "README.md": "# demo\nfixed\n" } })]);
    expect(await startRun({ ...r.opts(), mode: "quick", description: DESC })).toBe(3);
    // Rebuild the moment of the kill: the commit is made by hand with the expected header, next still commit:Q1.
    git(r.dir, "reset", "-q", "--soft", "main");
    git(r.dir, "commit", "-q", "-m", "fix: fix the README line");
    const run = r.run();
    const task = run.tasks[0];
    if (!task) throw new Error("no task Q1");
    task.commit = null;
    run.next = "commit:Q1";
    run.status = "running";
    writeRun(r.dir, run);

    const code = await resumeRun({ ...r.opts({ gate: ["a"] }) });
    expect(code, text(r)).toBe(0);
    expect(r.run().tasks[0]?.commit).toBe(sh(r.dir, "rev-parse", "HEAD"));
    expect(sh(r.dir, "rev-list", "--count", `main..${BRANCH}`)).toBe("1");
  });

  it("v04 AC-55: createdBranches lists a branch once it exists; a missing run branch is created from baseCommit on resume", async () => {
    const r = repo({ test: "test -f .git/base-ok" });
    expect(await startRun({ ...r.opts(), mode: "quick", description: DESC })).toBe(1);
    const run = r.run();
    expect(run.createdBranches).toEqual([BRANCH]);
    // Rebuild a kill between the run file and the branch: the branch is gone, the tree is clean.
    git(r.dir, "checkout", "-q", "main");
    git(r.dir, "branch", "-D", BRANCH);
    run.createdBranches = [];
    writeRun(r.dir, run);
    write(r.dir, ".git/base-ok", "1");

    write(r.dir, "stray.txt", "x");
    r.out.length = 0;
    expect(await resumeRun({ ...r.opts() })).toBe(1);
    expect(text(r)).toContain("stray.txt");
    expect(sh(r.dir, "branch", "--list", BRANCH)).toBe("");
    git(r.dir, "clean", "-fq", "--", "stray.txt");

    r.script([impl({ writes: { "README.md": "# demo\nfixed\n" } })]);
    const code = await resumeRun({ ...r.opts({ gate: ["a"] }) });
    expect(code, text(r)).toBe(0);
    expect(r.run().createdBranches).toEqual([BRANCH]);
    expect(sh(r.dir, "branch", "--show-current")).toBe(BRANCH);
    expect(sh(r.dir, "rev-list", "--count", `main..${BRANCH}`)).toBe("1");
  });
});
