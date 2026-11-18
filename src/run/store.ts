import * as nodeFs from "node:fs";
import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isObj, parseFuse } from "./config.js";
import { RunError } from "./errors.js";
import type {
  AnswerRecord,
  CheckResult,
  GateRecord,
  LimitReason,
  Mode,
  Next,
  RunFile,
  RunStatus,
  RunTask,
} from "./types.js";

/**
 * `orphan`: the lock names a run whose folder is missing. `stale`: the lock is unreadable, or its run is
 * finished, cancelled or has a malformed run file.
 */
export type LockedRunState = "none" | "live" | "waiting" | "interrupted" | "orphan" | "stale";

/** The fs calls `writeRun` makes; injectable so a test can prove the write is temp + rename. */
export interface RunFs {
  writeFileSync: (path: string, data: string) => void;
  renameSync: (from: string, to: string) => void;
}

const pad = (n: number): string => String(n).padStart(2, "0");

/** `r-<yyyymmdd>-<hhmmss>` in local time. */
export function newRunId(now: Date): string {
  const d = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const t = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `r-${d}-${t}`;
}

const runsRoot = (projectDir: string): string => join(projectDir, ".claude", "tmp", "runs");

const RUN_ID = /^r-[0-9]{8}-[0-9]{6}$/;

/** True for an id of the form `newRunId` makes; nothing else may name a path under the runs folder. */
export const isRunId = (id: string): boolean => RUN_ID.test(id);

function checkId(id: string): void {
  if (!isRunId(id)) throw new RunError(`Bad run id ${JSON.stringify(id)}: expected r-<yyyymmdd>-<hhmmss>.`, 1);
}

/** The run folder; a malformed id is a `RunError(1)`, so `../../x` cannot leave the runs folder. */
export function runDir(projectDir: string, id: string): string {
  checkId(id);
  return join(runsRoot(projectDir), id);
}

const lockPath = (projectDir: string): string => join(runsRoot(projectDir), "lock");

const isCode = (e: unknown, code: string): boolean => e instanceof Error && "code" in e && e.code === code;

/** Creates the run folder exclusively. An existing folder is a `RunError(1)`. */
export function createRunDir(projectDir: string, id: string): string {
  const dir = runDir(projectDir, id);
  mkdirSync(runsRoot(projectDir), { recursive: true });
  try {
    mkdirSync(dir);
  } catch (e) {
    if (isCode(e, "EEXIST")) throw new RunError(`Run folder ${dir} already exists; wait a second and start again.`, 1);
    throw e;
  }
  return dir;
}

// ---- run file validation: builds a fresh RunFile, or names the first bad field ----

class Malformed extends Error {}
const bad = (field: string): never => {
  throw new Malformed(field);
};

type Obj = Record<string, unknown>;

const STATUSES: readonly RunStatus[] = ["running", "waiting", "finished", "cancelled"];
const MODES: readonly Mode[] = ["task", "quick"];
const LIMITS: readonly LimitReason[] = ["attempts", "blocked", "review-loop", "fuse"];
const SIZES = ["task", "story", "epic"] as const;
const FIXED_NEXT = [
  "clarify",
  "gate:answers",
  "spec",
  "gate:spec-merge",
  "plan",
  "gate:plan-approve",
  "base-check",
  "gate:accept",
  "gate:limit",
] as const;
const TASK_NEXT = /^(implement|checks|review|commit):([A-Za-z0-9._-]+)$/;

function oneOf<T extends string>(values: readonly T[], v: unknown, f: string): T {
  const hit = values.find((x) => x === v);
  return hit === undefined ? bad(f) : hit;
}

function next(v: unknown, f: string): Next {
  const fixed = FIXED_NEXT.find((x) => x === v);
  if (fixed !== undefined) return fixed;
  const m = typeof v === "string" ? TASK_NEXT.exec(v) : null;
  if (!m) return bad(f);
  const id = m[2] ?? "";
  switch (m[1]) {
    case "implement":
      return `implement:${id}`;
    case "checks":
      return `checks:${id}`;
    case "review":
      return `review:${id}`;
    default:
      return `commit:${id}`;
  }
}

