/**
 * The implement step and the outputs of earlier calls. Spec: docs/specs/v04/SPEC.md, AC-16, AC-30, AC-35, AC-38,
 * AC-43, AC-63, AC-64.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { runCheck } from "../checks.js";
import type { Model } from "../claude.js";
import { isObj } from "../config.js";
import { RunError } from "../errors.js";
import { currentBranch, git, headSha, softReset } from "../git.js";
import { conflictText, implementPrompt } from "../prompts.js";
import { parseImplement, type ImplementOutput } from "../schemas.js";
import { runDir } from "../store.js";
import type { Role, RunTask } from "../types.js";
import { roleCall } from "./call.js";
import { Interrupted, resumeHint, type Ctx, type StepHandler, type TaskInfo } from "./context.js";
import { baseOf, failAttempt, taskOf, timedOutError, toLimit } from "./task-core.js";
import { taskNext } from "./transitions.js";

const short = (sha: string): string => sha.slice(0, 7);
const CONTINUE = "continue from `git status`.";

/** AC-16: Opus for tier L, a risky task, a fix task and every attempt after the first; else Sonnet. */
export function implementModel(info: TaskInfo, task: RunTask): Model {
  return info.tier === "L" || info.risky || info.fix || task.attempts > 1 ? "opus" : "sonnet";
}

/**
 * Undoes a commit or a branch switch the role made (AC-43): soft-reset to taskBase, keeping the edits, and
 * return to the run's branch. The feedback for the failed attempt, or null when nothing was undone.
 */
function undoGitSideEffects(ctx: Ctx, task: RunTask): string | null {
  const dir = ctx.projectDir;
  const base = baseOf(task);
  const want = ctx.run.branch;
  const notes: string[] = [];
  const branch = currentBranch(dir);
  /**
   * Soft-resets the checked-out branch to the base when the role committed on top of it. Off the run's branch
   * a HEAD that does not descend from the base (main in task mode) is left alone: only the switch is undone.
   */
  const resetCommits = (onRunBranch: boolean): void => {
    if (headSha(dir) === base) return;
    if (!git(dir, ["merge-base", "--is-ancestor", base, "HEAD"]).ok) {
      if (!onRunBranch) return;
      throw new RunError(
        `implement moved HEAD off the task base ${short(base)}; it cannot be reset without losing work. Restore ${want} at ${short(base)} by hand, then ${resumeHint(ctx.run.id)}.`,
        1
      );
    }
    softReset(dir, base);
    const note = `You made a commit; the program soft-reset it to ${short(base)} and kept your edits. Do not commit: the program commits.`;
    if (!notes.includes(note)) notes.push(note);
  };
  resetCommits(branch === want);
  if (branch !== want) {
    const r = git(dir, ["checkout", "-q", want]);
    if (!r.ok) {
      throw new RunError(
        `implement left the run's branch ${want} for ${branch ?? "a detached HEAD"}, and the program cannot return without losing edits: ${(r.stderr || r.stdout).trim()}. Move the edits to ${want} by hand, then ${resumeHint(ctx.run.id)}.`,
        1
      );
    }
    notes.push(`You switched to ${branch ?? "a detached HEAD"}; the program returned to ${want} with your edits. Do not branch.`);
    // A commit made on the run's branch before the switch (AC-43).
    resetCommits(true);
  }
  return notes.length > 0 ? notes.join("\n") : null;
}

/** The start of the note the start check leaves (AC-63); a review keeps it when it replaces the notes. */
export const START_NOTE = "its verify passed before the task started";

/**
 * AC-63: before a task's first attempt, its verify through `.claude/bin/verify --dry`: guarded like any verify
 * (tasks.json is re-read, so a rewritten command is not run raw), and nothing is recorded. Green there means
 * the verify cannot show the task's work, e.g. a test file that is missing and skipped. It is a note, not a
 * stop: a docs-only task may well have `true`.
 */
