import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import { mkdirSync, rmSync, mkdtempSync, existsSync, readdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  newRunId,
  runDir,
  createRunDir,
  readRun,
  readRunStrict,
  writeRun,
  listRuns,
  acquireLock,
  takeOverLock,
  readLock,
  releaseLock,
  pidAlive,
  lockedRunState,
  type RunFs,
} from "../../src/run/store.js";
import { RunError } from "../../src/run/errors.js";
import type { RunFile, RunTask } from "../../src/run/types.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-stack-runstore-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const task = (over: Partial<RunTask> = {}): RunTask => ({
  id: "T1",
  taskBase: "abc123",
  attempts: 1,
  blockingCount: null,
  lastFeedback: null,
  checks: [{ cmd: "pnpm test", exit: 0, skipped: false }],
  notes: ["n"],
  allowedChanges: [],
  pendingChanges: [],
  commit: null,
  ...over,
});

const mk = (id: string, over: Partial<RunFile> = {}): RunFile => ({
  id,
  description: "d",
  mode: "task",
  status: "running",
  next: "clarify",
  returnTo: null,
  limitReason: null,
  proposal: null,
  stage: null,
  stagePrefill: null,
  size: null,
  branch: "main",
  baseCommit: null,
  tasks: [],
  createdBranches: [],
  gates: [],
  answers: [],
  humanDecisions: [],
  costUsd: 0,
  costUnknownCalls: 0,
  card: null,
  steps: [],
  estimateSec: null,
  calls: 0,
  fuse: { calls: 40 },
  ...over,
});

/** Creates the run folder and writes the run file, as a run start does. */
const start = (run: RunFile): RunFile => {
  createRunDir(dir, run.id);
  writeRun(dir, run);
  return run;
};

const runJson = (id: string) => join(runDir(dir, id), "run.json");
const lockFile = () => join(dir, ".claude", "tmp", "runs", "lock");
const DEAD_PID = 2 ** 22 + 12345;