const str = (v: unknown, f: string): string => (typeof v === "string" ? v : bad(f));
const strOrNull = (v: unknown, f: string): string | null => (v === null ? null : str(v, f));
const bool = (v: unknown, f: string): boolean => (typeof v === "boolean" ? v : bad(f));
const int = (v: unknown, f: string): number => (typeof v === "number" && Number.isInteger(v) ? v : bad(f));
const count = (v: unknown, f: string): number => {
  const n = int(v, f);
  return n >= 0 ? n : bad(f);
};
const obj = (v: unknown, f: string): Obj => (isObj(v) ? v : bad(f));
const arr = <T>(v: unknown, f: string, item: (x: unknown, f: string) => T): T[] =>
  Array.isArray(v) ? v.map((x, i) => item(x, `${f}[${i}]`)) : bad(f);
/** For arrays of scalars the message names the array, not the index. */
const strings = (v: unknown, f: string): string[] => arr(v, f, (x) => str(x, f));

function check(v: unknown, f: string): CheckResult {
  const o = obj(v, f);
  return { cmd: str(o.cmd, f), exit: int(o.exit, f), skipped: bool(o.skipped, f) };
}

function task(v: unknown, f: string): RunTask {
  const o = obj(v, f);
  return {
    id: str(o.id, `${f}.id`),
    taskBase: strOrNull(o.taskBase, `${f}.taskBase`),
    attempts: count(o.attempts, `${f}.attempts`),
    blockingCount: o.blockingCount === null ? null : count(o.blockingCount, `${f}.blockingCount`),
    lastFeedback: strOrNull(o.lastFeedback, `${f}.lastFeedback`),
    checks: arr(o.checks, `${f}.checks`, (x) => check(x, `${f}.checks`)),
    notes: strings(o.notes, `${f}.notes`),
    commit: strOrNull(o.commit, `${f}.commit`),
  };
}

function gate(v: unknown, f: string): GateRecord {
  const o = obj(v, f);
  return { gate: str(o.gate, f), at: str(o.at, f), decision: str(o.decision, f), comment: strOrNull(o.comment, f) };
}

function answer(v: unknown, f: string): AnswerRecord {
  const o = obj(v, f);
  return { question: str(o.question, f), answer: str(o.answer, f) };
}

/** Field-by-field check of a parsed run file; throws `Malformed(<field>)`. */
function toRunFile(v: unknown, id: string): RunFile {
  const o = obj(v, "run.json");
  if (o.id !== id) bad("id");
  const costUsd = typeof o.costUsd === "number" && Number.isFinite(o.costUsd) && o.costUsd >= 0 ? o.costUsd : bad("costUsd");
  return {
    id,
    description: str(o.description, "description"),
    mode: oneOf(MODES, o.mode, "mode"),
    status: oneOf(STATUSES, o.status, "status"),
    next: next(o.next, "next"),
    returnTo: o.returnTo === null ? null : next(o.returnTo, "returnTo"),
    limitReason: o.limitReason === null ? null : oneOf(LIMITS, o.limitReason, "limitReason"),
    proposal: o.proposal === null || isObj(o.proposal) ? o.proposal : bad("proposal"),
    stage: strOrNull(o.stage, "stage"),
    size: o.size === null ? null : oneOf(SIZES, o.size, "size"),
    branch: str(o.branch, "branch"),
    baseCommit: strOrNull(o.baseCommit, "baseCommit"),
    tasks: arr(o.tasks, "tasks", task),
    createdBranches: strings(o.createdBranches, "createdBranches"),
    gates: arr(o.gates, "gates", (x) => gate(x, "gates")),
    answers: arr(o.answers, "answers", (x) => answer(x, "answers")),
    humanDecisions: strings(o.humanDecisions, "humanDecisions"),
    costUsd,
    calls: count(o.calls, "calls"),
    fuse: parseFuse(o.fuse) ?? bad("fuse"),
  };
}

/** The run file, or a `RunError(1)`: a bad id, "run <id> not found" or "run.json is malformed: <field>". */
export function readRunStrict(projectDir: string, id: string): RunFile {
  const path = join(runDir(projectDir, id), "run.json");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    throw new RunError(`Run ${id} not found: ${path} is missing.`, 1);
  }
  try {
    return toRunFile(JSON.parse(text), id);
  } catch (e) {
    if (e instanceof Malformed) throw new RunError(`run.json is malformed: ${e.message}`, 1);
    throw new RunError("run.json is malformed: not JSON", 1);
  }
}

/** The run file, or null when it is missing or malformed. */
export function readRun(projectDir: string, id: string): RunFile | null {
  try {
    return readRunStrict(projectDir, id);
  } catch {
    return null;
  }
}

