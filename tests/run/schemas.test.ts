import { describe, expect, it } from "vitest";
import {
  blockingCount,
  isBlocking,
  parseClarify,
  parseImplement,
  parsePlanOut,
  parseReview,
  parseSpecOut,
  roleSchemas,
  validateOutput,
} from "../../src/run/schemas.js";

const review = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  spec: "pass",
  quality: "pass",
  verifyProves: true,
  findings: [],
  ...over,
});

describe("role schemas", () => {
  it("v04 AC-37: has one object schema per role with required fields", () => {
    for (const role of ["clarify", "spec", "plan", "implement", "review"] as const) {
      const s = roleSchemas[role];
      expect(s.type).toBe("object");
      expect(s.required.length).toBeGreaterThan(0);
    }
  });

  it("v04 AC-37: accepts valid outputs of every role", () => {
    expect(
      validateOutput("clarify", {
        questions: [{ text: "q", recommended: "a" }],
        size: "epic",
        stage: { id: "A1", title: "t" },
        split: [{ id: "A2", goal: "g" }],
      })
    ).toBeNull();
    expect(validateOutput("spec", { specPath: "p", summary: "s", needsHumanDecision: [] })).toBeNull();
    expect(validateOutput("plan", { summary: "s", needsHumanDecision: ["x"] })).toBeNull();
    expect(
      validateOutput("implement", {
        status: "DONE",
        report: "r",
        commit: { type: "feat", subject: "s" },
        needsHumanDecision: [],
      })
    ).toBeNull();
    expect(validateOutput("review", review({ findings: [{ severity: "warning", text: "t", line: 3 }] }))).toBeNull();
  });

  it("v04 AC-37: names the problem for a mismatch", () => {
    expect(validateOutput("review", null)).toMatch(/object/);
    expect(validateOutput("review", review({ spec: "maybe" }))).toMatch(/spec/);
    expect(validateOutput("review", review({ verifyProves: "yes" }))).toMatch(/verifyProves/);
    expect(validateOutput("review", review({ findings: [{ severity: "bad", text: "t" }] }))).toMatch(/findings/);
    expect(validateOutput("plan", { summary: "s" })).toMatch(/needsHumanDecision/);
    expect(validateOutput("implement", { status: "DONE", report: "r", needsHumanDecision: [] })).toMatch(/commit/);
    expect(
      validateOutput("implement", {
        status: "DONE",
        report: "r",
        commit: { type: "wip", subject: "s" },
        needsHumanDecision: [],
      })
    ).toMatch(/commit/);
  });

  it("v04 AC-37: clarify allows at most 5 questions and needs a split for an epic", () => {
    const q = { text: "q", recommended: "a" };
    const base = { questions: [q, q, q, q, q, q], size: "task", stage: { id: "A1", title: "t" } };
    expect(validateOutput("clarify", base)).toMatch(/questions/);
    expect(validateOutput("clarify", { ...base, questions: [q], size: "epic" })).toMatch(/split/);
    expect(validateOutput("clarify", { ...base, questions: [q] })).toBeNull();
  });
});

describe("exact required arrays", () => {
  it("v04 AC-37: roleSchemas.required matches the spec's Role outputs", () => {
    expect(roleSchemas.clarify.required).toEqual(["questions", "size", "stage"]);
    expect(roleSchemas.spec.required).toEqual(["specPath", "summary", "needsHumanDecision"]);
    expect(roleSchemas.plan.required).toEqual(["summary", "needsHumanDecision"]);
    expect(roleSchemas.implement.required).toEqual(["status", "report", "commit", "needsHumanDecision"]);
    expect(roleSchemas.review.required).toEqual(["spec", "quality", "verifyProves", "findings"]);
  });

  it("v04 AC-37: the clarify schema describes split and minLength 1 on ids, titles and subjects", () => {
    const props = roleSchemas.clarify.properties;
    expect(JSON.stringify(props.split)).toMatch(/epic/);
    expect(JSON.stringify(props.stage)).toContain('"minLength":1');
    expect(JSON.stringify(roleSchemas.implement.properties.commit)).toContain('"minLength":1');
  });

  it("v04 AC-37: empty stage id, stage title and commit subject are rejected", () => {
    const base = { questions: [], size: "task", stage: { id: "A1", title: "t" } };
    expect(validateOutput("clarify", { ...base, stage: { id: "", title: "t" } })).toMatch(/stage/);
    expect(validateOutput("clarify", { ...base, stage: { id: "A1", title: "" } })).toMatch(/stage/);
    expect(
      validateOutput("implement", {
        status: "DONE",
        report: "r",
        commit: { type: "feat", subject: "" },
        needsHumanDecision: [],
      })
    ).toMatch(/commit/);
  });
});

describe("typed parse functions", () => {
  it("v04 AC-37: parseClarify returns the typed value or an error string", () => {
    const ok = parseClarify({
      questions: [{ text: "q", recommended: "a" }],
      size: "epic",
      stage: { id: "A1", title: "t" },
      split: [{ id: "A2", goal: "g" }],
    });
    expect(typeof ok).toBe("object");
    expect(ok).toMatchObject({ size: "epic", split: [{ id: "A2", goal: "g" }] });
    expect(typeof parseClarify({ size: "epic" })).toBe("string");
  });

  it("v04 AC-37: parseSpecOut and parsePlanOut", () => {
    expect(parseSpecOut({ specPath: "p", summary: "s", needsHumanDecision: ["x"] })).toEqual({
      specPath: "p",
      summary: "s",
      needsHumanDecision: ["x"],
    });
    expect(typeof parseSpecOut({ summary: "s" })).toBe("string");
    expect(parsePlanOut({ summary: "s", needsHumanDecision: [] })).toEqual({ summary: "s", needsHumanDecision: [] });
    expect(typeof parsePlanOut(5)).toBe("string");
  });

  it("v04 AC-37: parseImplement and parseReview", () => {
    const impl = { status: "BLOCKED", report: "r", commit: { type: "fix", subject: "s" }, needsHumanDecision: [] };
    expect(parseImplement(impl)).toEqual(impl);
    expect(typeof parseImplement({ ...impl, commit: { type: "fix", subject: "" } })).toBe("string");
    const rev = parseReview(review({ findings: [{ severity: "critical", text: "t", file: "f", line: 2 }] }));
    expect(rev).toEqual({
      spec: "pass",
      quality: "pass",
      verifyProves: true,
      findings: [{ severity: "critical", text: "t", file: "f", line: 2 }],
    });
    expect(typeof parseReview(review({ quality: "meh" }))).toBe("string");
  });
});

describe("blocking review", () => {
  it("v04 AC-37: counts critical findings plus each set flag", () => {
    const r = {
      spec: "fail" as const,
      quality: "fail" as const,
      verifyProves: false,
      findings: [
        { severity: "critical" as const, text: "a" },
        { severity: "critical" as const, text: "b" },
        { severity: "warning" as const, text: "c" },
      ],
    };
    expect(blockingCount(r)).toBe(5);
    expect(isBlocking(r)).toBe(true);
  });

  it("v04 AC-37: unclear, warnings and suggestions do not block", () => {
    const r = {
      spec: "unclear" as const,
      quality: "pass" as const,
      verifyProves: true,
      findings: [
        { severity: "warning" as const, text: "w" },
        { severity: "suggestion" as const, text: "s" },
      ],
    };
    expect(blockingCount(r)).toBe(0);
    expect(isBlocking(r)).toBe(false);
  });
});
