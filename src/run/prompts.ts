/** Prompt builders for the driver's roles. Spec: docs/specs/v04/SPEC.md, "Role prompts". */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { allowedCommandLines, type CallCommands } from "./claude.js";
import { RunError } from "./errors.js";
import type { TestConflict } from "./schemas.js";
import type { AnswerRecord } from "./types.js";

/** Reads `.claude/skills/<name>/SKILL.md` and fills `$ARGUMENTS` and `${CLAUDE_SKILL_DIR}`. */
export function loadSkill(projectDir: string, name: string, args: string): string {
  const skillDir = join(projectDir, ".claude", "skills", name);
  const file = join(skillDir, "SKILL.md");
  if (!existsSync(file)) throw new RunError(`skill not found: ${file} (run agent-stack generate)`, 1);
  return readFileSync(file, "utf8")
    .split("${CLAUDE_SKILL_DIR}")
    .join(skillDir)
    .split("$ARGUMENTS")
    .join(args);
}

/**
 * The body of `.claude/agents/<name>.md` without its frontmatter: the rules a role takes from the project's
 * agent, so the driver keeps no copy of them (AC-67).
 */
export function loadAgent(projectDir: string, name: string): string {
  const file = join(projectDir, ".claude", "agents", `${name}.md`);
  if (!existsSync(file)) throw new RunError(`agent not found: ${file} (run agent-stack generate)`, 1);
  const text = readFileSync(file, "utf8");
  const m = /^---\r?\n[\s\S]*?\r?\n---\r?\n/.exec(text);
  return (m ? text.slice(m[0].length) : text).trim();
}

export function clarifyPrompt(p: { description: string; used: string[] }): string {
  return [
    "# Role: clarify",
    "",
    "The driver has created the run. You only read the code and ask; you must not edit files, write a spec or a plan, run commands, commit or branch.",
    "",
    "Task description:",
    p.description,
    "",
    "- Ask at most 5 questions, each with a recommended answer.",
    "- Size the work: task, story or epic.",
    "- Propose a stage id and title; for an epic, a split into stages (id and goal each).",
    "- A stage id is letters then digits, like A1, and is not one already in use.",
    `- Ids already in use: ${p.used.length > 0 ? p.used.join(", ") : "none"}.`,
  ].join("\n");
}

export function specPrompt(
  projectDir: string,
  p: { stage: string; title: string; description: string; answers: AnswerRecord[] }
): string {
  const skill = loadSkill(projectDir, "spec", `${p.stage} ${p.title}`);
  const answers = p.answers.map((a) => `Q: ${a.question}\nA: ${a.answer}`).join("\n\n");
  return [
    "# Role: spec",
    "",
    "The driver has created the branch and asked the grill questions. You must not commit, branch, push, write code or write a plan.",
    "",
    "Task: write a full spec; the branch exists; do not commit, branch or push.",
    "",
    "Skip step 7 (Hand over) of the skill: the driver commits the spec and stops for the human's merge. Do not ask about committing, merging or handing over.",
    "",
    "The driver checks your `## Terms` with `trace --terms` after you: a word the project shares goes into the glossary in this change, and a word for this spec only is marked `(local)`.",
    "",
    "Description:",
    p.description,
    "",
    "Answers (these are the grill):",
    answers || "(none)",
    "",
    "The /spec skill follows.",
    "",
    skill,
  ].join("\n");
}

export function planPrompt(projectDir: string, p: { stage: string; title: string; comment?: string | null }): string {
  const skill = loadSkill(projectDir, "plan", `${p.stage} ${p.title}`);
  const lines = [
    "# Role: plan",
    "",
    "The driver has merged the spec and created the branch. You must not run verify, commit or implement, and you change no files.",
    "",
    "The spec is merged and the branch exists: skip the precondition and step 1; do not run verify, commit or implement.",
    "",
    "Do not write tasks.json: return the tasks in your output (`tasks`); the program writes the file.",
    "",
    "Rule: **every task ends green**: its test is written first inside the task and its verify passes when the task is done; no test-only tasks.",
  ];
  if (p.comment) lines.push("", "The human rejected the previous plan. Their comment:", p.comment);
  lines.push("", "The /plan skill follows.", "", skill);
  return lines.join("\n");
}

