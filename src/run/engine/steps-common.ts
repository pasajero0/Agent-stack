/**
 * Steps both modes share: base-check, implement, checks, review, commit. Spec: docs/specs/v04/SPEC.md,
 * AC-15/16/19/20/24/25, and the unhappy path AC-33/34/36..39/41..43/46/55.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { lintRuns, runCheck, verifyTail, type CheckRun } from "../checks.js";
import type { Model } from "../claude.js";
import { isObj } from "../config.js";
import { RunError } from "../errors.js";
import {
  commitPaths,
  currentBranch,
  git,
  headSha,
  normaliseHeader,
  softReset,
  taskDiffPaths,
} from "../git.js";
import { implementPrompt, reviewPrompt } from "../prompts.js";
import { blockingCount, isBlocking, parseImplement, parseReview, type ImplementOutput, type ReviewOutput } from "../schemas.js";
import { runDir } from "../store.js";
import type { LimitReason, Next, RunTask } from "../types.js";
import { judgeCall, roleCall } from "./call.js";
import { findTask, resumeHint, type CheckItem, type Ctx, type StepHandler, type TaskInfo } from "./context.js";
import { taskNext, type StepEvent, type StepKind } from "./transitions.js";

const short = (sha: string): string => sha.slice(0, 7);

/** The task of a task step; a `next` without one is an engine bug. */
function taskOf(ctx: Ctx, id: string | null): RunTask {
  if (id === null) throw new Error(`step ${ctx.run.next} has no task`);
  return findTask(ctx, id);
}

export function baseOf(task: RunTask): string {
  if (task.taskBase === null) throw new Error(`task ${task.id} has no taskBase yet`);
  return task.taskBase;
}

/** Goes to gate:limit for `reason`; retry or raise there returns to `returnTo` (AC-31). */
export function toLimit(ctx: Ctx, reason: LimitReason, returnTo: Next): StepEvent {
  ctx.run.limitReason = reason;
  ctx.run.returnTo = returnTo;
  return { type: reason === "fuse" ? "fuse" : "limit" };
}

/** A failed attempt: feedback recorded, then a new attempt or gate:limit (attempts) (AC-33). */
export function failAttempt(ctx: Ctx, task: RunTask, feedback: string): StepEvent {
  task.lastFeedback = feedback;
  if (task.attempts < ctx.mode.maxAttempts) {
    task.attempts += 1;
    return { type: "retry" };
  }
  return toLimit(ctx, "attempts", taskNext("implement", task.id));
}

/** Lint entries of the checks: per lint file, once without `{file}`, or one skipped entry when empty (AC-19, AC-56). */
export function lintItems(ctx: Ctx, task: RunTask): CheckItem[] {
  const lint = ctx.cfg.commands.lint;
  if (lint.trim() === "") return [{ label: "lint", cmd: "" }];
  const files = taskDiffPaths(ctx.projectDir, baseOf(task));
  return lintRuns(lint, files, ctx.cfg.lintMatch, ctx.projectDir).map((cmd) => ({ label: "lint", cmd }));
}

// ---- base-check ----

/** Runs `test` before any change; red is exit 1 with `next` kept (AC-15, AC-24, AC-41). */
const baseCheck: StepHandler = async (ctx) => {
  const r = await runCheck(ctx.cfg.commands.test, ctx.projectDir, ctx.cfg.checkTimeoutMin * 60_000);
  if (!r.skipped && r.exit !== 0) {
    throw new RunError(
      `base-check: \`${r.cmd}\` exited ${r.exit} before any change, so the base is red. Fix the base, then ${resumeHint(ctx.run.id)}.\n${r.tail}`,
      1
    );
  }
  return { type: "green", task: ctx.mode.firstTask(ctx) };
};

// ---- implement ----

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
  if (headSha(dir) !== base) {
    if (!git(dir, ["merge-base", "--is-ancestor", base, "HEAD"]).ok) {
      throw new RunError(
        `implement moved HEAD off the task base ${short(base)}; it cannot be reset without losing work. Restore ${want} at ${short(base)} by hand, then ${resumeHint(ctx.run.id)}.`,
        1
      );
    }
    softReset(dir, base);
    notes.push(`You made a commit; the program soft-reset it to ${short(base)} and kept your edits. Do not commit: the program commits.`);
  }
  if (branch !== want) {
    const r = git(dir, ["checkout", "-q", want]);
    if (!r.ok) {
      throw new RunError(
        `implement left the run's branch ${want} for ${branch ?? "a detached HEAD"}, and the program cannot return without losing edits: ${(r.stderr || r.stdout).trim()}. Move the edits to ${want} by hand, then ${resumeHint(ctx.run.id)}.`,
        1
      );
    }
    notes.push(`You switched to ${branch ?? "a detached HEAD"}; the program returned to ${want} with your edits. Do not branch.`);
  }
  return notes.length > 0 ? notes.join("\n") : null;
}

