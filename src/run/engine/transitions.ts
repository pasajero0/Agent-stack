/**
 * The step order as an explicit table: (step, event) → new `next`. Spec: docs/specs/v04/SPEC.md,
 * "Model and state transitions". The engine never takes the next step from the model's output (AC-1).
 */
import type { Next, RunStatus } from "../types.js";

/** `next` without its task id. */
export type StepKind =
  | "clarify"
  | "gate:answers"
  | "spec"
  | "gate:spec-merge"
  | "gate:spec-approve"
  | "plan"
  | "gate:plan-approve"
  | "base-check"
  | "gate:accept"
  | "gate:limit"
  | "implement"
  | "checks"
  | "review"
  | "commit";

/** `next` values that carry no task id. */
export type FixedStep = Exclude<StepKind, "implement" | "checks" | "review" | "commit">;

/** What a step handler reports. Task-mode events (T9) are added here with their rows below. */
export type EventType =
  | "green" // base-check: test exits 0; `task` is the first task
  | "done" // implement: DONE
  | "retry" // a failed attempt with attempts left
  | "limit" // attempts used, BLOCKED, TEST_CONFLICT, review loop or a decision; the handler set limitReason and returnTo
  | "fuse" // the fuse is reached before a call; the handler set returnTo
  | "review" // checks green, review needed
  | "commit" // checks green, no review needed
  | "pass" // review does not block
  | "committed" // commit made (or empty diff); `task` is the next task
  | "committed-last" // commit made (or empty diff) and no task follows
  | "accept"
  | "reject" // gate:accept reject; `task` is the new fix task
  | "cancel"
  | "resume" // gate:limit retry or raise
  | "no-input" // a gate without input: not in the table; the loop sets waiting and exits 3 (AC-29)
  // ---- task mode only ----
  | "clarified" // clarify: valid output stored as proposal
  | "answered" // gate:answers: size task/story and a valid stage id confirmed
  | "epic" // gate:answers: size epic confirmed, split.md written
  | "spec-done" // spec: SPEC.md in bounds and committed on spec/<stage>
  | "spec-committed" // spec, flow branch: SPEC.md committed on the run's branch (AC-85, AC-87)
  | "reapproved" // gate:spec-approve after a spec change: approved again (AC-88)
  | "spec-changed" // the spec changed since its approval; the handler set returnTo (AC-88)
  | "merged" // gate:spec-merge: the spec is on the base ref, <stage>-<slug> created
  | "planned" // plan: a valid plan in bounds
  | "approve"; // gate:plan-approve: approved (its reject reuses "reject")

export interface StepEvent {
  type: EventType;
  /** The task an event moves to, where the target needs one. */
  task?: string;
}

type Target =
  | FixedStep
  | "implement:<event>"
  | "implement:<same>"
  | "checks:<same>"
  | "review:<same>"
  | "commit:<same>"
  | "<returnTo>"
  | "finished"
  | "cancelled";

interface Row {
  from: readonly StepKind[];
  event: EventType;
  to: Target;
  ac: string;
}

const TASK_STEPS: readonly StepKind[] = ["implement", "checks", "review", "commit"];
const GATES: readonly StepKind[] = ["gate:answers", "gate:spec-merge", "gate:spec-approve", "gate:plan-approve", "gate:accept", "gate:limit"];
/** Steps that make a Claude call, so the fuse can stop them. */
const CALL_STEPS: readonly StepKind[] = ["clarify", "spec", "plan", "implement", "review"];