async function startCheck(ctx: Ctx, task: RunTask, info: TaskInfo): Promise<void> {
  const cmd = ctx.mode.startCheck?.(ctx, task, info) ?? null;
  if (cmd === null) return;
  const r = await runCheck(cmd, ctx.projectDir, ctx.cfg.checkTimeoutMin * 60_000, ctx.signal);
  if (r.aborted) throw new Interrupted();
  if (r.timedOut) throw timedOutError(ctx, "start check", r);
  if (!r.skipped && r.exit === 0) task.notes.push(`${START_NOTE}, so it may not test the task: check the plan's verify.`);
}

export const implement: StepHandler = async (ctx, id) => {
  const task = taskOf(ctx, id);
  const info = ctx.mode.taskInfo(ctx, task.id);
  if (task.taskBase === null) {
    // The base is read first: a failure after the note would leave taskBase null and add the note twice.
    const base = headSha(ctx.projectDir);
    await startCheck(ctx, task, info);
    task.taskBase = base;
  }
  if (task.attempts === 0) task.attempts = 1;
  const commands = { test: ctx.cfg.commands.test, lint: ctx.cfg.commands.lint, verify: info.verify };
  const prompt = implementPrompt(ctx.projectDir, { taskId: task.id, taskDesc: info.desc, criteria: info.criteria, feedback: task.lastFeedback, commands });
  const r = await roleCall(ctx, { role: "implement", commands }, implementModel(info, task), prompt, parseImplement);
  const stray = undoGitSideEffects(ctx, task);
  if (r.kind === "fuse") {
    // A call stopped by error_max_budget_usd left edits, like an interrupted implement (AC-30, AC-35).
    const why = r.midCall ? `The previous session hit the budget limit. Its edits are kept; ${CONTINUE}` : null;
    const feedback = [why, stray].filter((s) => s !== null).join("\n");
    if (feedback !== "") task.lastFeedback = feedback;
    return toLimit(ctx, "fuse", ctx.run.next);
  }
  if (r.kind === "failed") {
    const why = `The previous attempt ended early: ${r.message}. Its edits are kept; ${CONTINUE}`;
    return failAttempt(ctx, task, stray ? `${why}\n${stray}` : why);
  }
  ctx.run.humanDecisions.push(...r.value.needsHumanDecision);
  if (stray) return failAttempt(ctx, task, stray);
  if (r.value.status === "BLOCKED") {
    task.lastFeedback = `The implementer reported BLOCKED: ${r.value.report}`;
    return toLimit(ctx, "blocked", taskNext("implement", task.id));
  }
  if (r.value.status === "TEST_CONFLICT") {
    // AC-64: the human decides; the attempt is not counted and its edits stay.
    task.lastFeedback = conflictText(r.value.conflict, info.criteria);
    return toLimit(ctx, "test-conflict", taskNext("implement", task.id));
  }
  return { type: "done" };
};

/**
 * The output of the newest `calls/<n>-<role>.json`, or null when there is none, it is not valid, or (with
 * `newerThan`, epoch ms) it was written at or before that time.
 */
export function lastCallOutput<T>(ctx: Ctx, role: Role, parse: (v: unknown) => T | string, newerThan: number | null = null): T | null {
  const dir = join(runDir(ctx.projectDir, ctx.run.id), "calls");
  const pattern = new RegExp(`^(\\d+)-${role}\\.json$`);
  let best = -1;
  for (const name of existsSync(dir) ? readdirSync(dir) : []) {
    const m = pattern.exec(name);
    if (m) best = Math.max(best, Number(m[1]));
  }
  if (best < 0) return null;
  const file = join(dir, `${best}-${role}.json`);
  if (newerThan !== null && statSync(file).mtimeMs <= newerThan) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  const out = parse(isObj(raw) && isObj(raw.result) ? raw.result.structured_output : undefined);
  return typeof out === "string" ? null : out;
}

/** The newest implement call's output: the DONE that checks, review and commit act on. */
export function lastImplement(ctx: Ctx): ImplementOutput {
  const out = lastCallOutput(ctx, "implement", parseImplement);
  if (out === null) {
    const dir = join(runDir(ctx.projectDir, ctx.run.id), "calls");
    throw new RunError(`No valid implement output in ${dir}; the run cannot go on. Cancel it: agent-stack run --cancel ${ctx.run.id}.`, 1);
  }
  return out;
}