const implement: StepHandler = async (ctx, id) => {
  const task = taskOf(ctx, id);
  const info = ctx.mode.taskInfo(ctx, task.id);
  if (task.taskBase === null) task.taskBase = headSha(ctx.projectDir);
  if (task.attempts === 0) task.attempts = 1;
  const prompt = implementPrompt({ taskId: task.id, taskDesc: info.desc, criteria: info.criteria, feedback: task.lastFeedback });
  const commands = { test: ctx.cfg.commands.test, lint: ctx.cfg.commands.lint, verify: info.verify };
  const r = await roleCall(ctx, { role: "implement", commands }, implementModel(info, task), prompt, parseImplement);
  const stray = undoGitSideEffects(ctx, task);
  if (r.kind === "fuse") {
    if (stray) task.lastFeedback = stray;
    return toLimit(ctx, "fuse", ctx.run.next);
  }
  if (r.kind === "failed") {
    const why = `The previous attempt ended early: ${r.message}. Its edits are kept; continue from \`git status\`.`;
    return failAttempt(ctx, task, stray ? `${why}\n${stray}` : why);
  }
  ctx.run.humanDecisions.push(...r.value.needsHumanDecision);
  if (stray) return failAttempt(ctx, task, stray);
  if (r.value.status === "BLOCKED") {
    task.lastFeedback = `The implementer reported BLOCKED: ${r.value.report}`;
    return toLimit(ctx, "blocked", taskNext("implement", task.id));
  }
  return { type: "done" };
};

/** The newest implement call's output: the DONE that checks, review and commit act on. */
export function lastImplement(ctx: Ctx): ImplementOutput {
  const dir = join(runDir(ctx.projectDir, ctx.run.id), "calls");
  let best = -1;
  for (const name of readdirSync(dir)) {
    const m = /^(\d+)-implement\.json$/.exec(name);
    if (m) best = Math.max(best, Number(m[1]));
  }
  const fail = (): never => {
    throw new RunError(`No valid implement output in ${dir}; the run cannot go on. Cancel it: agent-stack run --cancel ${ctx.run.id}.`, 1);
  };
  if (best < 0) return fail();
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(join(dir, `${best}-implement.json`), "utf8"));
  } catch {
    return fail();
  }
  const result = isObj(raw) && isObj(raw.result) ? raw.result.structured_output : undefined;
  const out = parseImplement(result);
  return typeof out === "string" ? fail() : out;
}

// ---- checks ----

function checkFeedback(ctx: Ctx, item: CheckItem, r: CheckRun): string {
  const stage = ctx.run.stage;
  const tail = item.label === "verify" && stage ? verifyTail(ctx.projectDir, stage) || r.tail : r.tail;
  return `Check failed: \`${r.cmd}\` exited ${r.exit}. Last lines of its output:\n${tail}`;
}

/** Runs the mode's commands, by exit code only (AC-19); red is a failed attempt (AC-33). */
const checks: StepHandler = async (ctx, id) => {
  const task = taskOf(ctx, id);
  const info = ctx.mode.taskInfo(ctx, task.id);
  const items = ctx.mode.checkItems(ctx, task, info);
  const runs: CheckRun[] = [];
  for (const item of items) runs.push(await runCheck(item.cmd, ctx.projectDir, ctx.cfg.checkTimeoutMin * 60_000));
  task.checks = runs.map((r, i) => ({
    cmd: r.cmd.trim() === "" ? `(empty ${items[i]?.label ?? "check"} command)` : r.cmd,
    exit: r.exit,
    skipped: r.skipped,
  }));
  const red = runs.flatMap((r, i) => {
    const item = items[i];
    return item && !r.skipped && r.exit !== 0 ? [checkFeedback(ctx, item, r)] : [];
  });
  if (red.length > 0) return failAttempt(ctx, task, red.join("\n\n"));
  if (taskDiffPaths(ctx.projectDir, baseOf(task)).length === 0) return { type: "commit" };
  return ctx.mode.needsReview(ctx, task) ? { type: "review" } : { type: "commit" };
};

// ---- review ----

const MAX_FILE_CHARS = 20_000;

