/**
 * What every step handler gets, and the interface a mode implements. Quick mode is `steps-quick.ts`;
 * task mode (T9) plugs in as a second `ModeSteps` with its own handlers for clarify … gate:plan-approve.
 */
import type { Prompter } from "../gate.js";
import type { Next, RunConfig, RunFile, RunTask } from "../types.js";
import type { StepEvent, StepKind } from "./transitions.js";

export interface Ctx {
  projectDir: string;
  cfg: RunConfig;
  /** The run file in memory; the loop writes it after every step. Handlers mutate it. */
  run: RunFile;
  mode: ModeSteps;
  prompter: Prompter;
  out: (line: string) => void;
  /** Extra environment for Claude calls (AGENT_STACK_CLAUDE and the fake's variables in tests). */
  env: Record<string, string>;
  /** Aborted on SIGINT/SIGTERM: kills the current call, the loop then exits 1 (AC-51). */
  signal: AbortSignal;
}

/** `task` is the id from `next` (`implement:<task>` …), null for steps without one. */
export type StepHandler = (ctx: Ctx, task: string | null) => Promise<StepEvent>;

export type Tier = "S" | "M" | "L";

/** What implement, checks and review need to know about a task; the mode supplies it. */
export interface TaskInfo {
  id: string;
  desc: string;
  /** Criterion texts (AC-16 prompt); empty in quick mode. */
  criteria: string[];
  tier: Tier;
  risky: boolean;
  /** A fix task F<k> from gate:accept. */
  fix: boolean;
  /** The task's verify command; empty in quick mode. */
  verify: string;
}

export interface CheckItem {
  label: "test" | "lint" | "verify";
  cmd: string;
}

/** Input to a mode's start: everything is read before the run folder exists. */
export interface StartInput {
  projectDir: string;
  cfg: RunConfig;
  description: string;
  stage: string | null;
  /** The current branch (HEAD is not detached here) and its sha. */
  branch: string;
  head: string;
}

export interface StartPlan {
  next: Next;
  tasks: RunTask[];
  /** A work branch the driver creates from HEAD right after the lock (quick/<slug>); null for none. */
  newBranch: string | null;
  stage: string | null;
}

export interface ModeSteps {
  /** Attempts per task, fix tasks included: quick 2, task 3 (AC-25, AC-33). */
  maxAttempts: number;
  /** Mode-only step handlers; the common ones are in steps-common.ts. */
  handlers: Partial<Record<StepKind, StepHandler>>;
  /** Mode refusals (a `RunError`) and the run's initial fields. */
  start(input: StartInput): StartPlan;
  taskInfo(ctx: Ctx, id: string): TaskInfo;
  /** Commands of the checks step (AC-19, AC-22, AC-25). */
  checkItems(ctx: Ctx, task: RunTask, info: TaskInfo): CheckItem[];
  /** Whether the green checks are followed by a review (AC-20, AC-25). */
  needsReview(ctx: Ctx, task: RunTask): boolean;
  /** The task base-check hands over to. */
  firstTask(ctx: Ctx): string;
  /** The task after `id`, or null when gate:accept follows. */
  nextTaskAfter(ctx: Ctx, id: string): string | null;
  /** Extra resume refusals for mode steps (AC-49: spec/plan bounds); may be absent. */
  resumeCheck?(ctx: Ctx): void;
}

/** Thrown when the signal aborts a call or a gate; the loop writes the run and exits 1 (AC-51). */
export class Interrupted extends Error {
  constructor() {
    super("interrupted");
    this.name = "Interrupted";
  }
}

export function newTask(id: string): RunTask {
  return { id, taskBase: null, attempts: 0, blockingCount: null, lastFeedback: null, checks: [], notes: [], commit: null };
}

export function findTask(ctx: Ctx, id: string): RunTask {
  const t = ctx.run.tasks.find((x) => x.id === id);
  if (!t) throw new Error(`run ${ctx.run.id} has no task ${id}`);
  return t;
}

export const resumeHint = (id: string): string => `agent-stack run --resume ${id}`;
