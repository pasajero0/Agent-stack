/** JSON schemas of role outputs (for `--json-schema`) and hand-written validation. Spec: docs/specs/v04/SPEC.md, "Role outputs". */
import type { Role } from "./types.js";

export interface RoleSchema {
  type: "object";
  required: string[];
  properties: Record<string, unknown>;
}

const strArray = { type: "array", items: { type: "string" } };
const COMMIT_TYPES: CommitType[] = ["feat", "fix", "refactor", "test", "docs", "chore", "perf"];

export const roleSchemas: Record<Role, RoleSchema> = {
  clarify: {
    type: "object",
    required: ["questions", "size", "stage"],
    properties: {
      questions: {
        type: "array",
        maxItems: 5,
        items: {
          type: "object",
          required: ["text", "recommended"],
          properties: { text: { type: "string" }, recommended: { type: "string" } },
        },
      },
      size: { enum: ["task", "story", "epic"] },
      stage: {
        type: "object",
        required: ["id", "title"],
        properties: { id: { type: "string", minLength: 1 }, title: { type: "string", minLength: 1 } },
      },
      split: {
        type: "array",
        description: "Stages of the epic, {id, goal} each. Required when size is epic.",
        items: {
          type: "object",
          required: ["id", "goal"],
          properties: { id: { type: "string" }, goal: { type: "string" } },
        },
      },
    },
  },
  spec: {
    type: "object",
    required: ["specPath", "summary", "needsHumanDecision"],
    properties: { specPath: { type: "string" }, summary: { type: "string" }, needsHumanDecision: strArray },
  },
  plan: {
    type: "object",
    required: ["summary", "tasks", "needsHumanDecision"],
    properties: {
      summary: { type: "string" },
      // The driver writes these to tasks.json and checks them as a "Valid plan" (AC-12, AC-45).
      tasks: {
        type: "array",
        items: {
          type: "object",
          required: ["id", "ac", "tier", "desc", "verify", "passes"],
          properties: {
            id: { type: "string" },
            ac: strArray,
            tier: { enum: ["S", "M", "L"] },
            desc: { type: "string" },
            verify: { type: "string" },
            passes: { const: false },
          },
        },
      },
      needsHumanDecision: strArray,
    },
  },
  implement: {
    type: "object",
    required: ["status", "report", "commit", "needsHumanDecision"],
    properties: {
      status: { enum: ["DONE", "BLOCKED"] },
      report: { type: "string" },
      commit: {
        type: "object",
        required: ["type", "subject"],
        properties: { type: { enum: COMMIT_TYPES }, subject: { type: "string", minLength: 1 } },
      },
      needsHumanDecision: strArray,
    },
  },
  review: {
    type: "object",
    required: ["spec", "quality", "verifyProves", "findings"],
    properties: {
      spec: { enum: ["pass", "fail", "unclear"] },
      quality: { enum: ["pass", "fail"] },
      verifyProves: { type: "boolean" },
      findings: {
        type: "array",
        items: {
          type: "object",
          required: ["severity", "text"],
          properties: {
            severity: { enum: ["critical", "warning", "suggestion"] },
            text: { type: "string" },
            file: { type: "string" },
            line: { type: "number" },
          },
        },
      },
    },
  },
};

export interface Finding {
  severity: "critical" | "warning" | "suggestion";
  text: string;
  file?: string;
  line?: number;
}

export interface ReviewOutput {
  spec: "pass" | "fail" | "unclear";
  quality: "pass" | "fail";
  verifyProves: boolean;
  findings: Finding[];
}

export interface ClarifyOutput {
  questions: { text: string; recommended: string }[];
  size: "task" | "story" | "epic";
  stage: { id: string; title: string };
  split?: { id: string; goal: string }[];
}

export interface SpecOutput {
  specPath: string;
  summary: string;
  needsHumanDecision: string[];
}

export interface PlanOutput {
  summary: string;
  /** Checked as a valid plan by the plan step (parsePlan), not here. */
  tasks: unknown[];
  needsHumanDecision: string[];
}

export type CommitType = "feat" | "fix" | "refactor" | "test" | "docs" | "chore" | "perf";

