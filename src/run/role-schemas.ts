/** JSON schemas of role outputs (for `--json-schema`). Spec: docs/specs/v04/SPEC.md, "Role outputs". The hand-written validation is in schemas.ts. */
import type { Role } from "./types.js";

export interface RoleSchema {
  type: "object";
  required: string[];
  properties: Record<string, unknown>;
}

export type CommitType = "feat" | "fix" | "refactor" | "test" | "docs" | "chore" | "perf";

export const COMMIT_TYPES: CommitType[] = ["feat", "fix", "refactor", "test", "docs", "chore", "perf"];

const strArray = { type: "array", items: { type: "string" } };

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
          required: ["id", "ac", "tier", "complexity", "desc", "verify", "passes"],
          properties: {
            id: { type: "string" },
            ac: strArray,
            tier: { enum: ["S", "M", "L"] },
            complexity: { enum: ["low", "medium", "high"] },
            splitReason: { type: "string" },
            desc: { type: "string" },
            verify: { type: "string" },
            passes: { const: false },
          },
        },
      },
      needsHumanDecision: strArray,
    },
  },
  // scout1: every item is checked (one bad item is a schema ending, AC-10); no maxItems, so a long list passes (AC-21).
  scout: {
    type: "object",
    required: ["entries"],
    properties: {
      entries: {
        type: "array",
        items: {
          type: "object",
          required: ["path", "why"],
          properties: { path: { type: "string" }, lines: { type: "string" }, why: { type: "string" } },
        },
      },
    },
  },
  implement: {
    type: "object",
    required: ["status", "report", "commit", "needsHumanDecision"],
    properties: {
      status: { enum: ["DONE", "BLOCKED", "TEST_CONFLICT"] },
      // AC-64: required with TEST_CONFLICT and only then (checked by hand, in schemas.ts).
      conflict: {
        type: "object",
        description: "Only with TEST_CONFLICT: the existing test or verify that contradicts a criterion.",
        required: ["test", "criterion", "reason"],
        properties: { test: { type: "string" }, criterion: { type: "string" }, reason: { type: "string" } },
      },
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
