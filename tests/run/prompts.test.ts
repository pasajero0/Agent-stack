import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { RunError } from "../../src/run/errors.js";
import {
  clarifyPrompt,
  criterionText,
  implementPrompt,
  isRisky,
  loadSkill,
  planPrompt,
  reviewPrompt,
  specPrompt,
} from "../../src/run/prompts.js";

function project(skill: string, body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "prompts-"));
  mkdirSync(join(dir, ".claude", "skills", skill), { recursive: true });
  writeFileSync(join(dir, ".claude", "skills", skill, "SKILL.md"), body);
  return dir;
}

const SPEC = `# Spec

## Acceptance criteria

- **AC-1:** WHEN a user logs in, THE SYSTEM SHALL check the token.
  - continuation line
- **AC-13:** THE SYSTEM SHALL do other things.

## Next heading
- **AC-2:** last one
`;

describe("loadSkill", () => {
  it("v04 AC-4: embeds the skill and fills $ARGUMENTS and ${CLAUDE_SKILL_DIR}", () => {
    const dir = project("spec", "# Spec for $ARGUMENTS\nsee ${CLAUDE_SKILL_DIR}/template.md and $ARGUMENTS");
    const text = loadSkill(dir, "spec", "A1 title");
    expect(text).toBe(`# Spec for A1 title\nsee ${join(dir, ".claude", "skills", "spec")}/template.md and A1 title`);
  });

  it("v04 AC-4: a missing skill is a RunError with exit code 1", () => {
    const dir = mkdtempSync(join(tmpdir(), "prompts-"));
    try {
      loadSkill(dir, "plan", "A1");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(RunError);
      expect((e as RunError).exitCode).toBe(1);
    }
  });
});