describe("run id and run file", () => {
  it("newRunId is r-<yyyymmdd>-<hhmmss> from the injected date", () => {
    expect(newRunId(new Date(2026, 10, 18, 9, 5, 7))).toBe("r-20261118-090507");
  });

  it("v04 AC-3: writeRun is atomic: round-trips and leaves no temp file", () => {
    const run = start(mk("r-20261118-090507"));
    expect(readRun(dir, run.id)).toEqual(run);
    expect(readdirSync(runDir(dir, run.id))).toEqual(["run.json"]);
    writeRun(dir, { ...run, calls: 3 });
    expect(readRun(dir, run.id)?.calls).toBe(3);
    expect(readdirSync(runDir(dir, run.id))).toEqual(["run.json"]);
  });

  it("v04 AC-3: writeRun never writes run.json directly, only renames a temp file onto it", () => {
    const run = mk("r-20261118-000011");
    createRunDir(dir, run.id);
    const writes: string[] = [];
    const renames: [string, string][] = [];
    const spy: RunFs = {
      writeFileSync: (p, data) => {
        writes.push(String(p));
        fs.writeFileSync(p, data);
      },
      renameSync: (from, to) => {
        renames.push([String(from), String(to)]);
        fs.renameSync(from, to);
      },
    };
    writeRun(dir, run, spy);
    writeRun(dir, { ...run, calls: 2 }, spy);
    expect(writes).toHaveLength(2);
    expect(writes).not.toContain(runJson(run.id));
    expect(renames).toEqual(writes.map((w) => [w, runJson(run.id)]));
    expect(readRun(dir, run.id)?.calls).toBe(2);
  });

  it("writeRun does not create a missing run folder", () => {
    expect(() => writeRun(dir, mk("r-20261118-000013"))).toThrow();
    expect(existsSync(runDir(dir, "r-20261118-000013"))).toBe(false);
  });

  it("createRunDir is exclusive: an existing run folder is a RunError(1)", () => {
    createRunDir(dir, "r-20261118-000011");
    expect(existsSync(runDir(dir, "r-20261118-000011"))).toBe(true);
    let err: unknown;
    try {
      createRunDir(dir, "r-20261118-000011");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RunError);
    expect(err instanceof RunError && err.exitCode).toBe(1);
  });

  it("readRun is null for a missing or unparsable run; listRuns lists ids", () => {
    expect(readRun(dir, "r-20261118-000014")).toBeNull();
    mkdirSync(runDir(dir, "r-20261118-000015"), { recursive: true });
    writeFileSync(runJson("r-20261118-000015"), "{nope");
    expect(readRun(dir, "r-20261118-000015")).toBeNull();
    start(mk("r-20261118-000001"));
    start(mk("r-20261118-000002"));
    expect(listRuns(dir)).toEqual(["r-20261118-000001", "r-20261118-000002", "r-20261118-000015"]);
  });

  it("v04 AC-62: a run file without costUnknownCalls (written before it existed) reads it as 0", () => {
    const run = start(mk("r-20261118-000017"));
    const file = join(runDir(dir, run.id), "run.json");
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    delete raw.costUnknownCalls;
    writeFileSync(file, JSON.stringify(raw));
    expect(readRun(dir, run.id)?.costUnknownCalls).toBe(0);
  });

  it("readRun accepts a full run file with tasks, gates and every next form", () => {
    const full = mk("r-20261118-000016", {
      mode: "quick",
      status: "waiting",
      next: "review:T2",
      returnTo: "commit:T1",
      limitReason: "review-loop",
      proposal: { questions: [], size: "task" },
      stage: "A0",
      stagePrefill: "A9",
      size: "story",
      baseCommit: "deadbeef",
      tasks: [task(), task({ id: "T2", blockingCount: 2, lastFeedback: "fix", commit: "empty", checks: [] })],
      createdBranches: ["A0-x"],
      gates: [
        { gate: "gate:accept", at: "2026-11-18T00:00:00Z", decision: "a", comment: null },
        { gate: "gate:plan-approve", at: "2026-11-18T00:00:01Z", decision: "reject", comment: "c", planSha256: "a".repeat(64) },
        { gate: "gate:limit", at: "2026-11-18T00:00:02Z", decision: "retry", comment: "B", asked: ["A or B?"] },
      ],
      answers: [{ question: "q", answer: "a" }],
      humanDecisions: ["h"],
      costUsd: 1.25,
      costUnknownCalls: 2,
      calls: 7,
      fuse: "off",
    });
    start(full);
    expect(readRun(dir, full.id)).toEqual(full);
    for (const next of ["gate:limit", "base-check", "implement:T1", "checks:Q1", "commit:T10"] as const) {
      writeRun(dir, { ...full, next });
      expect(readRun(dir, full.id)?.next).toBe(next);
    }
  });

  it("v04 AC-66: a task from a run file written before allowedChanges reads with none; a non-string one is refused", () => {
    const run = mk("r-20261118-000017", { tasks: [task({ allowedChanges: ["deleted test file a.test.ts"] })] });
    createRunDir(dir, run.id);
    writeRun(dir, run);
    expect(readRun(dir, run.id)?.tasks[0]?.allowedChanges).toEqual(["deleted test file a.test.ts"]);
    const file = join(runDir(dir, run.id), "run.json");
    const { allowedChanges: _, pendingChanges: __, ...old } = task();
    writeFileSync(file, JSON.stringify({ ...run, tasks: [old] }));
    expect(readRun(dir, run.id)?.tasks[0]?.allowedChanges).toEqual([]);
    expect(readRun(dir, run.id)?.tasks[0]?.pendingChanges).toEqual([]);
    writeFileSync(file, JSON.stringify({ ...run, tasks: [{ ...old, allowedChanges: [1] }] }));
    expect(readRun(dir, run.id)).toBeNull();
  });

  it("readRun is null and readRunStrict names the field for a malformed run file", () => {
    const good = mk("r-20261118-000017");
    createRunDir(dir, good.id);
    const cases: [string, Record<string, unknown>][] = [
      ["status", { status: "done" }],
      ["mode", { mode: "fast" }],
      ["next", { next: "implement" }],
      ["next", { next: "implement:" }],
      ["next", { next: "deploy:T1" }],
      ["returnTo", { returnTo: "nowhere" }],
      ["limitReason", { limitReason: "tired" }],
      ["size", { size: "huge" }],
      ["stage", { stage: 3 }],
      ["stagePrefill", { stagePrefill: 3 }],
      ["stagePrefill", { stagePrefill: undefined }],
      ["baseCommit", { baseCommit: undefined }],
      ["proposal", { proposal: "text" }],
      ["costUsd", { costUsd: -1 }],
      ["costUnknownCalls", { costUnknownCalls: -1 }],
      ["calls", { calls: 1.5 }],
      ["fuse", { fuse: { calls: 0 } }],
      ["fuse", { fuse: "on" }],
      ["createdBranches", { createdBranches: ["a", 1] }],
      ["humanDecisions", { humanDecisions: "x" }],
      ["gates", { gates: [{ gate: "g", at: "t", decision: "d" }] }],
      ["gates.planSha256", { gates: [{ gate: "g", at: "t", decision: "d", comment: null, planSha256: "abc" }] }],
      ["gates.asked", { gates: [{ gate: "g", at: "t", decision: "d", comment: null, asked: [1] }] }],
      ["answers", { answers: [{ question: "q" }] }],
      ["tasks", { tasks: {} }],
      ["tasks[0].attempts", { tasks: [task({ attempts: -1 })] }],
      ["tasks[0].blockingCount", { tasks: [{ ...task(), blockingCount: "2" }] }],
      ["tasks[0].checks", { tasks: [{ ...task(), checks: [{ cmd: "x", exit: 0 }] }] }],
      ["tasks[0].notes", { tasks: [{ ...task(), notes: [1] }] }],
      ["tasks[1].commit", { tasks: [task(), { ...task(), commit: 5 }] }],
      ["tasks[0].id", { tasks: [{ ...task(), id: undefined }] }],
      ["id", { id: "r-20261118-000018" }],
    ];
    for (const [field, over] of cases) {
      writeFileSync(runJson(good.id), JSON.stringify({ ...good, ...over }));
      expect(readRun(dir, good.id), field).toBeNull();
      let err: unknown;
      try {
        readRunStrict(dir, good.id);
      } catch (e) {
        err = e;
      }
      expect(err, field).toBeInstanceOf(RunError);
      expect(err instanceof RunError && err.exitCode, field).toBe(1);
      expect(err instanceof Error && err.message, field).toBe(`run.json is malformed: ${field}`);
    }
    writeFileSync(runJson(good.id), JSON.stringify(good));
    expect(readRunStrict(dir, good.id)).toEqual(good);
  });

  it("readRunStrict is a RunError(1) for a missing or unparsable run file", () => {
    expect(() => readRunStrict(dir, "r-20261118-000019")).toThrow(RunError);
    createRunDir(dir, "r-20261118-000020");
    writeFileSync(runJson("r-20261118-000020"), "{nope");
    expect(() => readRunStrict(dir, "r-20261118-000020")).toThrow(/run\.json is malformed/);
  });
});

