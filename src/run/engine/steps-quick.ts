/**
 * Quick mode: `quick/<slug>` from HEAD, base-check, Q1, and fix tasks F<k> from gate:accept.
 * Spec: docs/specs/v04/SPEC.md, "Quick mode" table, AC-24, AC-25, AC-54.
 */
import { RunError } from "../errors.js";
import { branchExists, slugify } from "../git.js";
import { newTask, type ModeSteps } from "./context.js";
import { fixComment } from "./gates.js";
import { lintItems } from "./task-core.js";

export const quickMode: ModeSteps = {
  maxAttempts: 2,
  handlers: {},

  start(input) {
    // AC-90: in spec flow branch a quick run stays on the current branch.
    if (input.cfg.specFlow === "branch") return { next: "base-check", tasks: [newTask("Q1")], newBranch: null, stagePrefill: null };
    const name = `quick/${slugify(input.description)}`;
    if (branchExists(input.projectDir, name)) {
      throw new RunError(
        `Branch ${name} already exists and this run did not create it. Delete it (git branch -D ${name}) or word the description differently.`,
        1
      );
    }
    return { next: "base-check", tasks: [newTask("Q1")], newBranch: name, stagePrefill: null };
  },

  taskInfo(ctx, id) {
    const fix = /^F\d+$/.test(id);
    const desc = fix
      ? `Fix what the human asked for after rejecting "${ctx.run.description}": ${fixComment(ctx.run, id)}`
      : ctx.run.description;
    return { id, desc, criteria: [], tier: "M", risky: false, fix, verify: "" };
  },

  /** Q1 and quick fix tasks: the `test` command plus lint (AC-25). */
  checkItems(ctx, task) {
    return [{ label: "test", cmd: ctx.cfg.commands.test }, ...lintItems(ctx, task)];
  },

  /** Review only above `quickReviewLines` (AC-25), so never for an empty diff. */
  needsReview(ctx, _task, diffLines) {
    return diffLines > ctx.cfg.quickReviewLines;
  },

  firstTask: () => "Q1",
  nextTaskAfter: () => null,
};
