/** Shared types of the pipeline driver (`agent-stack run`). Spec: docs/specs/v04/SPEC.md. */

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
}

export interface AnswerRecord {
  question: string;
  answer: string;
}

export interface RunFile {
  id: string;
  description: string;
  mode: Mode;
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
  stagePattern: string;
  /** The glossary file: the spec role may edit it, and `trace --terms` checks against it; "" for none (AC-8, AC-59). */
  glossary: string;
}
