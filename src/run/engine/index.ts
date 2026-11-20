/**
 * Engine entry points: start, resume, cancel, status. Spec: docs/specs/v04/SPEC.md, "CLI", AC-1, AC-23,
 * AC-28..30, AC-49..55. Modes plug in through `MODES`.
 */
import { rmSync } from "node:fs";
import { DEFAULT_STAGE_PATTERN } from "../../claude/gates.js";
import { loadRunConfig, readLanguage } from "../config.js";
import { RunError } from "../errors.js";
import { answersPrompter, selectPrompter, type Prompter } from "../gate.js";
import { branchExists, createBranch, currentBranch, dirtyPaths, headSha } from "../git.js";
import {
  acquireLock,
  createRunDir,
  listRuns,
  lockedRunState,
  newRunId,
  pidAlive,
  readLock,
  readRunStrict,
  releaseLock,
  runDir,
  takeOverLock,
  writeRun,
} from "../store.js";
import type { Mode, RunConfig, RunFile } from "../types.js";
import { findTask, type Ctx, type ModeSteps } from "./context.js";
import { cancelledText, costText } from "./gates.js";
import { runLoop, type ExitCode } from "./loop.js";
import { Progress } from "./progress.js";
import { quickMode } from "./steps-quick.js";
import { taskMode } from "./steps-task.js";
import { parseNext } from "./transitions.js";
import { commandName, requireHarness } from "./command.js";

export type { ExitCode } from "./loop.js";

const MODES: Record<Mode, ModeSteps | null> = { quick: quickMode, task: taskMode };

export interface EngineOptions {
  projectDir: string;
  /** Where the run's messages go; console.log by default. */
  out?: (line: string) => void;
  /** Extra environment for Claude calls and gate input (AGENT_STACK_GATE_INPUT). */
  env?: Record<string, string>;
  /** Whether stdin is a terminal; process.stdin.isTTY by default. */
  isTTY?: boolean;
  /** Aborted on SIGINT/SIGTERM (see `abortOnSignals`). */
  signal?: AbortSignal;
  /** The pid written to the lock; process.pid by default. */
  pid?: number;
  now?: Date;
  prompter?: Prompter;
  /** `--answer` lines for the gate the run waits at (AC-70); only `--resume` takes them. */
  answers?: string[];
}

const outOf = (o: EngineOptions): ((line: string) => void) => o.out ?? ((line) => console.log(line));

/** Prints a `RunError` and returns its code; anything else is a bug and propagates. */
async function guard(o: EngineOptions, fn: () => Promise<ExitCode>): Promise<ExitCode> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof RunError) {
      outOf(o)(e.message);
      return e.exitCode;
    }
    throw e;
  }
}

function modeSteps(mode: Mode): ModeSteps {
  const steps = MODES[mode];
  if (!steps) throw new RunError(`${mode} mode: not built yet. Use ${commandName()} run quick "<description>" for now.`, 1);
  return steps;
}

/** Builds the context, runs the loop and closes the prompter whatever happens. */
async function drive(o: EngineOptions, cfg: RunConfig, run: RunFile, mode: ModeSteps, before?: (ctx: Ctx) => void): Promise<ExitCode> {
  const env = o.env ?? {};
  const answering = o.answers !== undefined && o.answers.length > 0;
  // AC-70: `--answer` wins over AGENT_STACK_GATE_INPUT and the terminal.
  const prompter = answering ? answersPrompter(o.answers ?? []) : (o.prompter ?? selectPrompter({ ...process.env, ...env }, o.isTTY ?? Boolean(process.stdin.isTTY)));
  const ctx: Ctx = {
    projectDir: o.projectDir,
    cfg,
    run,
    mode,
    prompter,
    answering,
    out: outOf(o),
    env,
    signal: o.signal ?? new AbortController().signal,
    progress: new Progress(o.projectDir, run.id, run.next),
  };
  try {
    before?.(ctx);
    return await runLoop(ctx);
  } finally {
    prompter.close();
  }
}