export const TABLE: readonly Row[] = [
  // ---- quick mode, and the task-mode rows shared with it ----
  { from: ["base-check"], event: "green", to: "implement:<event>", ac: "AC-15, AC-24" },
  { from: ["implement"], event: "done", to: "checks:<same>", ac: "AC-16, AC-19" },
  { from: ["checks"], event: "review", to: "review:<same>", ac: "AC-20, AC-25" },
  { from: ["checks"], event: "commit", to: "commit:<same>", ac: "AC-25" },
  { from: ["review"], event: "pass", to: "commit:<same>", ac: "AC-20" },
  { from: ["commit"], event: "committed", to: "implement:<event>", ac: "AC-20, AC-46" },
  { from: ["commit"], event: "committed-last", to: "gate:accept", ac: "AC-21, AC-25" },
  { from: ["gate:accept"], event: "accept", to: "finished", ac: "AC-22" },
  { from: ["gate:accept"], event: "reject", to: "implement:<event>", ac: "AC-22" },
  // ---- task mode only: clarify, gate:answers, spec, gate:spec-merge, plan, gate:plan-approve ----
  { from: ["clarify"], event: "clarified", to: "gate:answers", ac: "AC-6" },
  { from: ["gate:answers"], event: "answered", to: "spec", ac: "AC-7, AC-8" },
  { from: ["gate:answers"], event: "epic", to: "finished", ac: "AC-9" },
  { from: ["spec"], event: "spec-done", to: "gate:spec-merge", ac: "AC-10" },
  { from: ["gate:spec-merge"], event: "merged", to: "plan", ac: "AC-11" },
  // ---- task mode, spec flow branch (AC-85 to AC-88) ----
  { from: ["spec"], event: "spec-committed", to: "gate:spec-approve", ac: "AC-87" },
  { from: ["gate:spec-approve"], event: "approve", to: "plan", ac: "AC-87" },
  { from: ["gate:spec-approve"], event: "reject", to: "spec", ac: "AC-87" },
  { from: ["gate:spec-approve"], event: "reapproved", to: "<returnTo>", ac: "AC-88" },
  { from: ["implement", "gate:plan-approve", "gate:accept"], event: "spec-changed", to: "gate:spec-approve", ac: "AC-88" },
  { from: ["plan"], event: "planned", to: "gate:plan-approve", ac: "AC-12, AC-13" },
  { from: ["gate:plan-approve"], event: "approve", to: "base-check", ac: "AC-14" },
  { from: ["gate:plan-approve"], event: "reject", to: "plan", ac: "AC-14" },
  // ---- from any step ----
  { from: GATES, event: "cancel", to: "cancelled", ac: "AC-28" },
  { from: TASK_STEPS, event: "retry", to: "implement:<same>", ac: "AC-33, AC-34, AC-38, AC-42, AC-43" },
  { from: TASK_STEPS, event: "limit", to: "gate:limit", ac: "AC-33, AC-34, AC-38, AC-39" },
  { from: CALL_STEPS, event: "fuse", to: "gate:limit", ac: "AC-35" },
  { from: ["spec", "plan"], event: "limit", to: "gate:limit", ac: "AC-57" },
  { from: ["gate:limit"], event: "resume", to: "<returnTo>", ac: "AC-31" },
];

const FIXED: readonly FixedStep[] = [
  "clarify",
  "gate:answers",
  "spec",
  "gate:spec-merge",
  "gate:spec-approve",
  "plan",
  "gate:plan-approve",
  "base-check",
  "gate:accept",
  "gate:limit",
];

const TASK_NEXT = /^(implement|checks|review|commit):(.+)$/;

/** Splits `next` into its step kind and task id. */
export function parseNext(next: Next): { kind: StepKind; task: string | null } {
  const m = TASK_NEXT.exec(next);
  if (m) {
    const kind = TASK_STEPS.find((k) => k === m[1]);
    if (kind !== undefined) return { kind, task: m[2] ?? "" };
  }
  const fixed = FIXED.find((k) => k === next);
  if (fixed === undefined) throw new Error(`unknown step ${next}`);
  return { kind: fixed, task: null };
}


export function taskNext(kind: "implement" | "checks" | "review" | "commit", task: string): Next {
  switch (kind) {
    case "implement":
      return `implement:${task}`;
    case "checks":
      return `checks:${task}`;
    case "review":
      return `review:${task}`;
    case "commit":
      return `commit:${task}`;
  }
}

export interface Transition {
  next: Next;
  status: RunStatus;
}

/**
 * The new `next` (and status) for `event` at `from`. `returnTo` is the run's, read by gate:limit's resume.
 * A pair the table does not list is a bug in the engine, so it throws.
 */
export function transition(from: Next, event: StepEvent, returnTo: Next | null): Transition {
  const { kind, task } = parseNext(from);
  const row = TABLE.find((r) => r.event === event.type && r.from.includes(kind));
  if (!row) throw new Error(`no transition from ${from} on event "${event.type}"`);
  const need = (v: string | null | undefined, what: string): string => {
    if (v === null || v === undefined || v === "") throw new Error(`transition from ${from} on "${event.type}" needs ${what}`);
    return v;
  };
  switch (row.to) {
    case "finished":
    case "cancelled":
      return { next: from, status: row.to };
    case "<returnTo>":
      if (returnTo === null) throw new Error(`transition from ${from} on "${event.type}" needs returnTo`);
      return { next: returnTo, status: "running" };
    case "implement:<event>":
      return { next: taskNext("implement", need(event.task, "a task")), status: "running" };
    case "implement:<same>":
      return { next: taskNext("implement", need(task, "a task")), status: "running" };
    case "checks:<same>":
      return { next: taskNext("checks", need(task, "a task")), status: "running" };
    case "review:<same>":
      return { next: taskNext("review", need(task, "a task")), status: "running" };
    case "commit:<same>":
      return { next: taskNext("commit", need(task, "a task")), status: "running" };
    default:
      return { next: row.to, status: "running" };
  }
}