export function implementPrompt(
  projectDir: string,
  p: {
    taskId: string;
    taskDesc: string;
    criteria: string[];
    feedback: string | null;
    /** The commands its `--allowedTools` is built from; the prompt lists the same (AC-4). */
    commands: CallCommands;
  }
): string {
  const lines = [
    "# Role: implement",
    "",
    "The driver has created the branch and recorded this task's base. The driver, not you, runs the checks, the review and the commit. You must not commit, branch or edit tasks.json.",
    "",
    "Rules (.claude/agents/implementer.md); follow 'Under the driver':",
    "",
    loadAgent(projectDir, "implementer"),
    "",
    `Task ${p.taskId}: ${p.taskDesc}`,
    "",
    "Criteria:",
    ...(p.criteria.length ? p.criteria : ["(none listed)"]),
  ];
  if (p.feedback) lines.push("", "FROM THE PROGRAM (checks or review of the previous attempt):", p.feedback);
  lines.push(
    "",
    "Shell commands you may run (anything else is denied, so do not try it):",
    ...allowedCommandLines(p.commands),
    "",
    "End with a report of what you did."
  );
  return lines.join("\n");
}

/** The test conflict as gate:limit shows it and the retried implement reads it (AC-64). */
export function conflictText(c: TestConflict, criteria: string[]): string {
  // By id at the line start, as criterionText cuts it: a body that mentions the id does not match.
  const id = c.criterion.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const text = criteria.find((t) => new RegExp(`^\\s*[-*]\\s*\\*\\*${id}:\\*\\*`).test(t));
  return [
    "The implementer reported TEST_CONFLICT and left the test alone.",
    `Test: ${c.test}`,
    `Criterion: ${c.criterion}`,
    ...(text ? [text] : []),
    `Reason: ${c.reason}`,
  ].join("\n");
}

export function reviewPrompt(
  projectDir: string,
  p: { taskId: string; taskDesc: string; criteria: string[]; diff: string; report: string }
): string {
  return [
    "# Role: review",
    "",
    "The driver has run the checks and cut this diff. You review only; you must not edit files, run commands, commit or branch.",
    "",
    "Review rules (.claude/agents/code-reviewer.md):",
    "",
    loadAgent(projectDir, "code-reviewer"),
    "",
    `Task ${p.taskId}: ${p.taskDesc}`,
    "",
    "Criteria:",
    ...(p.criteria.length ? p.criteria : ["(none listed)"]),
    "",
    "Diff:",
    p.diff,
    "",
    "UNVERIFIED CLAIMS FROM THE IMPLEMENTER (check them against the diff, do not trust them):",
    p.report,
    "",
    "Return two verdicts (spec, quality) and whether the task's verify proves its criteria.",
  ].join("\n");
}

/** The criterion line `- **AC-n:**` and its continuation lines, up to the next criterion or heading. Empty if absent. */
export function criterionText(specMd: string, acId: string): string {
  const lines = specMd.split(/\r?\n/);
  const start = lines.findIndex((l) => l.replace(/^\s*[-*]\s*\*\*/, "").startsWith(`${acId}:`) && /^\s*[-*]\s*\*\*/.test(l));
  if (start < 0) return "";
  const out = [lines[start]];
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (/^#{1,6}\s/.test(l) || /^\s*[-*]\s*\*\*AC-\d+/.test(l)) break;
    out.push(l);
  }
  while (out.length > 1 && out[out.length - 1].trim() === "") out.pop();
  return out.join("\n");
}

const RISK_WORDS = [
  "security",
  "auth",
  "authentication",
  "authorization",
  "permission",
  "password",
  "token",
  "secret",
  "payment",
  "money",
  "billing",
  "migration",
  "concurrency",
  "race",
  "lock",
];
const RISK_RE = new RegExp(`\\b(?:${RISK_WORDS.join("|")})\\b`, "i");

export function isRisky(text: string): boolean {
  return RISK_RE.test(text);
}