function refuseDirty(dir: string, when: string): void {
  const dirty = dirtyPaths(dir);
  if (dirty.length === 0) return;
  throw new RunError(`The tree is not clean ${when}. Commit or stash these changes first:\n${dirty.map((p) => `  ${p}`).join("\n")}`, 1);
}

/** AC-50: names the locked run and its commands. */
function lockRefusal(dir: string): RunError {
  const lock = readLock(dir);
  if (!lock) return new RunError(`A run lock exists (.claude/tmp/runs/lock) but cannot be read. Remove it with: ${commandName()} run --cancel`, 1);
  const state = lockedRunState(dir);
  return new RunError(
    [
      `Run ${lock.id} holds the lock (${state}); one run per repo.`,
      `  ${commandName()} run --resume ${lock.id}`,
      `  ${commandName()} run --status ${lock.id}`,
      `  ${commandName()} run --cancel ${lock.id}`,
    ].join("\n"),
    1
  );
}

export function startRun(o: EngineOptions & { mode: Mode; description: string; stage?: string }): Promise<ExitCode> {
  return guard(o, async () => {
    const dir = o.projectDir;
    const description = o.description.trim();
    if (description === "") throw new RunError(`The description is empty: say what to do, e.g. ${commandName()} run quick "fix the README typo".`, 1);
    const cfg = loadRunConfig(dir);
    // AC-72: an old harness stops the run here, before any call, not halfway at a missing agent section.
    requireHarness(dir);
    if (o.mode === "task" && cfg.stagePattern !== DEFAULT_STAGE_PATTERN) {
      throw new RunError(`gates.json sets a custom stagePattern (${cfg.stagePattern}); task mode needs the default ${DEFAULT_STAGE_PATTERN}. Remove the key, or use run quick.`, 1);
    }
    const mode = modeSteps(o.mode);
    const branch = currentBranch(dir);
    if (branch === null) throw new RunError("HEAD is detached: check out a branch first (git switch <branch>).", 1);
    refuseDirty(dir, "to start a run");
    const head = headSha(dir);
    const plan = mode.start({ projectDir: dir, cfg, description, stage: o.stage ?? null, branch, head });
    const id = newRunId(o.now ?? new Date());
    const run: RunFile = {
      id,
      description,
      mode: o.mode,
      status: "running",
      next: plan.next,
      returnTo: null,
      limitReason: null,
      proposal: null,
      stage: null,
      stagePrefill: plan.stagePrefill,
      size: null,
      branch: plan.newBranch ?? branch,
      baseCommit: plan.newBranch ? head : null,
      tasks: plan.tasks,
      // Filled once the branch exists, so a kill in between leaves no false entry (AC-55).
      createdBranches: [],
      gates: [],
      answers: [],
      humanDecisions: [],
      costUsd: 0,
      costUnknownCalls: 0,
      card: null,
      calls: 0,
      fuse: cfg.fuse,
    };
    // AC-1: folder and run file first, then the lock; a lost lock removes the folder again (AC-50).
    createRunDir(dir, id);
    writeRun(dir, run);
    if (!acquireLock(dir, id, o.pid ?? process.pid)) {
      rmSync(runDir(dir, id), { recursive: true, force: true });
      throw lockRefusal(dir);
    }
    if (plan.newBranch) {
      try {
        refuseDirty(dir, `before creating ${plan.newBranch}`);
        createBranch(dir, plan.newBranch, head);
        run.createdBranches.push(plan.newBranch);
        writeRun(dir, run);
      } catch (e) {
        releaseLock(dir);
        rmSync(runDir(dir, id), { recursive: true, force: true });
        throw e;
      }
    }
    return drive(o, cfg, run, mode);
  });
}

/**
 * AC-55: a work branch the driver creates (`baseCommit` is set for it) that is missing — a kill between the
 * run file and the branch — is created from `baseCommit` on a clean tree and recorded in `createdBranches`.
 * An existing one is left to the branch check: it is checked out by the human, never created again.
 */
