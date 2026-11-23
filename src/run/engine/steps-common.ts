/**
 * Steps both modes share: base-check here, and the registry of the task steps. Spec: docs/specs/v04/SPEC.md,
 * AC-15, AC-24, AC-41. The steps live in steps-implement.ts and steps-check.ts; their helpers in task-core.ts.
 */
import { RunError } from "../errors.js";
import { driverCheck, Interrupted, resumeHint, type StepHandler } from "./context.js";
import { requireClean } from "./role-bounds.js";
import { checks, commit, review } from "./steps-check.js";
import { implement } from "./steps-implement.js";
import { timedOutError } from "./task-core.js";
import type { StepKind } from "./transitions.js";

/**
 * Runs `test` on the clean tree before any change; red is exit 1 with `next` kept (AC-15, AC-24, AC-41). A
 * change made while gate:plan-approve waited is refused here, so it does not slip into the first task's diff.
 */
const baseCheck: StepHandler = async (ctx) => {
  requireClean(ctx.projectDir, "before base-check");
  const r = await driverCheck(ctx, ctx.cfg.commands.test);
  if (r.aborted) throw new Interrupted();
  if (r.timedOut) throw timedOutError(ctx, "base-check", r);
  if (!r.skipped && r.exit !== 0) {
    throw new RunError(
      `base-check: \`${r.cmd}\` exited ${r.exit} before any change, so the base is red. Fix the base, then ${resumeHint(ctx.run.id)}.\n${r.tail}`,
      1
    );
  }
  return { type: "green", task: ctx.mode.firstTask(ctx) };
};

export const commonHandlers: Partial<Record<StepKind, StepHandler>> = {
  "base-check": baseCheck,
  implement,
  checks,
  review,
  commit,
};
