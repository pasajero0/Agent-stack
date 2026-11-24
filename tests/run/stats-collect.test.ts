import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectStats } from "../../src/run/stats/collect.js";
import type { RunFile } from "../../src/run/types.js";

const NOW = new Date("2026-01-01T00:10:00Z");
const DEAD_PID = 2 ** 30;

const OK_REVIEW = {
  type: "result", subtype: "success", is_error: false, num_turns: 2, total_cost_usd: 0.1,
  structured_output: { spec: "pass", quality: "pass", verifyProves: true, findings: [] },
};

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "stats-collect-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const runs = (): string => join(dir, ".claude", "tmp", "runs");

function run(id: string, over: Partial<RunFile> = {}): RunFile {
  return {
    id, description: "d", mode: "task", specFlow: "merge", specApproved: null, status: "finished",
    next: "gate:accept", returnTo: null, limitReason: null, proposal: null, stage: null, stagePrefill: null,
    size: null, branch: "b", baseCommit: null, tasks: [], createdBranches: [], gates: [], answers: [],
    humanDecisions: [], costUsd: 0, costUnknownCalls: 0, calls: 0, fuse: "off", card: null, steps: [],
    estimateSec: null, ...over,
  } as RunFile;
}

function putRun(folder: string, body: unknown): string {
  const d = join(runs(), folder);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "run.json"), typeof body === "string" ? body : JSON.stringify(body));
  return d;
}

function putCall(folder: string, name: string, body: unknown): void {
  const d = join(runs(), folder, "calls");
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, name), typeof body === "string" ? body : JSON.stringify(body));
}

function putLock(id: string, pid: number): void {
  mkdirSync(runs(), { recursive: true });
  writeFileSync(join(runs(), "lock"), JSON.stringify({ id, pid }));
}

const A = "r-20260101-000000";
const B = "r-20260102-000000";