describe("lock", () => {
  it("v04 AC-50: acquireLock is exclusive and stores id and pid", () => {
    expect(acquireLock(dir, "r-20261118-000011", 111)).toBe(true);
    expect(acquireLock(dir, "r-20261118-000012", 222)).toBe(false);
    expect(readLock(dir)).toEqual({ id: "r-20261118-000011", pid: 111 });
    releaseLock(dir);
    expect(readLock(dir)).toBeNull();
    expect(acquireLock(dir, "r-20261118-000012", 222)).toBe(true);
  });

  it("v04 AC-50: acquireLock leaves only a complete lock and no temp files", () => {
    expect(acquireLock(dir, "r-20261118-000011", 111)).toBe(true);
    expect(acquireLock(dir, "r-20261118-000012", 222)).toBe(false);
    expect(readdirSync(join(dir, ".claude", "tmp", "runs"))).toEqual(["lock"]);
    expect(JSON.parse(readFileSync(lockFile(), "utf8"))).toEqual({ id: "r-20261118-000011", pid: 111 });
  });

  it("v04 AC-30: takeOverLock replaces the lock's pid and leaves no temp or stale file", () => {
    acquireLock(dir, "r-20261118-000011", DEAD_PID);
    takeOverLock(dir, "r-20261118-000011", process.pid, { id: "r-20261118-000011", pid: DEAD_PID });
    expect(readLock(dir)).toEqual({ id: "r-20261118-000011", pid: process.pid });
    expect(readdirSync(join(dir, ".claude", "tmp", "runs"))).toEqual(["lock"]);
  });

  it("v04 AC-30: two takeovers of the same stale lock: only the first wins, the second is a RunError(1)", () => {
    acquireLock(dir, "r-20261118-000011", DEAD_PID);
    const stale = readLock(dir);
    if (!stale) throw new Error("no lock");
    // Both resumers saw the same stale lock; the first takes it over.
    takeOverLock(dir, "r-20261118-000011", 111, stale);
    let err: unknown;
    try {
      takeOverLock(dir, "r-20261118-000011", 222, stale);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RunError);
    expect(err instanceof RunError && err.exitCode).toBe(1);
    expect(readLock(dir)).toEqual({ id: "r-20261118-000011", pid: 111 });
    expect(readdirSync(join(dir, ".claude", "tmp", "runs"))).toEqual(["lock"]);
  });

  it("v04 AC-30: takeOverLock with no lock left to take over is a RunError(1)", () => {
    expect(() => takeOverLock(dir, "r-20261118-000011", 111, { id: "r-20261118-000011", pid: DEAD_PID })).toThrow(RunError);
    expect(readLock(dir)).toBeNull();
  });

  it("readLock is null for a malformed lock or a pid that is not a positive integer", () => {
    for (const body of ["{nope", "", JSON.stringify({ id: "r-20261118-000011" }), JSON.stringify({ id: 1, pid: 5 })]) {
      mkdirSync(join(dir, ".claude", "tmp", "runs"), { recursive: true });
      writeFileSync(lockFile(), body);
      expect(readLock(dir), body).toBeNull();
    }
    for (const pid of [0, -1, 1.5, "123", null]) {
      writeFileSync(lockFile(), JSON.stringify({ id: "r-20261118-000011", pid }));
      expect(readLock(dir), String(pid)).toBeNull();
    }
  });

  it("pidAlive tells a live pid from a dead one and rejects 0, negatives and fractions", () => {
    expect(pidAlive(process.pid)).toBe(true);
    expect(pidAlive(DEAD_PID)).toBe(false);
    expect(pidAlive(0)).toBe(false);
    expect(pidAlive(-1)).toBe(false);
    expect(pidAlive(1.5)).toBe(false);
  });

  it("v04 AC-50: lockedRunState: none, live, waiting, interrupted", () => {
    expect(lockedRunState(dir)).toBe("none");
    start(mk("r-20261118-000011", { status: "running" }));
    acquireLock(dir, "r-20261118-000011", process.pid);
    expect(lockedRunState(dir)).toBe("live");
    writeRun(dir, mk("r-20261118-000011", { status: "waiting" }));
    expect(lockedRunState(dir)).toBe("waiting");
    writeRun(dir, mk("r-20261118-000011", { status: "running" }));
    releaseLock(dir);
    acquireLock(dir, "r-20261118-000011", DEAD_PID);
    expect(lockedRunState(dir)).toBe("interrupted");
  });

  it("v04 AC-55: a lock whose run folder is missing is an orphan", () => {
    acquireLock(dir, "r-20261118-000021", process.pid);
    expect(existsSync(runDir(dir, "r-20261118-000021"))).toBe(false);
    expect(lockedRunState(dir)).toBe("orphan");
  });

  it("a lock on a finished, cancelled or malformed run is stale", () => {
    start(mk("r-20261118-000011", { status: "finished" }));
    acquireLock(dir, "r-20261118-000011", process.pid);
    expect(lockedRunState(dir)).toBe("stale");
    writeRun(dir, mk("r-20261118-000011", { status: "cancelled" }));
    expect(lockedRunState(dir)).toBe("stale");
    writeFileSync(runJson("r-20261118-000011"), JSON.stringify({ ...mk("r-20261118-000011"), status: "bogus" }));
    expect(lockedRunState(dir)).toBe("stale");
  });

  it("a malformed lock is stale", () => {
    mkdirSync(join(dir, ".claude", "tmp", "runs"), { recursive: true });
    writeFileSync(lockFile(), "");
    expect(lockedRunState(dir)).toBe("stale");
    writeFileSync(lockFile(), JSON.stringify({ id: "r-20261118-000011", pid: 0 }));
    expect(lockedRunState(dir)).toBe("stale");
  });
});

