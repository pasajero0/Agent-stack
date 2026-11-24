/** Collect every run folder for `run --stats` (spec stats1, AC-2, AC-9, AC-12, AC-18, AC-20). Read-only. */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { RunError } from "../errors.js";
import { isRunId, pidAlive, readLock, readRunStrict, runDir } from "../store.js";
import type { Role, RunFile } from "../types.js";
import { CALL_KINDS, emptyRole, type RoleCalls, type RunCalls, readCalls } from "./calls.js";
import { countRun, type RunCount, sumCounts } from "./count.js";
import { runTime, type RunTime, sumTimes, type TimeTotals } from "./time.js";

export type ShownStatus = "finished" | "cancelled" | "waiting" | "interrupted" | "running";

export const SHOWN_STATUSES: readonly ShownStatus[] = ["finished", "cancelled", "waiting", "interrupted", "running"];

export interface RunStats {
  run: RunFile;
  status: ShownStatus;
  count: RunCount;
  calls: RunCalls;
  time: RunTime;
}

export interface Skipped {
  /** The folder name as it is, also when it is not a run id. */
  id: string;
  reason: string;
}

export interface CallTotals {
  roles: Record<Role, RoleCalls>;
  missing: number;
}

export interface Stats {
  /** Folders under the runs folder; 0 means "no runs in this repo" (AC-11). */
  folders: number;
  runs: RunStats[];
  skipped: Skipped[];
  warnings: string[];
  totals: {
    byStatus: Record<ShownStatus, number>;
    count: RunCount;
    calls: CallTotals;
    time: TimeTotals;
  };
}

const byName = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

function listFolders(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort(byName);
  } catch {
    return [];
  }
}

const MALFORMED = "run.json is malformed: ";

/** The run file, or the skip reason. The "not found" message holds an absolute path, so it is not shown. */
function readRunFolder(projectDir: string, id: string): RunFile | string {
  try {
    return readRunStrict(projectDir, id);
  } catch (e) {
    if (e instanceof RunError && e.message.startsWith(MALFORMED)) return e.message;
    return "run.json is missing";
  }
}

/** Warnings with a call number first, by that number; the rest after, in the order they came. */
function sortWarnings(id: string, list: string[]): string[] {
  const prefix = `${id}: calls/`;
  const callNo = (w: string): number => {
    if (!w.startsWith(prefix)) return Infinity;
    const m = /^([0-9]+)-[a-z*]+\.json /.exec(w.slice(prefix.length));
    return m ? Number(m[1]) : Infinity;
  };
  return list
    .map((w, i) => ({ w, i, n: callNo(w) }))
    .sort((a, b) => (a.n === b.n ? a.i - b.i : a.n < b.n ? -1 : 1))
    .map((x) => x.w);
}

function sumRole(list: RunCalls[], role: Role): RoleCalls {
  const sum = emptyRole();
  for (const c of list) {
    const r = c.roles[role];
    sum.calls += r.calls;
    sum.denials += r.denials;
    for (const k of CALL_KINDS) sum.outcomes[k] += r.outcomes[k];
  }
  return sum;
}

function sumCalls(list: RunCalls[]): CallTotals {
  return {
    roles: {
      clarify: sumRole(list, "clarify"),
      spec: sumRole(list, "spec"),
      plan: sumRole(list, "plan"),
      implement: sumRole(list, "implement"),
      review: sumRole(list, "review"),
    },
    missing: list.reduce((s, c) => s + c.missing, 0),
  };
}

export function collectStats(projectDir: string, now: Date): Stats {
  const lock = readLock(projectDir);
  const folders = listFolders(join(projectDir, ".claude", "tmp", "runs"));
  const runs: RunStats[] = [];
  const skipped: Skipped[] = [];

  for (const name of folders) {
    // isRunId before any path is built from the name.
    if (!isRunId(name)) {
      skipped.push({ id: name, reason: "not a run id" });
      continue;
    }
    const run = readRunFolder(projectDir, name);
    if (typeof run === "string") {
      skipped.push({ id: name, reason: run });
      continue;
    }
    const live = run.status === "running" && lock !== null && lock.id === run.id && pidAlive(lock.pid);
    const status: ShownStatus = run.status === "running" ? (live ? "running" : "interrupted") : run.status;
    const calls = readCalls(runDir(projectDir, name), run, live);
    const time = runTime(run, live, now);
    runs.push({ run, status, count: countRun(run), calls, time });
  }

  const byStatus: Record<ShownStatus, number> = { finished: 0, cancelled: 0, waiting: 0, interrupted: 0, running: 0 };
  for (const r of runs) byStatus[r.status]++;
  const warnings = runs.flatMap((r) => sortWarnings(r.run.id, [...r.calls.warnings, ...r.time.warnings]));

  return {
    folders: folders.length,
    runs,
    skipped,
    warnings,
    totals: {
      byStatus,
      count: sumCounts(runs.map((r) => r.count)),
      calls: sumCalls(runs.map((r) => r.calls)),
      time: sumTimes(runs.map((r) => r.time)),
    },
  };
}
