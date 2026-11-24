/** Text and JSON output for `run --stats` (spec stats1, AC-1, AC-7, AC-11, AC-21, AC-22). Pure. */
import { clock } from "../engine/timing.js";
import type { Role } from "../types.js";
import { CALL_KINDS, CALL_ROLES, type RoleCalls } from "./calls.js";
import { SHOWN_STATUSES, type RunStats, type Stats } from "./collect.js";
import { STOP_REASONS } from "./count.js";

const DASH = "—";

/** AC-22: each control character (U+0000..U+001F, U+007F..U+009F) prints as `?`. */
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f]", "g");
const clean = (s: string): string => s.replace(CONTROL, "?");

const two = (x: number | null): string => (x === null ? DASH : x.toFixed(2));
const mss = (sec: number | null): string => (sec === null ? DASH : clock(Math.round(sec)));

const dateOf = (id: string): string => `${id.slice(2, 6)}-${id.slice(6, 8)}-${id.slice(8, 10)}`;

const callTotal = (r: { roles: Record<Role, RoleCalls>; missing: number }): number =>
  CALL_ROLES.reduce((s, role) => s + r.roles[role].calls, 0) + r.missing;

const denials = (roles: Record<Role, RoleCalls>): number => CALL_ROLES.reduce((s, role) => s + roles[role].denials, 0);

function runCost(r: RunStats): string {
  const k = r.time.costUnknownCalls;
  return `$${r.time.costUsd.toFixed(2)}${k > 0 ? ` · ${k} unknown` : ""}`;
}

const HEAD = ["run", "date", "mode", "stage", "status", "1st pass", "iter", "rejected s/p/a", "limits", "calls", "work", "wait", "cost"];

function runRow(r: RunStats): string[] {
  const c = r.count;
  const id = clean(r.run.id);
  return [
    id,
    dateOf(id),
    clean(r.run.mode),
    r.run.stage === null ? DASH : clean(r.run.stage),
    r.status,
    `${c.firstPass}/${c.started}`,
    two(c.iterationsPerTask),
    `${c.rejected.specApprove}/${c.rejected.planApprove}/${c.rejected.accept}`,
    String(c.limitStops),
    String(callTotal(r.calls)),
    mss(r.time.workSec),
    mss(r.time.waitSec),
    runCost(r),
  ];
}

/** Two spaces between columns; the last column is not padded. */
function table(rows: string[][]): string[] {
  const width = HEAD.map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  return rows.map((r) => r.map((cell, i) => (i === r.length - 1 ? cell : cell.padEnd(width[i] ?? 0))).join("  "));
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

function roleText(role: Role, c: RoleCalls): string {
  const parts = CALL_KINDS.filter((k) => c.outcomes[k] > 0).map((k) => `${k} ${c.outcomes[k]}`);
  return `${role} ${c.calls}${parts.length > 0 ? ` (${parts.join(" · ")})` : ""}`;
}

function totalsLines(s: Stats): string[] {
  const t = s.totals;
  const c = t.count;
  const pct = c.started === 0 ? "" : ` (${Math.round((c.firstPass / c.started) * 100)}%)`;
  const w = t.time.runsWithoutTimes;
  const bracket = w > 0 ? ` (${plural(w, "run", "runs")} without times)` : "";
  const time = w === s.runs.length ? DASH : `${mss(t.time.workSec)} work + ${mss(t.time.waitSec)} waiting`;
  const k = t.time.costUnknownCalls;
  return [
    `total: ${plural(s.runs.length, "run", "runs")} · ${SHOWN_STATUSES.map((st) => `${st} ${t.byStatus[st]}`).join(" · ")}`,
    `  first pass ${c.firstPass}/${c.started}${pct} · iterations per task ${two(c.iterationsPerTask)}`,
    `  rejected: spec ${c.rejected.specApprove} · plan ${c.rejected.planApprove} · accept ${c.rejected.accept}`,
    `  limit stops: ${STOP_REASONS.map((r) => `${r} ${c.stopsByReason[r]}`).join(" · ")}`,
    `  calls: ${[...CALL_ROLES.map((r) => roleText(r, t.calls.roles[r])), `missing ${t.calls.missing}`].join(" · ")}`,
    `  permission denials: ${denials(t.calls.roles)}`,
    `  time: ${time}${bracket}`,
    `  cost: $${t.time.costUsd.toFixed(2)}${k > 0 ? ` · ${plural(k, "call", "calls")} with unknown cost` : ""}`,
  ];
}

/** The text lines (AC-1, AC-11, AC-22). */
export function statsText(s: Stats): string[] {
  const tail = [...s.skipped.map((k) => clean(`skipped: ${k.id} — ${k.reason}`)), ...s.warnings.map((w) => clean(`warning: ${w}`))];
  if (s.runs.length === 0) return [s.folders === 0 ? "no runs in this repo" : "no runs counted", ...tail];
  return [...table([HEAD, ...s.runs.map(runRow)]), ...totalsLines(s), ...tail];
}

function byRole(roles: Record<Role, RoleCalls>): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const role of CALL_ROLES) {
    const r = roles[role];
    out[role] = { ...Object.fromEntries(CALL_KINDS.map((k) => [k, r.outcomes[k]])), denials: r.denials };
  }
  return out;
}

const limits = (m: Record<string, number>): Record<string, number> => Object.fromEntries(STOP_REASONS.map((r) => [r, m[r] ?? 0]));

/** The JSON object, version 1 (AC-7, AC-11). JSON escapes control characters itself (AC-22). */
export function statsJson(s: Stats): Record<string, unknown> {
  const t = s.totals;
  const c = t.count;
  const noTimes = t.time.runsWithoutTimes === s.runs.length;
  return {
    version: 1,
    runs: s.runs.map((r) => ({
      id: r.run.id,
      date: dateOf(r.run.id),
      mode: r.run.mode,
      stage: r.run.stage,
      status: r.status,
      tasks: r.count.started,
      firstPass: r.count.firstPass,
      firstPassShare: r.count.firstPassShare,
      iterationsPerTask: r.count.iterationsPerTask,
      rejected: { spec: r.count.rejected.specApprove, plan: r.count.rejected.planApprove, accept: r.count.rejected.accept },
      limitStops: limits(r.count.stopsByReason),
      calls: { total: callTotal(r.calls), missing: r.calls.missing, byRole: byRole(r.calls.roles) },
      workSec: r.time.workSec,
      waitSec: r.time.waitSec,
      costUsd: r.time.costUsd,
      costUnknownCalls: r.time.costUnknownCalls,
    })),
    totals: {
      runs: s.runs.length,
      byStatus: { ...t.byStatus },
      tasks: c.started,
      firstPass: c.firstPass,
      firstPassShare: c.firstPassShare,
      iterationsPerTask: c.iterationsPerTask,
      rejected: { spec: c.rejected.specApprove, plan: c.rejected.planApprove, accept: c.rejected.accept },
      limitStops: limits(c.stopsByReason),
      calls: { total: callTotal(t.calls), missing: t.calls.missing, byRole: byRole(t.calls.roles) },
      workSec: noTimes ? null : t.time.workSec,
      waitSec: noTimes ? null : t.time.waitSec,
      runsWithoutTimes: t.time.runsWithoutTimes,
      costUsd: t.time.costUsd,
      costUnknownCalls: t.time.costUnknownCalls,
    },
    skipped: s.skipped.map((k) => ({ id: k.id, reason: k.reason })),
    warnings: [...s.warnings],
  };
}