describe("run id format", () => {
  const BAD = ["../../x", "r-1", "r-20261118-12000", "r-20261118-120000/..", "r-20261118-120000\n", "", "/tmp/x"];

  it.each(BAD)("runDir, createRunDir and readRunStrict reject %j with a RunError(1)", (id) => {
    for (const f of [() => runDir(dir, id), () => createRunDir(dir, id), () => readRunStrict(dir, id)]) {
      let err: unknown;
      try {
        f();
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(RunError);
      expect(err instanceof RunError && err.exitCode).toBe(1);
    }
    expect(readRun(dir, id)).toBeNull();
    expect(existsSync(join(dir, "x"))).toBe(false);
  });

  it.each(BAD)("readLock is null for a lock naming %j", (id) => {
    mkdirSync(join(dir, ".claude", "tmp", "runs"), { recursive: true });
    writeFileSync(lockFile(), JSON.stringify({ id, pid: process.pid }));
    expect(readLock(dir)).toBeNull();
    expect(lockedRunState(dir)).toBe("stale");
  });

  it("acquireLock and takeOverLock reject a malformed id", () => {
    expect(() => acquireLock(dir, "../x", 111)).toThrow(RunError);
    expect(() => takeOverLock(dir, "../x", 111, { id: "../x", pid: DEAD_PID })).toThrow(RunError);
  });
});
