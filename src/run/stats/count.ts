/** Pure per-run counts for `run --stats` (spec stats1, AC-3, AC-4, AC-13, AC-14, AC-23). */
import type { LimitReason, RunFile } from "../types.js";

export type StopReason = LimitReason | "unknown";

export const STOP_REASONS: readonly StopReason[] = [
  "attempts",
  "blocked",
  "review-loop",
  "fuse",
  "decision",
  "test-conflict",
  "tests-changed",
  "unknown",
];

export interface RunCount {
  started: number;
  firstPass: number;
  /** Sum of `attempts` over started tasks. */
  iterations: number;
  /** firstPass / started, rounded to 2 places; null with no started task. */
  firstPassShare: number | null;
  /** iterations / started, rounded to 2 places; null with no started task. */
  iterationsPerTask: number | null;
  rejected: { specApprove: number; planApprove: number; accept: number };
  limitStops: number;
  stopsByReason: Record<StopReason, number>;
}

const round2 = (x: number): number => Math.round(x * 100) / 100;

function emptyReasons(): Record<StopReason, number> {
  return {
    attempts: 0,
    blocked: 0,
    "review-loop": 0,
    fuse: 0,
    decision: 0,
    "test-conflict": 0,
    "tests-changed": 0,
    unknown: 0,
  };
}

type Raw = Omit<RunCount, "firstPassShare" | "iterationsPerTask">;

function derive(c: Raw): RunCount {
  return {
    ...c,
    firstPassShare: c.started === 0 ? null : round2(c.firstPass / c.started),
    iterationsPerTask: c.started === 0 ? null : round2(c.iterations / c.started),
  };
}

export function countRun(run: RunFile): RunCount {
  const started = run.tasks.filter((t) => t.attempts >= 1);
  const firstPass = started.filter((t) => t.commit !== null && t.attempts === 1).length;
  const iterations = started.reduce((s, t) => s + t.attempts, 0);

  const rejected = { specApprove: 0, planApprove: 0, accept: 0 };
  const stopsByReason = emptyReasons();
  let limitStops = 0;
  for (const g of run.gates) {
    if (g.decision === "reject") {
      if (g.gate === "gate:spec-approve") rejected.specApprove++;
      else if (g.gate === "gate:plan-approve") rejected.planApprove++;
      else if (g.gate === "gate:accept") rejected.accept++;
    }
    if (g.gate === "gate:limit") {
      limitStops++;
      stopsByReason[g.reason ?? (g.decision === "raise" ? "fuse" : "unknown")]++;
    }
  }
  if (run.next === "gate:limit") {
    const last = run.gates[run.gates.length - 1];
    if (!(last && last.gate === "gate:limit" && last.decision === "cancel")) {
      limitStops++;
      stopsByReason[run.limitReason ?? "unknown"]++;
    }
  }
  return derive({ started: started.length, firstPass, iterations, rejected, limitStops, stopsByReason });
}

/** Sum the counts first, then divide (AC-3); never the mean of the runs' shares. */
export function sumCounts(counts: RunCount[]): RunCount {
  const sum: Raw = {
    started: 0,
    firstPass: 0,
    iterations: 0,
    rejected: { specApprove: 0, planApprove: 0, accept: 0 },
    limitStops: 0,
    stopsByReason: emptyReasons(),
  };
  for (const c of counts) {
    sum.started += c.started;
    sum.firstPass += c.firstPass;
    sum.iterations += c.iterations;
    sum.rejected.specApprove += c.rejected.specApprove;
    sum.rejected.planApprove += c.rejected.planApprove;
    sum.rejected.accept += c.rejected.accept;
    sum.limitStops += c.limitStops;
    for (const r of STOP_REASONS) sum.stopsByReason[r] += c.stopsByReason[r];
  }
  return derive(sum);
}
