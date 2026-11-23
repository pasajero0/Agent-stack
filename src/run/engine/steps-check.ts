/**
 * The checks, review and commit steps. Spec: docs/specs/v04/SPEC.md, AC-19, AC-20, AC-25, AC-33, AC-34, AC-39,
 * AC-42, AC-46, AC-55, AC-60, AC-66.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { verifyTail, type CheckRun } from "../checks.js";
import { commitPaths, diffLines, git, headSha, normaliseHeader, taskDiffPaths } from "../git.js";
import { reviewPrompt } from "../prompts.js";
import { blockingCount, isBlocking, parseReview, type ReviewOutput } from "../schemas.js";
import { judgeCall } from "./call.js";
import { driverCheck, Interrupted, type CheckItem, type Ctx, type StepHandler } from "./context.js";
import { newChanges, testChangesText } from "./frozen.js";
import { lastImplement, START_NOTE } from "./steps-implement.js";
import { baseOf, failAttempt, taskOf, timedOutError, toLimit } from "./task-core.js";
import { taskNext, type StepEvent } from "./transitions.js";

function checkFeedback(ctx: Ctx, item: CheckItem, r: CheckRun): string {
  const stage = ctx.run.stage;
  const tail = item.label === "verify" && stage ? verifyTail(ctx.projectDir, stage) || r.tail : r.tail;
  return `Check failed: \`${r.cmd}\` exited ${r.exit}. Last lines of its output:\n${tail}`;
}

/** Runs the mode's commands, by exit code only (AC-19); red is a failed attempt (AC-33), a timeout exits 1 (AC-60). */
export const checks: StepHandler = async (ctx, id) => {
  const task = taskOf(ctx, id);
  // AC-66: a weakened frozen test or a changed check config goes to the human before any check runs.
  task.pendingChanges = newChanges(ctx.projectDir, task, ctx.cfg.testGlobs);
  if (task.pendingChanges.length > 0) {
    task.lastFeedback = testChangesText(task.pendingChanges);
    return toLimit(ctx, "tests-changed", taskNext("checks", task.id));
  }
  const info = ctx.mode.taskInfo(ctx, task.id);
  const items = ctx.mode.checkItems(ctx, task, info);
  const runs: CheckRun[] = [];
  for (const item of items) {
    const r = await driverCheck(ctx, item.cmd);
    if (r.aborted) throw new Interrupted();
    if (r.timedOut) throw timedOutError(ctx, "checks", r);
    runs.push(r);
  }
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
  // The mode decides, an empty diff included: task mode reviews it before commit "empty" (AC-20, AC-46).
  return ctx.mode.needsReview(ctx, task, diffLines(ctx.projectDir, baseOf(task))) ? { type: "review" } : { type: "commit" };
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
export const review: StepHandler = async (ctx, id) => {
  const task = taskOf(ctx, id);
  const info = ctx.mode.taskInfo(ctx, task.id);
  const diff = taskDiffText(ctx.projectDir, baseOf(task));
  const report = lastImplement(ctx).report;
  const prompt = (feedback: string | null): string => {
    const p = reviewPrompt(ctx.projectDir, { taskId: task.id, taskDesc: info.desc, criteria: info.criteria, diff, report, verify: info.verify });
    return feedback ? `${p}\n\n${feedback}` : p;
  };
  const r = await judgeCall(ctx, "review", prompt, parseReview);
  if (r.kind === "fuse") return toLimit(ctx, "fuse", ctx.run.next);
  // The start check's note (AC-63) outlives the review's own notes, which replace each other.
  task.notes = [...task.notes.filter((n) => n.startsWith(START_NOTE)), ...reviewNotes(r.value)];
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
export const commit: StepHandler = async (ctx, id) => {
  const task = taskOf(ctx, id);
  const dir = ctx.projectDir;
  const base = baseOf(task);
  const after = (): StepEvent => {
    const next = ctx.mode.nextTaskAfter(ctx, task.id);
    return next === null ? { type: "committed-last" } : { type: "committed", task: next };
  };
  const out = lastImplement(ctx);
  const header = normaliseHeader(out.commit.type, ctx.run.mode === "task" ? ctx.run.stage : "quick", out.commit.subject);
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