/** The task diff as text: tracked changes against the base, then each untracked file in full. */
export function taskDiffText(dir: string, base: string): string {
  const tracked = git(dir, ["diff", "--no-renames", base, "--", ".", ":(exclude).claude/tmp"]).stdout;
  const untracked = git(dir, ["ls-files", "--others", "--exclude-standard", "-z"])
    .stdout.split("\0")
    .filter((p) => p !== "" && !p.startsWith(".claude/tmp/"));
  const fresh = untracked.map((p) => {
    let body: string;
    try {
      body = readFileSync(join(dir, p), "utf8").slice(0, MAX_FILE_CHARS);
    } catch {
      body = "(unreadable)";
    }
    return `--- new file ${p}\n${body}`;
  });
  return [tracked.trimEnd(), ...fresh].filter((s) => s !== "").join("\n\n") || "(empty diff)";
}

function where(f: { file?: string; line?: number }): string {
  if (!f.file) return "";
  return f.line === undefined ? ` (${f.file})` : ` (${f.file}:${f.line})`;
}

/** `unclear`, warnings and suggestions: they go to the gate as notes. */
function reviewNotes(r: ReviewOutput): string[] {
  const notes = r.spec === "unclear" ? ["review: spec verdict unclear"] : [];
  for (const f of r.findings) if (f.severity !== "critical") notes.push(`review ${f.severity}: ${f.text}${where(f)}`);
  return notes;
}

function blockingItems(r: ReviewOutput): string {
  const items: string[] = [];
  if (r.spec === "fail") items.push("spec: fail");
  if (r.quality === "fail") items.push("quality: fail");
  if (!r.verifyProves) items.push("verify does not prove the task's criteria");
  for (const f of r.findings) if (f.severity === "critical") items.push(`critical: ${f.text}${where(f)}`);
  return `The review blocks (count ${blockingCount(r)}):\n${items.map((i) => `- ${i}`).join("\n")}`;
}

/** Reviews the task diff (AC-20); blocking is a new attempt (AC-34) or the review loop (AC-39). */
const review: StepHandler = async (ctx, id) => {
  const task = taskOf(ctx, id);
  const info = ctx.mode.taskInfo(ctx, task.id);
  const diff = taskDiffText(ctx.projectDir, baseOf(task));
  const report = lastImplement(ctx).report;
  const prompt = (feedback: string | null): string => {
    const p = reviewPrompt({ taskId: task.id, taskDesc: info.desc, criteria: info.criteria, diff, report });
    return feedback ? `${p}\n\n${feedback}` : p;
  };
  const r = await judgeCall(ctx, "review", prompt, parseReview);
  if (r.kind === "fuse") return toLimit(ctx, "fuse", ctx.run.next);
  task.notes = reviewNotes(r.value);
  if (!isBlocking(r.value)) return { type: "pass" };
  const count = blockingCount(r.value);
  const previous = task.blockingCount;
  task.blockingCount = count;
  const feedback = blockingItems(r.value);
  if (previous !== null && count >= previous) {
    task.lastFeedback = feedback;
    return toLimit(ctx, "review-loop", taskNext("implement", task.id));
  }
  return failAttempt(ctx, task, feedback);
};

// ---- commit ----

/**
 * Commits exactly the task diff with the normalised header (AC-20, AC-25). A HEAD that already carries the
 * header is recorded (AC-55); an empty diff is `"empty"` (AC-46); a refusal is a new attempt (AC-42).
 */
const commit: StepHandler = async (ctx, id) => {
  const task = taskOf(ctx, id);
  const dir = ctx.projectDir;
  const base = baseOf(task);
  const after = (): StepEvent => {
    const next = ctx.mode.nextTaskAfter(ctx, task.id);
    return next === null ? { type: "committed-last" } : { type: "committed", task: next };
  };
  const out = lastImplement(ctx);
  const header = normaliseHeader(out.commit.type, ctx.run.mode === "task" ? ctx.run.stage : null, out.commit.subject);
  const head = headSha(dir);
  if (head !== base && git(dir, ["log", "-1", "--format=%s"]).stdout.trim() === header) {
    task.commit = head;
    return after();
  }
  const paths = taskDiffPaths(dir, base);
  if (paths.length === 0) {
    task.commit = "empty";
    return after();
  }
  const c = commitPaths(dir, paths, header);
  if (!c.ok || c.sha === null) return failAttempt(ctx, task, `The commit was refused by git:\n${c.output.trim()}`);
  task.commit = c.sha;
  return after();
};

export const commonHandlers: Partial<Record<StepKind, StepHandler>> = {
  "base-check": baseCheck,
  implement,
  checks,
  review,
  commit,
};
