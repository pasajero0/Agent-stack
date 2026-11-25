/** Shared types of the pipeline driver (`agent-stack run`). Spec: docs/specs/v04/SPEC.md. */
import type { SpecFlow } from "./spec-flow.js";
import type { Routing } from "./routing.js";

export type Mode = "task" | "quick";

export type RunStatus = "running" | "waiting" | "finished" | "cancelled";

export type LimitReason = "attempts" | "blocked" | "review-loop" | "fuse" | "decision" | "test-conflict" | "tests-changed";

/** Roles the driver calls Claude in. */
export type Role = "clarify" | "spec" | "plan" | "implement" | "review";

/** The step a run is at. `implement:<task>`, `checks:<task>`, `review:<task>`, `commit:<task>` carry a task id. */
export type Next =
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
  | `implement:${string}`
  | `checks:${string}`
  | `review:${string}`
  | `commit:${string}`;

/** `{calls: n}`, `{usd: n}` or `"off"`. */
export type Fuse = { calls: number } | { usd: number } | "off";

export interface CheckResult {
  cmd: string;
  exit: number;
  skipped: boolean;
}

export interface RunTask {
  id: string;
  taskBase: string | null;
  attempts: number;
  blockingCount: number | null;
  lastFeedback: string | null;
  checks: CheckResult[];
  notes: string[];
  /** Changes to frozen tests or check configs the human allowed at gate:limit (AC-66). */
  allowedChanges: string[];
  /** The changes gate:limit (tests changed) listed; `a` allows exactly these (AC-66). */
  pendingChanges: string[];
  /** sha, `"empty"` for an empty diff, or null before the commit. */
  commit: string | null;
}

export interface GateRecord {
  gate: string;
  at: string;
  decision: string;
  comment: string | null;
  /** A plan-approve reject: the sha256 of the rejected tasks.json, so a leftover copy is known exactly (AC-14). */
  planSha256?: string;
  /** A gate:limit (decision) retry: the items the role asked, given back with the answer (AC-57). */
  asked?: string[];
  /** A gate:limit retry with a comment: the reason it answered, so a test conflict's answer stays implement's (AC-64). */
  reason?: LimitReason;
  /** A spec-approve reject: HEAD then, so the spec commit of the re-run is told from the rejected one (AC-87). */
  head?: string;
}

export interface AnswerRecord {
  question: string;
  answer: string;
}

/** One answer a gate prompt takes (AC-68, Contract "Gate card"). */
export interface CardAnswer {
  key: string;
  /** What comes after the key: null for the key alone. */
  follows: "text" | "number" | null;
  label: string;
}

/** One line of input a gate reads. `default` is what Enter gives, or null when Enter is no answer. */
export interface CardPrompt {
  text: string;
  default: string | null;
  answers: CardAnswer[];
}

export type CardGate = "answers" | "spec-merge" | "spec-approve" | "plan-approve" | "limit" | "accept";

/** What a gate shows, built once and kept in the run file (AC-68, AC-69). */
export interface GateCard {
  gate: CardGate;
  run: string;
  stage: string | null;
  title: string;
  /** Never cut here; the terminal print cuts long one-line facts, except those in `keep`. */
  facts: string[];
  /** Indexes of facts the terminal never cuts: a verify, an AC-66 change line, an AC-32 line. */
  keep: number[];
  prompts: CardPrompt[];
  /** The inputs the gate decides on: the sha256 of tasks.json (plan-approve), the HEAD commit (accept); else null. */
  source: string | null;
  /** The command to continue. */
  hint: string;
}

/** One step as it ran (AC-81); `end` is null while it runs or a gate waits. */
export interface StepTime {
  step: Next;
  start: string;
  end: string | null;
}

export interface RunFile {
  id: string;
  description: string;
  mode: Mode;
  /** Copied from gates.json at start; a run file without it reads as `merge` (AC-83, AC-84). */
  specFlow: SpecFlow;
  /** The git blob id of the spec the human approved at gate:spec-approve, or null (AC-87). */
  specApproved: string | null;
  status: RunStatus;
  next: Next;
  returnTo: Next | null;
  limitReason: LimitReason | null;
  /** Clarify output (questions, size, stage, split); null until clarify returns. */
  proposal: unknown;
  /** The confirmed stage id; null until gate:answers confirms one (and for an epic or a quick run). */
  stage: string | null;
  /** `--stage`: the stage id gate:answers proposes, or null. */
  stagePrefill: string | null;
  size: "task" | "story" | "epic" | null;
  branch: string;
  baseCommit: string | null;
  tasks: RunTask[];
  createdBranches: string[];
  gates: GateRecord[];
  answers: AnswerRecord[];
  humanDecisions: string[];
  costUsd: number;
  /** Calls whose cost is unknown (killed, or no total_cost_usd); not counted in costUsd (AC-62). */
  costUnknownCalls: number;
  calls: number;
  fuse: Fuse;
  /** The card of the gate the run waits at; null when it waits at none (AC-68). */
  card: GateCard | null;
  /** The time of every step (AC-81). */
  steps: StepTime[];
  /** The estimated work time in seconds, or null (AC-81). */
  estimateSec: number | null;
  /**
   * `run quick --cell`: the routing cell Q1 uses instead of M·medium, or null (effort1 AC-28). Optional: a run file
   * without the key (0.4.7) reads as null and stays without it.
   */
  cell?: string | null;
}

/** gates.json values the driver needs, with the `run` key's defaults filled in. */
export interface RunConfig {
  maxTurns: number;
  fuse: Fuse;
  stepTimeoutMin: number;
  checkTimeoutMin: number;
  quickReviewLines: number;
  commands: { test: string; lint: string };
  lintMatch: string[];
  /** Test files (`gates.json → testGlobs`): their tests are frozen at a task's base (AC-66). */
  testGlobs: string[];
  specsDir: string;
  adrDir: string;
  baseBranch: string;
  /** `gates.json → specFlow` (AC-83). */
  specFlow: SpecFlow;
  stagePattern: string;
  /** The glossary file: the spec role may edit it, and `trace --terms` checks against it; "" for none (AC-8, AC-59). */
  glossary: string;
  /** `gates.json → routing`, checked when the run starts or resumes (effort1 AC-1). */
  routing: Routing;
}