/** Atomic: writes a temp file in the run folder, then renames it over `run.json`. The folder must exist. */
export function writeRun(projectDir: string, run: RunFile, fs: RunFs = nodeFs): void {
  const dir = runDir(projectDir, run.id);
  const tmp = join(dir, `run.json.${process.pid}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(run, null, 2) + "\n");
  fs.renameSync(tmp, join(dir, "run.json"));
}

/** Run ids, oldest first. */
export function listRuns(projectDir: string): string[] {
  try {
    return readdirSync(runsRoot(projectDir), { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

const lockTmp = (projectDir: string, pid: number): string => join(runsRoot(projectDir), `lock.${pid}.tmp`);

/**
 * Creates the lock atomically: the full `{id, pid}` goes to a temp file that is then hard-linked to
 * `lock` (link fails with EEXIST if a lock exists), so no reader ever sees an empty lock.
 * False when a lock already exists.
 */
export function acquireLock(projectDir: string, id: string, pid: number): boolean {
  checkId(id);
  mkdirSync(runsRoot(projectDir), { recursive: true });
  const tmp = lockTmp(projectDir, pid);
  writeFileSync(tmp, JSON.stringify({ id, pid }));
  try {
    linkSync(tmp, lockPath(projectDir));
    return true;
  } catch (e) {
    if (isCode(e, "EEXIST")) return false;
    throw e;
  } finally {
    rmSync(tmp, { force: true });
  }
}

/**
 * `--resume` taking over an interrupted run's lock, compare-and-swap style. `seen` is the lock the caller
 * judged stale (what `readLock` returned).
 *   1. Rename `lock` to a unique `lock.stale.<pid>.<ts>`: of two racers only one rename succeeds; ENOENT
 *      means the other won.
 *   2. The moved file must still be `seen`: a second, later takeover would otherwise move the winner's
 *      fresh lock away. On a mismatch the moved lock is linked back (unless a lock exists again).
 *   3. `acquireLock`, then delete the stale file.
 * Losing at any step is a `RunError(1)`.
 */
export function takeOverLock(projectDir: string, id: string, pid: number, seen: { id: string; pid: number }): void {
  checkId(id);
  const lost = (): RunError => new RunError(`Another process took over run ${id} first; it is not resumed here.`, 1);
  const stale = join(runsRoot(projectDir), `lock.stale.${pid}.${Date.now()}`);
  try {
    renameSync(lockPath(projectDir), stale);
  } catch (e) {
    if (isCode(e, "ENOENT")) throw lost();
    throw e;
  }
  try {
    const moved = parseLock(readFileSync(stale, "utf8"));
    if (!moved || moved.id !== seen.id || moved.pid !== seen.pid) {
      try {
        linkSync(stale, lockPath(projectDir));
      } catch (e) {
        if (!isCode(e, "EEXIST")) throw e;
      }
      throw lost();
    }
    if (!acquireLock(projectDir, id, pid)) throw lost();
  } finally {
    rmSync(stale, { force: true });
  }
}

const isPid = (pid: unknown): pid is number => typeof pid === "number" && Number.isInteger(pid) && pid > 0;

function parseLock(text: string): { id: string; pid: number } | null {
  try {
    const v: unknown = JSON.parse(text);
    if (!isObj(v)) return null;
    const { id, pid } = v;
    return typeof id === "string" && isRunId(id) && isPid(pid) ? { id, pid } : null;
  } catch {
    return null;
  }
}

/** The lock's id and pid; null when missing, unparsable, the id is malformed or the pid is not a positive integer. */
export function readLock(projectDir: string): { id: string; pid: number } | null {
  try {
    return parseLock(readFileSync(lockPath(projectDir), "utf8"));
  } catch {
    return null;
  }
}

export function releaseLock(projectDir: string): void {
  rmSync(lockPath(projectDir), { force: true });
}

/** Only a positive integer can be alive: `kill(0|-1, 0)` would probe a process group instead. */
export function pidAlive(pid: number): boolean {
  if (!isPid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    // EPERM: the process exists but belongs to someone else.
    return isCode(e, "EPERM");
  }
}

/** State of the locked run; see `LockedRunState`. */
export function lockedRunState(projectDir: string): LockedRunState {
  if (!existsSync(lockPath(projectDir))) return "none";
  const lock = readLock(projectDir);
  if (!lock) return "stale";
  if (!existsSync(runDir(projectDir, lock.id))) return "orphan";
  const run = readRun(projectDir, lock.id);
  if (!run) return "stale";
  if (run.status === "waiting") return "waiting";
  if (run.status === "running") return pidAlive(lock.pid) ? "live" : "interrupted";
  return "stale";
}