export interface ImplementOutput {
  status: "DONE" | "BLOCKED";
  report: string;
  commit: { type: CommitType; subject: string };
  needsHumanDecision: string[];
}

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStr(v: unknown): v is string {
  return typeof v === "string";
}

function isStrArray(v: unknown): boolean {
  return Array.isArray(v) && v.every(isStr);
}

function oneOf(v: unknown, allowed: string[]): boolean {
  return isStr(v) && allowed.includes(v);
}

function checkFinding(f: unknown): boolean {
  if (!isObj(f)) return false;
  return (
    oneOf(f.severity, ["critical", "warning", "suggestion"]) &&
    isStr(f.text) &&
    (f.file === undefined || isStr(f.file)) &&
    (f.line === undefined || typeof f.line === "number")
  );
}

function pair(v: unknown, a: string, b: string): boolean {
  return isObj(v) && isStr(v[a]) && isStr(v[b]);
}

function nonEmpty(v: unknown): boolean {
  return isStr(v) && v.trim() !== "";
}

function checkClarify(o: Obj): string | null {
  if (!Array.isArray(o.questions) || o.questions.length > 5 || !o.questions.every((q) => pair(q, "text", "recommended")))
    return "questions must be at most 5 of {text, recommended}";
  if (!oneOf(o.size, ["task", "story", "epic"])) return "size must be task, story or epic";
  if (!pair(o.stage, "id", "title") || !isObj(o.stage) || !nonEmpty(o.stage.id) || !nonEmpty(o.stage.title))
    return "stage must be {id, title}, both non-empty";
  if (o.split !== undefined && !(Array.isArray(o.split) && o.split.every((s) => pair(s, "id", "goal"))))
    return "split must be {id, goal}[]";
  if (o.size === "epic" && !(Array.isArray(o.split) && o.split.length > 0)) return "split is required for an epic";
  return null;
}

function checkImplement(o: Obj): string | null {
  if (!oneOf(o.status, ["DONE", "BLOCKED"])) return "status must be DONE or BLOCKED";
  if (!isStr(o.report)) return "report must be a string";
  if (!isObj(o.commit) || !oneOf(o.commit.type, COMMIT_TYPES) || !nonEmpty(o.commit.subject))
    return "commit must be {type, subject} with a known type and a non-empty subject";
  if (!isStrArray(o.needsHumanDecision)) return "needsHumanDecision must be a string array";
  return null;
}

function checkReview(o: Obj): string | null {
  if (!oneOf(o.spec, ["pass", "fail", "unclear"])) return "spec must be pass, fail or unclear";
  if (!oneOf(o.quality, ["pass", "fail"])) return "quality must be pass or fail";
  if (typeof o.verifyProves !== "boolean") return "verifyProves must be a boolean";
  if (!Array.isArray(o.findings) || !o.findings.every(checkFinding))
    return "findings must be {severity, text, file?, line?}[]";
  return null;
}

/** Returns null when `value` matches the role's schema, else a short description of the first mismatch. */
export function validateOutput(role: Role, value: unknown): string | null {
  if (!isObj(value)) return "output must be an object";
  switch (role) {
    case "clarify":
      return checkClarify(value);
    case "spec":
      if (!isStr(value.specPath)) return "specPath must be a string";
      if (!isStr(value.summary)) return "summary must be a string";
      return isStrArray(value.needsHumanDecision) ? null : "needsHumanDecision must be a string array";
    case "plan":
      if (!isStr(value.summary)) return "summary must be a string";
      if (!Array.isArray(value.tasks)) return "tasks must be an array";
      return isStrArray(value.needsHumanDecision) ? null : "needsHumanDecision must be a string array";
    case "implement":
      return checkImplement(value);
    case "review":
      return checkReview(value);
  }
}

/** Critical findings, plus 1 for each of: spec fail, quality fail, verify does not prove. */
export function blockingCount(r: ReviewOutput): number {
  return (
    r.findings.filter((f) => f.severity === "critical").length +
    (r.spec === "fail" ? 1 : 0) +
    (r.quality === "fail" ? 1 : 0) +
    (r.verifyProves ? 0 : 1)
  );
}