describe("run stats collect", () => {
  it("stats1 AC-2: finished, cancelled and waiting show as the run file says, whatever the lock", () => {
    putRun(A, run(A, { status: "finished" }));
    putRun(B, run(B, { status: "cancelled" }));
    const C = "r-20260103-000000";
    putRun(C, run(C, { status: "waiting" }));
    putLock(A, process.pid);
    const s = collectStats(dir, NOW);
    expect(s.runs.map((r) => r.status)).toEqual(["finished", "cancelled", "waiting"]);
  });

  it("stats1 AC-2: running shows only when the lock names this run with a live pid", () => {
    putRun(A, run(A, { status: "running" }));
    putLock(A, process.pid);
    expect(collectStats(dir, NOW).runs[0]?.status).toBe("running");
  });

  it("stats1 AC-12: a running run with no lock, a bad lock, another run's lock or a dead pid is interrupted", () => {
    putRun(A, run(A, { status: "running" }));
    expect(collectStats(dir, NOW).runs[0]?.status).toBe("interrupted");
    writeFileSync(join(runs(), "lock"), "{not json");
    expect(collectStats(dir, NOW).runs[0]?.status).toBe("interrupted");
    putLock(B, process.pid);
    expect(collectStats(dir, NOW).runs[0]?.status).toBe("interrupted");
    putLock(A, DEAD_PID);
    expect(collectStats(dir, NOW).runs[0]?.status).toBe("interrupted");
  });

  it("stats1 AC-12: an interrupted run is not live: its last call counts as missing", () => {
    putRun(A, run(A, { status: "running", calls: 1 }));
    const s = collectStats(dir, NOW);
    expect(s.runs[0]?.calls.missing).toBe(1);
    expect(s.warnings).toEqual([`${A}: calls/1-*.json is missing`]);
  });

  it("stats1 AC-9: skips bad folders with their reasons, sorted by folder name, and counts the rest", () => {
    putRun(A, run(A));
    mkdirSync(join(runs(), "not-a-run"), { recursive: true });
    mkdirSync(join(runs(), "r-20260105-000000"), { recursive: true });
    putRun("r-20260104-000000", "{oops");
    putRun("r-20260103-000000", { ...run("r-20260103-000000"), status: "bogus" });
    const s = collectStats(dir, NOW);
    expect(s.runs.map((r) => r.run.id)).toEqual([A]);
    expect(s.skipped).toEqual([
      { id: "not-a-run", reason: "not a run id" },
      { id: "r-20260103-000000", reason: "run.json is malformed: status" },
      { id: "r-20260104-000000", reason: "run.json is malformed: not JSON" },
      { id: "r-20260105-000000", reason: "run.json is missing" },
    ]);
    expect(s.folders).toBe(5);
  });

  it("stats1 AC-9: an unreadable run.json gives 'run.json is missing', with no path", () => {
    const d = putRun(A, run(A));
    // A directory named run.json cannot be read as a file, also as root.
    rmSync(join(d, "run.json"));
    mkdirSync(join(d, "run.json"));
    const C = "r-20260103-000000";
    const c = putRun(C, run(C));
    chmodSync(join(c, "run.json"), 0o000);
    const s = collectStats(dir, NOW);
    chmodSync(join(c, "run.json"), 0o644);
    expect(s.skipped[0]).toEqual({ id: A, reason: "run.json is missing" });
    if (process.getuid?.() !== 0) expect(s.skipped[1]).toEqual({ id: C, reason: "run.json is missing" });
  });

  it("stats1 AC-9: a folder name that is not a run id is never read", () => {
    putRun("not-a-run", run("not-a-run"));
    putRun("r-2026", run("r-2026"));
    const s = collectStats(dir, NOW);
    expect(s.runs).toEqual([]);
    expect(s.skipped).toEqual([
      { id: "not-a-run", reason: "not a run id" },
      { id: "r-2026", reason: "not a run id" },
    ]);
  });

  it("stats1 AC-18: plain files in the runs folder are passed over without skip or warning", () => {
    putRun(A, run(A));
    putLock(A, DEAD_PID);
    writeFileSync(join(runs(), "lock.123.tmp"), "x");
    writeFileSync(join(runs(), "lock.stale.1.2"), "x");
    const s = collectStats(dir, NOW);
    expect(s.runs).toHaveLength(1);
    expect(s.skipped).toEqual([]);
    expect(s.warnings).toEqual([]);
    expect(s.folders).toBe(1);
  });

  it("stats1 AC-18: no runs folder gives an empty model", () => {
    const s = collectStats(dir, NOW);
    expect(s).toMatchObject({ folders: 0, runs: [], skipped: [], warnings: [] });
    expect(s.totals.count.started).toBe(0);
  });

  it("stats1 AC-20: a live run counts as it is now, skips the call in progress, and shows running", () => {
    putRun(A, run(A, {
      status: "running", calls: 2, next: "implement:T1",
      tasks: [{ id: "T1", taskBase: null, attempts: 1, blockingCount: null, lastFeedback: null, checks: [], notes: [], allowedChanges: [], pendingChanges: [], commit: null }],
      steps: [{ step: "implement:T1", start: "2026-01-01T00:08:00Z", end: null }],
    }));
    putCall(A, "1-review.json", { argv: [], exitCode: 0, result: OK_REVIEW });
    putCall(A, "2-implement.json", "{half");
    putLock(A, process.pid);
    const s = collectStats(dir, NOW);
    const r = s.runs[0];
    expect(r?.status).toBe("running");
    expect(r?.count.started).toBe(1);
    expect(r?.time.workSec).toBe(120);
    expect(r?.calls.roles.review.outcomes.ok).toBe(1);
    expect(r?.calls.roles.implement.calls).toBe(0);
    expect(s.warnings).toEqual([]);
    expect(s.totals.byStatus.running).toBe(1);
  });

  it("stats1 AC-20: combines counts, times and calls; runs by id, warnings by run id then call number", () => {
    putRun(B, run(B, {
      calls: 3, costUsd: 1, steps: [{ step: "implement:T1", start: "2026-01-01T00:00:00Z", end: null }],
    }));
    putCall(B, "3-review.json", "{bad");
    putCall(B, "1-review.json", { argv: [], exitCode: 0, result: OK_REVIEW });
    putRun(A, run(A, { calls: 1, costUsd: 0.5, status: "cancelled" }));
    putCall(A, "1-review.json", { argv: [], exitCode: 0, result: OK_REVIEW });
    putCall(A, "notes.txt", "x");
    const s = collectStats(dir, NOW);
    expect(s.runs.map((r) => r.run.id)).toEqual([A, B]);
    expect(s.warnings).toEqual([
      `${A}: calls/notes.txt is not a call file`,
      `${B}: calls/2-*.json is missing`,
      `${B}: calls/3-review.json is unreadable: not JSON`,
      `${B}: step implement:T1 has no end; counted as 0`,
    ]);
    expect(s.totals.byStatus).toEqual({ finished: 1, cancelled: 1, waiting: 0, interrupted: 0, running: 0 });
    expect(s.totals.calls.roles.review.outcomes).toMatchObject({ ok: 2, unreadable: 1 });
    expect(s.totals.calls.missing).toBe(1);
    expect(s.totals.time.costUsd).toBe(1.5);
    expect(s.totals.time.runsWithoutTimes).toBe(1);
  });
});