function restoreRunBranch(dir: string, run: RunFile): void {
  if (run.baseCommit === null || branchExists(dir, run.branch)) return;
  refuseDirty(dir, `to create the run's branch ${run.branch} again`);
  createBranch(dir, run.branch, run.baseCommit);
  if (!run.createdBranches.includes(run.branch)) run.createdBranches.push(run.branch);
}

/** Steps whose resume needs a clean tree (AC-49); spec and plan check their bounds when they start. */
const CLEAN_ON_RESUME = new Set(["gate:spec-merge", "gate:plan-approve", "base-check"]);

const INTERRUPTED_FEEDBACK = "The previous session was interrupted; continue from `git status`.";

export function resumeRun(o: EngineOptions & { id?: string }): Promise<ExitCode> {
  return guard(o, async () => {
    const dir = o.projectDir;
    const lock = readLock(dir);
    const id = o.id ?? lock?.id;
    if (!id) throw new RunError(`No run to resume: no run holds the lock. Start one with ${commandName()} run quick "<description>".`, 1);
    const run = readRunStrict(dir, id);
    if (run.status === "finished" || run.status === "cancelled") throw new RunError(`Run ${id} is ${run.status}; there is nothing to resume.`, 1);
    if (lock && lock.id !== id) throw lockRefusal(dir);
    if (lock && run.status === "running" && pidAlive(lock.pid)) {
      throw new RunError(`Run ${id} is live (pid ${lock.pid}); it is already running and cannot be resumed twice.`, 1);
    }
    // AC-70: answers reach only the gate the run waits at, and only one that reads input.
    if (o.answers !== undefined && o.answers.length > 0 && (run.status !== "waiting" || !run.next.startsWith("gate:") || run.next === "gate:spec-merge")) {
      throw new RunError(`--answer needs a run waiting at a gate that takes an answer; run ${id} is ${run.status} at ${run.next}. Nothing was applied.`, 1);
    }
    requireHarness(dir);
    const cfg = loadRunConfig(dir);
    const mode = modeSteps(run.mode);
    const { kind, task } = parseNext(run.next);
    if (kind !== "gate:spec-merge") {
      restoreRunBranch(dir, run);
      const cur = currentBranch(dir);
      if (cur !== run.branch) {
        throw new RunError(`Run ${id} works on branch ${run.branch}, but ${cur ?? "a detached HEAD"} is checked out. Run git switch ${run.branch}, then resume.`, 1);
      }
    }
    if (CLEAN_ON_RESUME.has(kind)) refuseDirty(dir, `to resume at ${run.next}`);
    const interrupted = run.status === "running";
    return drive(o, cfg, run, mode, (ctx) => {
      const pid = o.pid ?? process.pid;
      if (lock) takeOverLock(dir, id, pid, lock);
      else if (!acquireLock(dir, id, pid)) throw lockRefusal(dir);
      // AC-30: the interrupted step re-runs without a new attempt; implement continues from git status.
      if (interrupted && kind === "implement" && task !== null) {
        const t = findTask(ctx, task);
        if (!t.lastFeedback?.startsWith(INTERRUPTED_FEEDBACK)) {
          t.lastFeedback = t.lastFeedback ? `${INTERRUPTED_FEEDBACK}\n\n${t.lastFeedback}` : INTERRUPTED_FEEDBACK;
        }
      }
      run.status = "running";
      writeRun(dir, run);
    });
  });
}

