import { describe, expect, it } from "vitest";
import { runTime, sumTimes } from "../../src/run/stats/time.js";
import type { RunFile, StepTime } from "../../src/run/types.js";

const NOW = new Date("2026-01-01T00:10:00Z");
const e = (step: string, start: string, end: string | null): StepTime => ({ step, start, end }) as StepTime;

function run(over: Partial<RunFile> = {}): RunFile {
  return {
    id: "r1", description: "d", mode: "task", specFlow: "merge", specApproved: null, status: "finished",
    next: "gate:accept", returnTo: null, limitReason: null, proposal: null, stage: null, stagePrefill: null,
    size: null, branch: "b", baseCommit: null, tasks: [], createdBranches: [], gates: [], answers: [],
    humanDecisions: [], costUsd: 0, costUnknownCalls: 0, calls: 0, fuse: "off", card: null, steps: [],
    estimateSec: null, ...over,
  } as RunFile;
}

const closed = [e("implement:T1", "2026-01-01T00:00:00Z", "2026-01-01T00:01:00Z"), e("gate:accept", "2026-01-01T00:01:00Z", "2026-01-01T00:03:00Z")];

describe("run stats time", () => {
  it("stats1 AC-6: gate entries are waiting, others work; cost from the run file", () => {
    const t = runTime(run({ steps: closed, costUsd: 1.5 }), false, NOW);
    expect(t).toMatchObject({ workSec: 60, waitSec: 120, costUsd: 1.5, costUnknownCalls: 0, warnings: [] });
  });

  it("stats1 AC-6: an open entry counts to now when the run is live", () => {
    const t = runTime(run({ status: "running", steps: [e("implement:T1", "2026-01-01T00:08:00Z", null)] }), true, NOW);
    expect(t.workSec).toBe(120);
    expect(t.warnings).toEqual([]);
  });

  it("stats1 AC-6: the last open gate entry of a waiting run counts to now", () => {
    const t = runTime(run({ status: "waiting", steps: [e("gate:accept", "2026-01-01T00:05:00Z", null)] }), false, NOW);
    expect(t.waitSec).toBe(300);
    expect(t.warnings).toEqual([]);
  });

  it("stats1 AC-6: totals sum runs with steps and count runs without", () => {
    const a = runTime(run({ steps: closed, costUsd: 1 }), false, NOW);
    const b = runTime(run({ id: "r2", steps: [], costUsd: 2, costUnknownCalls: 2 }), false, NOW);
    expect(sumTimes([a, b])).toMatchObject({ workSec: 60, waitSec: 120, costUsd: 3, costUnknownCalls: 2, runsWithoutTimes: 1 });
  });

  it("stats1 AC-16: missing or empty steps give null times", () => {
    const t = runTime(run({ steps: [] }), false, NOW);
    expect(t.workSec).toBeNull();
    expect(t.waitSec).toBeNull();
    const u = runTime(run({ steps: undefined as unknown as StepTime[] }), false, NOW);
    expect(u.workSec).toBeNull();
  });

  it("stats1 AC-16: another open entry counts 0 with a warning", () => {
    const t = runTime(run({ id: "r9", status: "finished", steps: [e("implement:T1", "2026-01-01T00:00:00Z", null)] }), false, NOW);
    expect(t.workSec).toBe(0);
    expect(t.warnings).toEqual(["r9: step implement:T1 has no end; counted as 0"]);
  });

  it("stats1 AC-16: an open gate entry that is not last in a waiting run warns", () => {
    const steps = [e("gate:accept", "2026-01-01T00:00:00Z", null), e("implement:T1", "2026-01-01T00:01:00Z", "2026-01-01T00:02:00Z")];
    const t = runTime(run({ id: "r8", status: "waiting", steps }), false, NOW);
    expect(t.waitSec).toBe(0);
    expect(t.warnings).toEqual(["r8: step gate:accept has no end; counted as 0"]);
  });

  it("stats1 AC-21: unknown cost calls are kept", () => {
    const t = runTime(run({ steps: closed, costUnknownCalls: 3 }), false, NOW);
    expect(t.costUnknownCalls).toBe(3);
  });

  it("stats1 AC-24: the last open gate entry of a cancelled run counts 0, no warning", () => {
    const t = runTime(run({ status: "cancelled", steps: [closed[0]!, e("gate:accept", "2026-01-01T00:01:00Z", null)] }), false, NOW);
    expect(t.waitSec).toBe(0);
    expect(t.workSec).toBe(60);
    expect(t.warnings).toEqual([]);
  });
});
