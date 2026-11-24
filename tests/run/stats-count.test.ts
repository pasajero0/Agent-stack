import { describe, expect, it } from "vitest";
import { countRun, sumCounts } from "../../src/run/stats/count.js";
import type { GateRecord, LimitReason, RunFile, RunTask } from "../../src/run/types.js";

function task(id: string, attempts: number, commit: string | null): RunTask {
  return { id, taskBase: null, attempts, blockingCount: null, lastFeedback: null, checks: [], notes: [], allowedChanges: [], pendingChanges: [], commit };
}

function gate(g: string, decision: string, extra: Partial<GateRecord> = {}): GateRecord {
  return { gate: g, at: "2026-01-01T00:00:00Z", decision, comment: null, ...extra };
}

function run(over: Partial<RunFile> = {}): RunFile {
  return {
    id: "r1",
    description: "d",
    mode: "task",
    specFlow: "merge",
    specApproved: null,
    status: "running",
    next: "gate:accept",
    returnTo: null,
    limitReason: null,
    proposal: null,
    stage: null,
    stagePrefill: null,
    size: null,
    branch: "b",
    baseCommit: null,
    tasks: [],
    createdBranches: [],
    gates: [],
    answers: [],
    humanDecisions: [],
    costUsd: 0,
    costUnknownCalls: 0,
    calls: 0,
    fuse: "off",
    card: null,
    steps: [],
    estimateSec: null,
    ...over,
  };
}

describe("run stats count", () => {
  it("stats1 AC-3: counts started tasks, first pass, share and iterations", () => {
    const c = countRun(
      run({ tasks: [task("T1", 1, "abc"), task("T2", 3, "def"), task("T3", 1, null), task("T4", 0, null)] })
    );
    expect(c.started).toBe(3);
    expect(c.firstPass).toBe(1);
    expect(c.firstPassShare).toBe(0.33);
    expect(c.iterations).toBe(5);
    expect(c.iterationsPerTask).toBe(1.67);
  });

  it("stats1 AC-3: totals sum the counts first, then divide", () => {
    const a = countRun(run({ tasks: [task("T1", 1, "x")] }));
    const b = countRun(run({ tasks: [task("T1", 2, "x"), task("T2", 2, "y"), task("T3", 2, "z"), task("T4", 2, "w")] }));
    const t = sumCounts([a, b]);
    expect(t.started).toBe(5);
    expect(t.firstPass).toBe(1);
    expect(t.firstPassShare).toBe(0.2); // not the mean of 1 and 0
    expect(t.iterationsPerTask).toBe(1.8);
  });

  it("stats1 AC-4: counts rejected decisions at the three gates apart", () => {
    const c = countRun(
      run({
        gates: [
          gate("gate:spec-approve", "reject"),
          gate("gate:spec-approve", "reject"),
          gate("gate:spec-approve", "approve"),
          gate("gate:plan-approve", "reject"),
          gate("gate:accept", "reject"),
          gate("gate:accept", "reject"),
          gate("gate:accept", "reject"),
          gate("gate:answers", "reject"),
        ],
      })
    );
    expect(c.rejected).toEqual({ specApprove: 2, planApprove: 1, accept: 3 });
  });

  it("stats1 AC-4: counts recorded limit stops by reason, fuse on raise", () => {
    const c = countRun(
      run({
        gates: [
          gate("gate:limit", "retry", { reason: "decision" }),
          gate("gate:limit", "raise"),
          gate("gate:limit", "retry", { reason: "test-conflict" }),
        ],
      })
    );
    expect(c.limitStops).toBe(3);
    expect(c.stopsByReason.decision).toBe(1);
    expect(c.stopsByReason.fuse).toBe(1);
    expect(c.stopsByReason["test-conflict"]).toBe(1);
  });

  it("stats1 AC-4: an open stop counts with limitReason, or unknown when null", () => {
    const withReason = countRun(run({ next: "gate:limit", limitReason: "attempts", gates: [gate("gate:accept", "reject")] }));
    expect(withReason.limitStops).toBe(1);
    expect(withReason.stopsByReason.attempts).toBe(1);
    const noReason = countRun(run({ next: "gate:limit", limitReason: null }));
    expect(noReason.stopsByReason.unknown).toBe(1);
  });

  it("stats1 AC-13: no started task gives null share and iterations", () => {
    const c = countRun(run({ tasks: [task("T1", 0, null)] }));
    expect(c.started).toBe(0);
    expect(c.firstPass).toBe(0);
    expect(c.firstPassShare).toBeNull();
    expect(c.iterationsPerTask).toBeNull();
    const t = sumCounts([c]);
    expect(t.firstPassShare).toBeNull();
    expect(t.iterationsPerTask).toBeNull();
    expect(sumCounts([]).iterationsPerTask).toBeNull();
  });

  it("stats1 AC-14: a limit record without reason and not raise counts unknown", () => {
    const c = countRun(run({ gates: [gate("gate:limit", "retry"), gate("gate:limit", "cancel")] }));
    expect(c.limitStops).toBe(2);
    expect(c.stopsByReason.unknown).toBe(2);
    expect(c.stopsByReason.fuse).toBe(0);
    const reasons: LimitReason[] = ["attempts", "blocked", "review-loop", "fuse", "decision", "test-conflict", "tests-changed"];
    expect(Object.keys(c.stopsByReason).sort()).toEqual([...reasons, "unknown"].sort());
  });

  it("stats1 AC-23: a cancel record at gate:limit counts once, no open stop", () => {
    const c = countRun(
      run({ next: "gate:limit", limitReason: null, status: "cancelled", gates: [gate("gate:limit", "cancel")] })
    );
    expect(c.limitStops).toBe(1);
  });

  it("stats1 AC-23: run --cancel at gate:limit counts the open stop once with the kept reason", () => {
    const c = countRun(run({ next: "gate:limit", limitReason: "blocked", status: "cancelled" }));
    expect(c.limitStops).toBe(1);
    expect(c.stopsByReason.blocked).toBe(1);
  });
});
