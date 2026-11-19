/**
 * Helpers every task step shares: the task, its base, the limit gate, a failed attempt, lint items and a check
 * timeout. Spec: docs/specs/v04/SPEC.md, AC-19, AC-31, AC-33, AC-56, AC-60. Imports no step module (no cycle).
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { lintRuns, type CheckRun } from "../checks.js";
import { RunError } from "../errors.js";
import { taskDiffPaths } from "../git.js";
import type { LimitReason, Next, RunTask } from "../types.js";
import { findTask, resumeHint, type CheckItem, type Ctx } from "./context.js";
import { taskNext, type StepEvent } from "./transitions.js";

/** The task of a task step; a `next` without one is an engine bug. */
export function taskOf(ctx: Ctx, id: string | null): RunTask {
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

/**
 * A check that ran past `checkTimeoutMin` (AC-60): exit 1 with `next` kept and no attempt counted. A hang is the
 * environment's (a package manager waiting on the network), not the code's, so it does not go back to implement.
 */
export function timedOutError(ctx: Ctx, step: string, r: CheckRun): RunError {
  // A verify killed on timeout cannot run its EXIT trap, so its lock stays; the driver killed it, so the lock
  // is the driver's to drop. Otherwise the next verify waits 60 s and fails (AC-60).
  const stage = ctx.run.stage;
  if (stage !== null && r.cmd.startsWith(".claude/bin/verify")) {
    rmSync(join(ctx.projectDir, ".claude", "tmp", stage, ".verify.lock"), { recursive: true, force: true });
  }
  return new RunError(
    `${step}: \`${r.cmd}\` timed out after ${ctx.cfg.checkTimeoutMin} min (checkTimeoutMin). No attempt was counted. Fix what hangs, or raise run.checkTimeoutMin in gates.json, then ${resumeHint(ctx.run.id)} runs the checks again.\n${r.tail}`,
    1
  );
}