export function isBlocking(r: ReviewOutput): boolean {
  return blockingCount(r) > 0;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter(isStr) : [];
}

function sizeOf(v: unknown): ClarifyOutput["size"] | null {
  return v === "task" || v === "story" || v === "epic" ? v : null;
}

function commitTypeOf(v: unknown): CommitType | null {
  return COMMIT_TYPES.find((t) => t === v) ?? null;
}

/** Validates against the clarify schema, then returns the typed value; else the mismatch text. */
export function parseClarify(v: unknown): ClarifyOutput | string {
  const err = validateOutput("clarify", v);
  if (err !== null) return err;
  if (!isObj(v) || !isObj(v.stage)) return "output must be an object";
  const size = sizeOf(v.size);
  if (size === null || !isStr(v.stage.id) || !isStr(v.stage.title)) return "size must be task, story or epic";
  const questions: ClarifyOutput["questions"] = [];
  for (const q of Array.isArray(v.questions) ? v.questions : []) {
    if (isObj(q) && isStr(q.text) && isStr(q.recommended)) questions.push({ text: q.text, recommended: q.recommended });
  }
  const out: ClarifyOutput = { questions, size, stage: { id: v.stage.id, title: v.stage.title } };
  if (Array.isArray(v.split)) {
    out.split = [];
    for (const s of v.split) if (isObj(s) && isStr(s.id) && isStr(s.goal)) out.split.push({ id: s.id, goal: s.goal });
  }
  return out;
}

export function parseSpecOut(v: unknown): SpecOutput | string {
  const err = validateOutput("spec", v);
  if (err !== null) return err;
  if (!isObj(v) || !isStr(v.specPath) || !isStr(v.summary)) return "output must be an object";
  return { specPath: v.specPath, summary: v.summary, needsHumanDecision: strings(v.needsHumanDecision) };
}

export function parsePlanOut(v: unknown): PlanOutput | string {
  const err = validateOutput("plan", v);
  if (err !== null) return err;
  if (!isObj(v) || !isStr(v.summary) || !Array.isArray(v.tasks)) return "output must be an object";
  return { summary: v.summary, tasks: v.tasks, needsHumanDecision: strings(v.needsHumanDecision) };
}

export function parseImplement(v: unknown): ImplementOutput | string {
  const err = validateOutput("implement", v);
  if (err !== null) return err;
  if (!isObj(v) || !isObj(v.commit) || !isStr(v.report) || !isStr(v.commit.subject)) return "output must be an object";
  const type = commitTypeOf(v.commit.type);
  const status = v.status === "DONE" || v.status === "BLOCKED" ? v.status : null;
  if (type === null || status === null) return "commit must be {type, subject} with a known type";
  return {
    status,
    report: v.report,
    commit: { type, subject: v.commit.subject },
    needsHumanDecision: strings(v.needsHumanDecision),
  };
}

function severityOf(v: unknown): Finding["severity"] | null {
  return v === "critical" || v === "warning" || v === "suggestion" ? v : null;
}

export function parseReview(v: unknown): ReviewOutput | string {
  const err = validateOutput("review", v);
  if (err !== null) return err;
  if (!isObj(v) || typeof v.verifyProves !== "boolean") return "output must be an object";
  const spec = v.spec === "pass" || v.spec === "fail" || v.spec === "unclear" ? v.spec : null;
  const quality = v.quality === "pass" || v.quality === "fail" ? v.quality : null;
  if (spec === null || quality === null) return "spec or quality is invalid";
  const findings: Finding[] = [];
  for (const f of Array.isArray(v.findings) ? v.findings : []) {
    if (!isObj(f) || !isStr(f.text)) continue;
    const severity = severityOf(f.severity);
    if (severity === null) continue;
    const finding: Finding = { severity, text: f.text };
    if (isStr(f.file)) finding.file = f.file;
    if (typeof f.line === "number") finding.line = f.line;
    findings.push(finding);
  }
  return { spec, quality, verifyProves: v.verifyProves, findings };
}
