/** Prompt builders for the driver's roles. Spec: docs/specs/v04/SPEC.md, "Role prompts". */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { allowedCommandLines, type CallCommands } from "./claude.js";
import { RunError } from "./errors.js";
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

export function clarifyPrompt(p: { description: string }): string {
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

export function implementPrompt(p: {
  taskId: string;
  taskDesc: string;
  criteria: string[];
  feedback: string | null;
  /** The commands its `--allowedTools` is built from; the prompt lists the same (AC-4). */
  commands: CallCommands;
}): string {
  const lines = [
    "# Role: implement",
    "",
    "The driver has created the branch and recorded this task's base. The driver, not you, runs the checks, the review and the commit. You must not commit, branch or edit tasks.json.",
    "",
    `Task ${p.taskId}: ${p.taskDesc}`,
    "",
    "Criteria:",
    ...(p.criteria.length ? p.criteria : ["(none listed)"]),
  ];
  if (p.feedback) lines.push("", "FROM THE PROGRAM (checks or review of the previous attempt):", p.feedback);
  lines.push(
    "",
    "Write the failing test first, see it fail, then the code; touch only this task; do not commit, branch or edit `tasks.json`.",
    "",
    "Shell commands you may run (anything else is denied, so do not try it):",
    ...allowedCommandLines(p.commands),
    "",
    "End with a report of what you did."
  );
  return lines.join("\n");
}

export function reviewPrompt(p: {
  taskId: string;
  taskDesc: string;
  criteria: string[];
  diff: string;
  report: string;
}): string {
  return [
    "# Role: review",
    "",
    "The driver has run the checks and cut this diff. You review only; you must not edit files, run commands, commit or branch.",
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
