import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
import { RunError } from "../../src/run/errors.js";
import { NEVER_FAILS_NAMES, neverFails } from "../../src/run/engine/plan-file.js";
import {
  clarifyPrompt,
  criterionText,
  conflictText,
  implementPrompt,
  isRisky,
  loadAgent,
  loadSkill,
  planPrompt,
  reviewPrompt,
  specPrompt,
} from "../../src/run/prompts.js";

/** Whitespace as one space: agent files wrap their lines. */
const flat = (t: string): string => t.replace(/\s+/g, " ");

const AGENT = "---\nname: code-reviewer\nmodel: opus\n---\n\nYou are a code reviewer. RULE-X: every issue needs evidence.\n8. **Task review**: judge it.\n";

/** A project with `.claude/agents/<name>.md`. */
function agentProject(name = "code-reviewer", body = AGENT): string {
  const dir = mkdtempSync(join(tmpdir(), "prompts-"));
  mkdirSync(join(dir, ".claude", "agents"), { recursive: true });
  writeFileSync(join(dir, ".claude", "agents", `${name}.md`), body);
  return dir;
}

/** A project with the shipped implementer agent, as `generate` deploys it. */
const IMPL = agentProject("implementer", readFileSync(new URL("../../templates/claude/agents/implementer.md", import.meta.url), "utf8"));

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
    const p = flat(implementPrompt(IMPL, { taskId: "Q1", taskDesc: "d", criteria: [], feedback: null, commands: { test: "", lint: "", verify: "" } }));
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
    expect(first(implementPrompt(IMPL, { taskId: "T1", taskDesc: "d", criteria: [], feedback: null, commands: { test: "", lint: "", verify: "" } }))).toBe("# Role: implement");
    // v04 AC-64: a legal way out instead of changing a wrong test.
    const p64 = flat(implementPrompt(IMPL, { taskId: "T1", taskDesc: "d", criteria: [], feedback: null, commands: { test: "", lint: "", verify: "" } }));
    expect(p64).toMatch(/existing test, or the task's verify, contradicts a criterion/);
    expect(p64).toContain("TEST_CONFLICT");
    expect(p64).toMatch(/not written in this attempt/);
    expect(first(reviewPrompt(agentProject(), { taskId: "T1", taskDesc: "d", criteria: [], diff: "", report: "", verify: "" }))).toBe("# Role: review");
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
    // By title, never by number: 0.4.3 added a step to /spec, and "step 7" became Review (hotfix 0.4.4).
    expect(p).toContain("Skip the step **Hand over** of the skill");
    expect(p).not.toMatch(/step \d/i);
    // The skill still has that step, under that title.
    const skill = readFileSync(join(repoRoot, "templates/claude/skills/spec/SKILL.md"), "utf8");
    expect(skill).toMatch(/^\d+\. \*\*Hand over\.\*\*/m);
    expect(skill).toMatch(/^\d+\. \*\*Review\.\*\*/m);
    expect(p).toMatch(/the driver commits the spec and stops for the human's merge/);
    expect(p).toMatch(/do not ask about committing, merging or handing over/i);
  });

  it("v04 AC-59: spec says the driver checks its Terms with trace --terms: glossary or (local)", () => {
    const p = specPrompt(project("spec", "skill"), { stage: "A1", title: "t", description: "d", answers: [] });
    expect(p).toMatch(/the driver checks your `## Terms` with `trace --terms`/i);
    expect(p).toMatch(/goes into the glossary in this change/);
    expect(p).toMatch(/marked `\(local\)`/);
  });

  it("v04 AC-17: plan embeds the /plan skill, the one source of 'every task ends green'; the prompt has no copy", () => {
    const dir = project("plan", "PLAN SKILL $ARGUMENTS");
    const p = planPrompt(dir, { stage: "A1", title: "Login", comment: "make it smaller" });
    expect(p).toContain("PLAN SKILL A1");
    // One source (0.4.5): the rule is the skill's, so a fake skill without it gives a prompt without it.
    expect(p).not.toContain("every task ends green");
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
    // One source: the names come from the driver's list, so a pattern added there must reach the skill (0.4.5).
    for (const name of NEVER_FAILS_NAMES) {
      const last = /^a last line (.+)$/.exec(name);
      if (last) expect(flat).toMatch(new RegExp(`last line[^.]*\`${last[1]}\``));
      else expect(flat).toContain(`\`${name}\``);
    }
  });

  it("0.4.5: the /plan skill allows a verify that is only `true` for a docs-only task, as the driver does", () => {
    const skill = readFileSync(new URL("../../templates/claude/skills/plan/SKILL.md", import.meta.url), "utf8").replace(/\s+/g, " ");
    expect(neverFails("true")).toBeNull();
    expect(skill).toMatch(/Never `true`, except a task that changes only documentation/);
  });

  it("v04 AC-64: the conflict text quotes the criterion it names, found by its id at the line start", () => {
    const criteria = ["- **AC-1:** see AC-2: below", "- **AC-2:** greet with Hello", "- **AC-21:** other"];
    const t = conflictText({ test: "a.test.ts:greets", criterion: "AC-2", reason: "wants Hi" }, criteria);
    expect(t).toContain("Test: a.test.ts:greets");
    expect(t).toContain("- **AC-2:** greet with Hello");
    expect(t).not.toContain("see AC-2: below");
    expect(t).not.toContain("AC-21");
    expect(t).toContain("Reason: wants Hi");
    expect(conflictText({ test: "t", criterion: "the README says fixed", reason: "r" }, [])).toContain("Criterion: the README says fixed");
  });

  it("v04 AC-4: implement labels feedback FROM THE PROGRAM", () => {
    const p = implementPrompt(IMPL, {
      taskId: "T1",
      taskDesc: "do it",
      criteria: ["- **AC-1:** x"],
      feedback: "lint failed",
      commands: { test: "", lint: "", verify: "" },
    });
    expect(p).toContain("FROM THE PROGRAM");
    expect(p).toContain("lint failed");
    expect(p).toContain("- **AC-1:** x");
    expect(flat(p)).toMatch(/failing test first/);
    expect(flat(p)).toMatch(/do not commit/);
    expect(implementPrompt(IMPL, { taskId: "T1", taskDesc: "d", criteria: [], feedback: null, commands: { test: "", lint: "", verify: "" } })).not.toContain(
      "FROM THE PROGRAM"
    );
  });

  it("v04 AC-4: implement lists the shell commands it may run, from the same list as --allowedTools", () => {
    const commands = { test: "npm test", lint: "", verify: ".claude/bin/trace && npm test -- --test-name-pattern A2" };
    const p = implementPrompt(IMPL, { taskId: "T1", taskDesc: "d", criteria: [], feedback: null, commands });
    expect(p).toContain("- `npm test` (any arguments)");
    expect(p).toContain("- `git status`, `git diff`, `git log`, `git show` (any arguments)");
    expect(p).toContain("- `.claude/bin/trace && npm test -- --test-name-pattern A2` (exactly)");
    expect(p).toMatch(/anything else is denied, so do not try it/i);
    expect(p.slice(p.indexOf("Shell commands you may run"))).not.toContain("lint");
  });

  it("v04 AC-4: review labels the report UNVERIFIED CLAIMS FROM THE IMPLEMENTER", () => {
    const p = reviewPrompt(agentProject(), { taskId: "T1", taskDesc: "d", criteria: ["c"], diff: "+line", report: "all good", verify: "" });
    expect(p).toContain("UNVERIFIED CLAIMS FROM THE IMPLEMENTER");
    expect(p).toContain("all good");
    expect(p).toContain("+line");
    expect(p).toMatch(/verify proves/);
  });

  it("v04 AC-67: review takes its rules from the code-reviewer agent, without the frontmatter", () => {
    const p = reviewPrompt(agentProject(), { taskId: "T1", taskDesc: "d", criteria: ["c"], diff: "+line", report: "r", verify: "" });
    expect(p).toContain("RULE-X: every issue needs evidence.");
    expect(p).toContain("Review rules (.claude/agents/code-reviewer.md):");
    expect(p).not.toContain("name: code-reviewer");
    expect(p).not.toContain("model: opus");
    // The rules come before the data, so the role reads them first.
    expect(p.indexOf("RULE-X")).toBeLessThan(p.indexOf("+line"));
  });

  it("v04 AC-67: implement takes its rules from the implementer agent and points at its driver mode", () => {
    const p = implementPrompt(IMPL, { taskId: "T1", taskDesc: "d", criteria: [], feedback: null, commands: { test: "", lint: "", verify: "" } });
    expect(p).toContain("Rules (.claude/agents/implementer.md); follow 'Under the driver':");
    expect(p).toContain("You implement one task.");
    expect(p).not.toContain("name: implementer");
    expect(() => implementPrompt(agentProject(), { taskId: "T1", taskDesc: "d", criteria: [], feedback: null, commands: { test: "", lint: "", verify: "" } })).toThrow(
      /agent not found: .*implementer\.md \(run agent-stack update\)/
    );
  });

  it("v04 AC-67: the implementer agent has a chat mode and a driver mode; both have the test conflict exit", () => {
    const agent = readFileSync(new URL("../../templates/claude/agents/implementer.md", import.meta.url), "utf8");
    const flat = agent.replace(/\s+/g, " ");
    expect(agent).toMatch(/^## In a chat$/m);
    expect(agent).toMatch(/^## Under the driver$/m);
    const chat = flat.slice(flat.indexOf("## In a chat"), flat.indexOf("## Under the driver"));
    const driver = flat.slice(flat.indexOf("## Under the driver"));
    expect(chat).toContain("Run `.claude/bin/verify <id>`");
    expect(chat).toContain("STATUS: DONE | IN PROGRESS | BLOCKED | TEST_CONFLICT");
    expect(driver).toMatch(/never run `\.claude\/bin\/verify`/);
    expect(driver).toMatch(/answer in the caller's schema/i);
    expect(flat).toMatch(/existing test, or the task's verify, contradicts a criterion/);
  });

  it("v04 AC-67: the review gets the task's verify, or (none)", () => {
    const base = { taskId: "T1", taskDesc: "d", criteria: ["c"], diff: "+line", report: "r" };
    expect(reviewPrompt(agentProject(), { ...base, verify: "pnpm vitest run a.test.ts" })).toContain("Verify: `pnpm vitest run a.test.ts`");
    expect(reviewPrompt(agentProject(), { ...base, verify: "" })).toContain("Verify: (none)");
  });

  it("v04 AC-67: the frontmatter is removed with CRLF, a BOM or none at all; an empty body is out of date", () => {
    const body = (text: string): string => loadAgent(agentProject("x", text), "x");
    expect(body("---\r\nname: x\r\n---\r\nRules here.\r\n")).toBe("Rules here.");
    expect(body("\uFEFF---\nname: x\n---  \nRules here.\n")).toBe("Rules here.");
    expect(body("Rules here.\n---\nmore\n")).toBe("Rules here.\n---\nmore");
    expect(() => body("---\nname: x\n---\n\n")).toThrow(/agent .*x\.md is out of date: no rules \(run agent-stack update --force, or add it\)/);
  });

  it("v04 AC-67: an old implementer without 'Under the driver', or a code-reviewer without 'Task review', exits 1", () => {
    const old = agentProject("implementer", "---\nname: implementer\n---\nRun `.claude/bin/verify <id>`.\n");
    const args = { taskId: "T1", taskDesc: "d", criteria: [], feedback: null, commands: { test: "", lint: "", verify: "" } };
    expect(() => implementPrompt(old, args)).toThrow(/implementer\.md is out of date: no "## Under the driver" section/);
    const rv = agentProject("code-reviewer", "---\nname: code-reviewer\n---\nYou are a code reviewer.\n");
    expect(() => reviewPrompt(rv, { taskId: "T1", taskDesc: "d", criteria: [], diff: "", report: "", verify: "" })).toThrow(
      /code-reviewer\.md is out of date: no "Task review" item/
    );
  });

  it("v04 AC-67: a missing code-reviewer agent is a RunError with exit code 1 that says to run generate", () => {
    const dir = agentProject("other");
    try {
      loadAgent(dir, "code-reviewer");
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(RunError);
      expect((e as RunError).exitCode).toBe(1);
      expect((e as RunError).message).toBe(`agent not found: ${join(dir, ".claude", "agents", "code-reviewer.md")} (run agent-stack update)`);
    }
  });

  it("v04 AC-67: the code-reviewer agent answers in the caller's schema and says what the task verdicts mean", () => {
    const agent = readFileSync(new URL("../../templates/claude/agents/code-reviewer.md", import.meta.url), "utf8");
    const flat = agent.replace(/\s+/g, " ");
    expect(flat).toMatch(/If the caller gives a JSON schema, answer in that schema/);
    for (const field of ["`spec`", "`quality`", "`verifyProves`"]) expect(flat).toContain(field);
    expect(flat).toMatch(/imagine the line that does it removed/i);
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
