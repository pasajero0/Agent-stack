/**
 * The time of a run: one entry per step, work and waiting time, and an estimate from earlier runs.
 * Spec: docs/specs/v04/SPEC.md, AC-81, run file `steps` and `estimateSec`.
 */
import { listRuns, readRun } from "../store.js";
import type { Next, RunFile } from "../types.js";
import { parseNext, type StepKind } from "./transitions.js";

export const isGate =(step: Next): boolean => step.startsWith("gate:");

/** A step starts: a new entry, unless the last one is this step and still open (a gate waits across processes). */
export function openStep(run: RunFile, step: Next, now: Date = new Date()): void {
  const last = run.steps.at(-1);
  if (last && last.step === step && last.end === null) return;
  run.steps.push({ step, start: now.toISOString(), end: null });
}

/** The open entry ends (the step ended, the gate decided, or the run was interrupted). */
export function closeStep(run: RunFile, now: Date = new Date()): void {
  const last = run.steps.at(-1);
  if (last && last.end === null) last.end = now.toISOString();
}

const seconds = (start: string, end: string | null, now: Date): number =>
  Math.max(0, Math.round(((end === null ? now.getTime() : Date.parse(end)) - Date.parse(start)) / 1000));

/** Work (steps that are not gates) and waiting (gates: the human's time), in seconds; an open entry counts to now. */
export function times(run: RunFile, now: Date = new Date()): { workSec: number; waitSec: number } {
  let workSec = 0;
  let waitSec = 0;
  for (const s of run.steps) {
    const d = seconds(s.start, s.end, now);
    if (isGate(s.step)) waitSec += d;
    else workSec += d;
  }
  return { workSec, waitSec };
}

export const clock = (sec: number): string => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, "0")}`;

const ESTIMATED: readonly StepKind[] = ["base-check", "implement", "checks", "review", "commit"];

/**
 * The mean time of each estimated step kind over the finished runs in this repo, and how many runs gave data.
 * Only ended entries count.
 */
function means(projectDir: string, exceptId: string): { mean: Partial<Record<StepKind, number>>; runs: number } {
  const sum: Partial<Record<StepKind, { total: number; n: number }>> = {};
  let runs = 0;
  for (const id of listRuns(projectDir)) {
    if (id === exceptId) continue;
    const run = readRun(projectDir, id);
    if (!run || run.status !== "finished") continue;
    let used = false;
    for (const s of run.steps) {
      if (s.end === null) continue;
      const { kind } = parseNext(s.step);
      if (!ESTIMATED.includes(kind)) continue;
      const cur = sum[kind] ?? { total: 0, n: 0 };
      cur.total += seconds(s.start, s.end, new Date());
      cur.n += 1;
      sum[kind] = cur;
      used = true;
    }
    if (used) runs += 1;
  }
  const mean: Partial<Record<StepKind, number>> = {};
  for (const k of ESTIMATED) {
    const v = sum[k];
    if (v && v.n > 0) mean[k] = v.total / v.n;
  }
  return { mean, runs };
}

/**
 * The estimated work time (AC-81): base-check once, then per task implement, checks, review and commit (quick
 * mode: no review, which runs only for a large diff). Null when no earlier run has implement entries.
 */
export function estimate(projectDir: string, run: RunFile, tasks: number): { sec: number; runs: number } | null {
  const { mean, runs } = means(projectDir, run.id);
  if (mean.implement === undefined) return null;
  const per = (mean.implement ?? 0) + (mean.checks ?? 0) + (run.mode === "task" ? (mean.review ?? 0) : 0) + (mean.commit ?? 0);
  return { sec: Math.round((mean["base-check"] ?? 0) + tasks * per), runs };
}

/** The estimate line of the plan card (AC-81). */
export function estimateText(e: { sec: number; runs: number } | null): string {
  return e === null ? "estimate: none yet (no earlier runs)" : `estimate: ≈ ${Math.max(1, Math.round(e.sec / 60))} min of work (from ${e.runs} earlier runs)`;
}

/** The time lines of gate:accept (AC-81): totals, per step kind, per task, and the estimate against the actual. */
export function timeFacts(run: RunFile, now: Date = new Date()): string[] {
  const { workSec, waitSec } = times(run, now);
  const byKind = new Map<string, number>();
  const byTask = new Map<string, number>();
  for (const s of run.steps) {
    if (isGate(s.step)) continue;
    const { kind, task } = parseNext(s.step);
    const d = seconds(s.start, s.end, now);
    byKind.set(kind, (byKind.get(kind) ?? 0) + d);
    if (task !== null) byTask.set(task, (byTask.get(task) ?? 0) + d);
  }
  const out = [`time: ${clock(workSec)} work + ${clock(waitSec)} waiting for you`];
  if (byKind.size > 0) out.push(`by step: ${[...byKind].map(([k, v]) => `${k} ${clock(v)}`).join(" · ")}`);
  if (byTask.size > 0) out.push(`by task: ${[...byTask].map(([k, v]) => `${k} ${clock(v)}`).join(" · ")}`);
  if (run.estimateSec !== null) out.push(`estimate ${clock(run.estimateSec)} → actual ${clock(workSec)}`);
  return out;
}