describe("role prompts", () => {
  it("v04 AC-4: clarify asks at most 5 questions and says what not to do", () => {
    const p = clarifyPrompt({ description: "add login", used: [] });
    expect(p).toContain("add login");
    expect(p).toMatch(/at most 5/);
    expect(p).toMatch(/must not/i);
  });

  it("v04 AC-48: clarify gets the stage-id rule and the ids already in use", () => {
    const p = clarifyPrompt({ description: "d", used: ["A1", "A2"] });
    expect(p).toContain("letters then digits, like A1");
    expect(p).toContain("Ids already in use: A1, A2");
    expect(clarifyPrompt({ description: "d", used: [] })).toContain("Ids already in use: none");
  });

  it("v04 AC-4: implement needs no test for a change to documentation only", () => {
    const p = implementPrompt({ taskId: "Q1", taskDesc: "d", criteria: [], feedback: null, commands: { test: "", lint: "", verify: "" } });
    expect(p).toMatch(/documentation only \(Markdown, comments, no behaviour\) needs no test; say so in the report/);
  });

  it("v04 AC-4: clarify does not claim a branch exists", () => {
    const p = clarifyPrompt({ description: "d", used: [] });
    expect(p).toContain("The driver has created the run.");
    expect(p).not.toContain("its branch");
  });

  it("v04 AC-4: the first non-empty line of every prompt names the role", () => {
    const first = (t: string): string => t.split("\n").find((l) => l.trim() !== "") ?? "";
    const spec = project("spec", "S");
    const plan = project("plan", "P");
    expect(first(clarifyPrompt({ description: "d", used: [] }))).toBe("# Role: clarify");
    expect(first(specPrompt(spec, { stage: "A1", title: "t", description: "d", answers: [] }))).toBe("# Role: spec");
    expect(first(planPrompt(plan, { stage: "A1", title: "t" }))).toBe("# Role: plan");
    expect(first(implementPrompt({ taskId: "T1", taskDesc: "d", criteria: [], feedback: null, commands: { test: "", lint: "", verify: "" } }))).toBe("# Role: implement");
    // v04 AC-64: a legal way out instead of changing a wrong test.
    const p64 = implementPrompt({ taskId: "T1", taskDesc: "d", criteria: [], feedback: null, commands: { test: "", lint: "", verify: "" } });
    expect(p64).toMatch(/existing test, or the task's verify, contradicts a criterion/);
    expect(p64).toContain("TEST_CONFLICT");
    expect(p64).toMatch(/not written in this attempt/);
    expect(first(reviewPrompt({ taskId: "T1", taskDesc: "d", criteria: [], diff: "", report: "" }))).toBe("# Role: review");
  });

  it("v04 AC-4: spec embeds the skill, marks the answers as the grill, forbids commit", () => {
    const dir = project("spec", "SKILL BODY for $ARGUMENTS");
    const p = specPrompt(dir, {
      stage: "A1",
      title: "Login",
      description: "add login",
      answers: [{ question: "Which?", answer: "Email" }],
    });
    expect(p).toContain("SKILL BODY for A1 Login");
    expect(p).toContain("these are the grill");
    expect(p).toContain("Which?");
    expect(p).toContain("Email");
    expect(p).toMatch(/do not commit, branch or push/);
    expect(p).toMatch(/write a full spec/);
  });

  it("v04 AC-4: spec skips the skill's hand-over step; the driver commits and stops for the merge", () => {
    const p = specPrompt(project("spec", "skill"), { stage: "A1", title: "t", description: "d", answers: [] });
    expect(p).toMatch(/skip step 7 \(Hand over\)/i);
    expect(p).toMatch(/the driver commits the spec and stops for the human's merge/);
    expect(p).toMatch(/do not ask about committing, merging or handing over/i);
  });

  it("v04 AC-59: spec says the driver checks its Terms with trace --terms: glossary or (local)", () => {
    const p = specPrompt(project("spec", "skill"), { stage: "A1", title: "t", description: "d", answers: [] });
    expect(p).toMatch(/the driver checks your `## Terms` with `trace --terms`/i);
    expect(p).toMatch(/goes into the glossary in this change/);
    expect(p).toMatch(/marked `\(local\)`/);
  });

  it("v04 AC-17: plan says every task ends green, tests first, no test-only tasks", () => {
    const dir = project("plan", "PLAN SKILL $ARGUMENTS");
    const p = planPrompt(dir, { stage: "A1", title: "Login", comment: "make it smaller" });
    expect(p).toContain("PLAN SKILL A1");
    expect(p).toContain("every task ends green");
    expect(p).toMatch(/test is written first inside the task/);
    expect(p).toMatch(/no test-only tasks/);
    expect(p).toContain("make it smaller");
    expect(p).toMatch(/skip the precondition and step 1/);
  });

  it("v04 AC-17: the /plan skill says every task ends green, no test-only tasks, and a driver retry runs on Opus", () => {
    const skill = readFileSync(new URL("../../templates/claude/skills/plan/SKILL.md", import.meta.url), "utf8");
    const flat = skill.replace(/\s+/g, " ");
    expect(flat).toMatch(/every task ends green/i);
    expect(flat).toMatch(/there are no test-only tasks/i);
    expect(flat).toMatch(/under the driver \(`agent-stack run`\), a retry runs on Opus/i);
  });

  it("v04 AC-65: the /plan skill says a verify must be able to fail, with the same patterns", () => {
    const skill = readFileSync(new URL("../../templates/claude/skills/plan/SKILL.md", import.meta.url), "utf8");
    const flat = skill.replace(/\s+/g, " ");
    expect(flat).toMatch(/`verify` must be able to fail/);
    for (const p of ["|| true", "|| :", "|| echo", "|| exit 0", "; true", "; exit 0", "2>/dev/null ||", "set +e"]) {
      expect(flat).toContain(`\`${p}\``);
    }
  });

  it("v04 AC-4: implement labels feedback FROM THE PROGRAM", () => {
    const p = implementPrompt({
      taskId: "T1",
      taskDesc: "do it",
      criteria: ["- **AC-1:** x"],
      feedback: "lint failed",
      commands: { test: "", lint: "", verify: "" },
    });
    expect(p).toContain("FROM THE PROGRAM");
    expect(p).toContain("lint failed");
    expect(p).toContain("- **AC-1:** x");
    expect(p).toMatch(/failing test first/);
    expect(p).toMatch(/do not commit/);
    expect(implementPrompt({ taskId: "T1", taskDesc: "d", criteria: [], feedback: null, commands: { test: "", lint: "", verify: "" } })).not.toContain(
      "FROM THE PROGRAM"
    );
  });

  it("v04 AC-4: implement lists the shell commands it may run, from the same list as --allowedTools", () => {
    const commands = { test: "npm test", lint: "", verify: ".claude/bin/trace && npm test -- --test-name-pattern A2" };
    const p = implementPrompt({ taskId: "T1", taskDesc: "d", criteria: [], feedback: null, commands });
    expect(p).toContain("- `npm test` (any arguments)");
    expect(p).toContain("- `git status`, `git diff`, `git log`, `git show` (any arguments)");
    expect(p).toContain("- `.claude/bin/trace && npm test -- --test-name-pattern A2` (exactly)");
    expect(p).toMatch(/anything else is denied, so do not try it/i);
    expect(p).not.toContain("lint");
  });

  it("v04 AC-4: review labels the report UNVERIFIED CLAIMS FROM THE IMPLEMENTER", () => {
    const p = reviewPrompt({ taskId: "T1", taskDesc: "d", criteria: ["c"], diff: "+line", report: "all good" });
    expect(p).toContain("UNVERIFIED CLAIMS FROM THE IMPLEMENTER");
    expect(p).toContain("all good");
    expect(p).toContain("+line");
    expect(p).toMatch(/verify proves/);
  });
});

describe("criterionText and isRisky", () => {
  it("v04 AC-13: criterionText takes the line and continuation up to the next criterion or heading", () => {
    expect(criterionText(SPEC, "AC-1")).toBe(
      "- **AC-1:** WHEN a user logs in, THE SYSTEM SHALL check the token.\n  - continuation line"
    );
    expect(criterionText(SPEC, "AC-13")).toBe("- **AC-13:** THE SYSTEM SHALL do other things.");
    expect(criterionText(SPEC, "AC-2")).toBe("- **AC-2:** last one");
    expect(criterionText(SPEC, "AC-9")).toBe("");
  });

  it("v04 AC-13: isRisky matches whole risk words case-insensitively", () => {
    expect(isRisky("Fix the Auth check")).toBe(true);
    expect(isRisky("rotate the TOKEN")).toBe(true);
    expect(isRisky("a database migration")).toBe(true);
    expect(isRisky("lock, then go")).toBe(true);
    expect(isRisky("the author of the file")).toBe(false);
    expect(isRisky("tokenizer and locksmith")).toBe(false);
    expect(isRisky("plain work")).toBe(false);
  });
});
