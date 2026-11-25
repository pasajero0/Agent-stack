/**
 * Run file validation: builds a fresh `RunFile` from parsed JSON, or names the first bad field. `store.ts`
 * reads and writes the file; this module only checks it.
 */
import { isObj, parseFuse } from "./config.js";
import { parseCell } from "./routing.js";
import { DEFAULT_SPEC_FLOW, SPEC_FLOWS } from "./spec-flow.js";
import type {
  AnswerRecord,
  CardAnswer,
  CardGate,
  CardPrompt,
  CheckResult,
  GateCard,
  GateRecord,
  LimitReason,
  Mode,
  Next,
  RunFile,
  RunStatus,
  RunTask,
  StepTime,
} from "./types.js";

/** Thrown by `toRunFile`; the message is the first bad field. */
export class Malformed extends Error {}
const bad = (field: string): never => {
  throw new Malformed(field);
};

type Obj = Record<string, unknown>;

const STATUSES: readonly RunStatus[] = ["running", "waiting", "finished", "cancelled"];
const MODES: readonly Mode[] = ["task", "quick"];
const LIMITS: readonly LimitReason[] = ["attempts", "blocked", "review-loop", "fuse", "decision", "test-conflict", "tests-changed"];
const SIZES = ["task", "story", "epic"] as const;
const FIXED_NEXT = [
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
    // A run file from before AC-66 has none.
    allowedChanges: o.allowedChanges === undefined ? [] : strings(o.allowedChanges, `${f}.allowedChanges`),
    pendingChanges: o.pendingChanges === undefined ? [] : strings(o.pendingChanges, `${f}.pendingChanges`),
    commit: strOrNull(o.commit, `${f}.commit`),
  };
}

/** A git object id (sha-1 or sha-256): it goes to git as an argument, so nothing else may pass (AC-87). */
function gitId(v: unknown, f: string): string {
  return typeof v === "string" && /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(v) ? v : bad(f);
}

function gate(v: unknown, f: string): GateRecord {
  const o = obj(v, f);
  const g: GateRecord = { gate: str(o.gate, f), at: str(o.at, f), decision: str(o.decision, f), comment: strOrNull(o.comment, f) };
  if (o.planSha256 !== undefined) {
    g.planSha256 = typeof o.planSha256 === "string" && /^[0-9a-f]{64}$/.test(o.planSha256) ? o.planSha256 : bad(`${f}.planSha256`);
  }
  if (o.asked !== undefined) g.asked = strings(o.asked, `${f}.asked`);
  if (o.reason !== undefined) g.reason = oneOf(LIMITS, o.reason, `${f}.reason`);
  if (o.head !== undefined) g.head = gitId(o.head, `${f}.head`);
  return g;
}

function answer(v: unknown, f: string): AnswerRecord {
  const o = obj(v, f);
  return { question: str(o.question, f), answer: str(o.answer, f) };
}

const CARD_GATES: readonly CardGate[] = ["answers", "spec-merge", "spec-approve", "plan-approve", "limit", "accept"];

function cardAnswer(v: unknown, f: string): CardAnswer {
  const o = obj(v, f);
  const follows = o.follows === null ? null : oneOf(["text", "number"] as const, o.follows, `${f}.follows`);
  return { key: str(o.key, f), follows, label: str(o.label, f) };
}

function cardPrompt(v: unknown, f: string): CardPrompt {
  const o = obj(v, f);
  return { text: str(o.text, f), default: strOrNull(o.default, `${f}.default`), answers: arr(o.answers, `${f}.answers`, cardAnswer) };
}

/** The kept gate card (AC-68); a run file from before it has none. */
function card(v: unknown, f: string): GateCard | null {
  if (v === undefined || v === null) return null;
  const o = obj(v, f);
  return {
    gate: oneOf(CARD_GATES, o.gate, `${f}.gate`),
    run: str(o.run, `${f}.run`),
    stage: strOrNull(o.stage, `${f}.stage`),
    title: str(o.title, `${f}.title`),
    facts: strings(o.facts, `${f}.facts`),
    keep: arr(o.keep, `${f}.keep`, (x) => count(x, `${f}.keep`)),
    prompts: arr(o.prompts, `${f}.prompts`, cardPrompt),
    source: strOrNull(o.source, `${f}.source`),
    hint: str(o.hint, `${f}.hint`),
  };
}

function stepTime(v: unknown, f: string): StepTime {
  const o = obj(v, f);
  return { step: next(o.step, `${f}.step`), start: str(o.start, `${f}.start`), end: strOrNull(o.end, `${f}.end`) };
}

/** Field-by-field check of a parsed run file; throws `Malformed(<field>)`. */
export function toRunFile(v: unknown, id: string): RunFile {
  const o = obj(v, "run.json");
  if (o.id !== id) bad("id");
  const costUsd = typeof o.costUsd === "number" && Number.isFinite(o.costUsd) && o.costUsd >= 0 ? o.costUsd : bad("costUsd");
  const mode = oneOf(MODES, o.mode, "mode");
  return {
    id,
    description: str(o.description, "description"),
    mode,
    // AC-84: a run file from before the spec flow reads as merge.
    specFlow: o.specFlow === undefined ? DEFAULT_SPEC_FLOW : oneOf(SPEC_FLOWS, o.specFlow, "specFlow"),
    specApproved: o.specApproved === undefined || o.specApproved === null ? null : gitId(o.specApproved, "specApproved"),
    status: oneOf(STATUSES, o.status, "status"),
    next: next(o.next, "next"),
    returnTo: o.returnTo === null ? null : next(o.returnTo, "returnTo"),
    limitReason: o.limitReason === null ? null : oneOf(LIMITS, o.limitReason, "limitReason"),
    proposal: o.proposal === null || isObj(o.proposal) ? o.proposal : bad("proposal"),
    stage: strOrNull(o.stage, "stage"),
    stagePrefill: strOrNull(o.stagePrefill, "stagePrefill"),
    size: o.size === null ? null : oneOf(SIZES, o.size, "size"),
    branch: str(o.branch, "branch"),
    baseCommit: strOrNull(o.baseCommit, "baseCommit"),
    tasks: arr(o.tasks, "tasks", task),
    createdBranches: strings(o.createdBranches, "createdBranches"),
    gates: arr(o.gates, "gates", (x) => gate(x, "gates")),
    answers: arr(o.answers, "answers", (x) => answer(x, "answers")),
    humanDecisions: strings(o.humanDecisions, "humanDecisions"),
    costUsd,
    // AC-62: a run file from before this field reads as 0.
    costUnknownCalls: o.costUnknownCalls === undefined ? 0 : count(o.costUnknownCalls, "costUnknownCalls"),
    calls: count(o.calls, "calls"),
    fuse: parseFuse(o.fuse) ?? bad("fuse"),
    card: card(o.card, "card"),
    // AC-81: a run file from before these fields has no times.
    steps: o.steps === undefined ? [] : arr(o.steps, "steps", stepTime),
    estimateSec: o.estimateSec === undefined || o.estimateSec === null ? null : count(o.estimateSec, "estimateSec"),
    // effort1 AC-31: a run file from before this field has none; only a quick run may name a cell.
    ...(o.cell === undefined ? {} : { cell: cellOf(o.cell, mode) }),
  };
}

function cellOf(v: unknown, mode: Mode): string | null {
  if (v === null) return null;
  return mode === "quick" && typeof v === "string" && parseCell(v) !== null ? v : bad("cell");
}
