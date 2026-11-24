/** Per-run time and cost for `run --stats` (spec stats1, AC-6, AC-16, AC-21, AC-24). */
import { times } from "../engine/timing.js";
import type { RunFile } from "../types.js";

export interface RunTime {
  /** Null when the run has no `steps` (AC-16). */
  workSec: number | null;
  waitSec: number | null;
  costUsd: number;
  costUnknownCalls: number;
  warnings: string[];
}

export interface TimeTotals {
  workSec: number;
  waitSec: number;
  costUsd: number;
  costUnknownCalls: number;
  runsWithoutTimes: number;
}

const isGate = (step: string): boolean => step.startsWith("gate:");

/** `live`: the run's process is alive now. An open entry counts to `now` only by the AC-6 rule. */
export function runTime(run: RunFile, live: boolean, now: Date): RunTime {
  const all = run.steps ?? [];
  const cost = { costUsd: run.costUsd, costUnknownCalls: run.costUnknownCalls };
  if (all.length === 0) return { workSec: null, waitSec: null, ...cost, warnings: [] };

  const warnings: string[] = [];
  const last = all.length - 1;
  // Open entries that do not count to now are dropped, so they add 0 seconds.
  const steps = all.filter((s, i) => {
    if (s.end !== null || live) return true;
    const isLastGate = i === last && isGate(s.step);
    if (isLastGate && run.status === "waiting") return true;
    if (!(isLastGate && run.status === "cancelled")) warnings.push(`${run.id}: step ${s.step} has no end; counted as 0`);
    return false;
  });
  const { workSec, waitSec } = times({ ...run, steps }, now);
  return { workSec, waitSec, ...cost, warnings };
}

export function sumTimes(list: RunTime[]): TimeTotals {
  const t: TimeTotals = { workSec: 0, waitSec: 0, costUsd: 0, costUnknownCalls: 0, runsWithoutTimes: 0 };
  for (const r of list) {
    if (r.workSec === null || r.waitSec === null) t.runsWithoutTimes++;
    else {
      t.workSec += r.workSec;
      t.waitSec += r.waitSec;
    }
    t.costUsd += r.costUsd;
    t.costUnknownCalls += r.costUnknownCalls;
  }
  return t;
}