export function cancelRun(o: EngineOptions & { id?: string }): Promise<ExitCode> {
  return guard(o, async () => {
    const dir = o.projectDir;
    const out = outOf(o);
    const lock = readLock(dir);
    const state = lockedRunState(dir);
    const id = o.id ?? lock?.id;
    // AC-55: a lock whose run folder is missing (or that cannot be read) is removable.
    if ((state === "orphan" && (o.id === undefined || o.id === lock?.id)) || (state === "stale" && o.id === undefined)) {
      releaseLock(dir);
      out(`Removed a stale lock${lock ? ` for run ${lock.id}` : ""}; no run was changed.`);
      return 0;
    }
    if (!id) throw new RunError("No run to cancel: no run holds the lock.", 1);
    const run = readRunStrict(dir, id);
    const ours = lock?.id === id;
    if (run.status === "finished" || run.status === "cancelled") {
      if (ours) releaseLock(dir);
      throw new RunError(`Run ${id} is already ${run.status}; there is nothing to cancel.`, 1);
    }
    if (ours && lock && run.status === "running" && pidAlive(lock.pid)) {
      throw new RunError(`Run ${id} is live (pid ${lock.pid}): stop it first (Ctrl-C), then ${commandName()} run --cancel ${id}.`, 1);
    }
    run.status = "cancelled";
    writeRun(dir, run);
    if (ours) releaseLock(dir);
    out(cancelledText(dir, run));
    return 0;
  });
}

/** The run for a program: AC-23's fields, the kept card while the run waits, the language (AC-69, AC-76). */
function statusJson(dir: string, id: string | undefined): string {
  const { language, warnings } = readLanguage(dir);
  if (!id) return JSON.stringify({ run: null, card: null, language, warnings: [...warnings, "no run in this repo"] });
  let run: RunFile;
  try {
    run = readRunStrict(dir, id);
  } catch (e) {
    return JSON.stringify({ run: null, card: null, language, warnings: [...warnings, e instanceof Error ? e.message : String(e)] });
  }
  const attempts = Object.fromEntries(run.tasks.map((t) => [t.id, t.attempts]));
  const out = {
    run: { id: run.id, mode: run.mode, status: run.status, next: run.next, branch: run.branch, attempts, calls: run.calls, costUsd: run.costUsd, costUnknownCalls: run.costUnknownCalls, fuse: run.fuse },
    // A live or interrupted run waits at no gate, even while a terminal prompt is open.
    card: run.status === "waiting" ? run.card : null,
    language,
    warnings,
  };
  return JSON.stringify(out);
}

/** Prints the run and changes nothing; always exit 0 (AC-23, AC-53, AC-69). */
export async function statusRun(o: EngineOptions & { id?: string; json?: boolean }): Promise<ExitCode> {
  const dir = o.projectDir;
  const out = outOf(o);
  const lock = readLock(dir);
  const id = o.id ?? lock?.id ?? listRuns(dir).at(-1);
  if (o.json) {
    out(statusJson(dir, id));
    return 0;
  }
  if (!id) {
    out("No run in this repo.");
    return 0;
  }
  let run: RunFile;
  try {
    run = readRunStrict(dir, id);
  } catch (e) {
    out(e instanceof Error ? e.message : String(e));
    return 0;
  }
  const live = lock?.id === id && run.status === "running" ? (pidAlive(lock.pid) ? " (live)" : " (interrupted)") : "";
  out(`Run ${run.id} — ${run.mode} mode, ${run.status}${live}, next ${run.next}`);
  out(`Description: ${run.description}`);
  out(`Branch: ${run.branch}${run.baseCommit ? ` (base ${run.baseCommit.slice(0, 7)})` : ""}`);
  if (run.limitReason) out(`Limit: ${run.limitReason}, returns to ${run.returnTo ?? "-"}`);
  for (const t of run.tasks) out(`  ${t.id}: attempts ${t.attempts}, commit ${t.commit ?? "none"}`);
  out(`Usage: ${costText(run)}`);
  return 0;
}

/**
 * SIGINT/SIGTERM abort the returned signal: the current call is killed, the run file written, exit 1
 * (AC-51). A second signal exits at once.
 */
export function abortOnSignals(): { signal: AbortSignal; dispose: () => void } {
  const ac = new AbortController();
  const on = (): void => {
    if (ac.signal.aborted) process.exit(1);
    ac.abort();
  };
  process.on("SIGINT", on);
  process.on("SIGTERM", on);
  return {
    signal: ac.signal,
    dispose: () => {
      process.off("SIGINT", on);
      process.off("SIGTERM", on);
    },
  };
}
