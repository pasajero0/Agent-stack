/**
 * gate:accept and gate:limit, and the texts the run prints. Spec: "Gate input", AC-21, AC-22, AC-28, AC-29,
 * AC-31, AC-32, AC-46, AC-56. Task-mode gates (T9) reuse `ask`, `recordGate` and `showDecisions`.
 */
import { runCheck, type CheckRun } from "../checks.js";
import { diffStat, dirtyPaths, git } from "../git.js";
import type { GateRecord, RunFile } from "../types.js";
import { fuseText } from "./call.js";
import { Interrupted, newTask, type Ctx, type StepHandler } from "./context.js";
import { timedOutError } from "./steps-common.js";
import { parseNext, type StepEvent } from "./transitions.js";

const short = (sha: string): string => sha.slice(0, 7);

/** One prompter answer, or null for no input (the loop exits 3). The abort signal interrupts the wait. */
export async function ask(ctx: Ctx, prompt: string): Promise<string | null> {
  if (ctx.signal.aborted) throw new Interrupted();
  let onAbort: () => void = () => {};
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new Interrupted());
    ctx.signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    return await Promise.race([ctx.prompter.ask(prompt), aborted]);
  } finally {
    ctx.signal.removeEventListener("abort", onAbort);
  }
}

export function recordGate(ctx: Ctx, gate: string, decision: string, comment: string | null = null, extra: Pick<GateRecord, "planSha256" | "asked" | "reason"> = {}): void {
  ctx.run.gates.push({ gate, at: new Date().toISOString(), decision, comment, ...extra });
  // Shown at this gate; a decision clears them (AC-32).
  ctx.run.humanDecisions = [];
}

/** The human decisions collected since the last gate (AC-32). */
export function showDecisions(ctx: Ctx): void {
  if (ctx.run.humanDecisions.length === 0) return;
  ctx.out("Human decisions needed:");
  for (const d of ctx.run.humanDecisions) ctx.out(`  - ${d}`);
}

export const NO_INPUT: StepEvent = { type: "no-input" };

/** A comment after `r`: the rest of the line, or the next non-empty answer; null for no input. */
export async function comment(ctx: Ctx, answer: string): Promise<string | null> {
  let c = answer.slice(1).trim();
  while (c === "") {
    const a = await ask(ctx, "What should change? ");
    if (a === null) return null;
    c = a.trim();
  }
  return c;
}

/**
 * The human's comment from the newest gate:limit (decision) retry: the spec or plan role gets it as "FROM THE
 * HUMAN" (AC-57). A fuse raise after it is skipped, so the answer survives a fuse stop; any other gate ends it.
 */
export function humanFeedback(run: RunFile): string | null {
  for (let i = run.gates.length - 1; i >= 0; i--) {
    const g = run.gates[i];
    if (g === undefined || g.gate !== "gate:limit") return null;
    if (g.decision === "raise") continue;
    // A test conflict's answer is implement's (AC-64); an older record has no reason and is a decision.
    if (g.decision !== "retry" || !g.comment || g.reason === "test-conflict") return null;
    return g.asked && g.asked.length > 0 ? `FROM THE HUMAN: you asked: ${g.asked.join("; ")}; the answer: ${g.comment}` : `FROM THE HUMAN: ${g.comment}`;
  }
  return null;
}

/** The run's cost line (AC-21, AC-23, AC-62): unknown-cost calls are named, and a dollar fuse is flagged. */
export function costText(run: RunFile): string {
  const unknown = run.costUnknownCalls > 0 ? `, ${run.costUnknownCalls} with unknown cost` : "";
  const usd = run.fuse !== "off" && "usd" in run.fuse;
  const warn = unknown !== "" && usd ? "; the dollar fuse may count too little" : "";
  return `cost $${run.costUsd.toFixed(4)} over ${run.calls} calls${unknown} (fuse ${fuseText(run.fuse)}${warn})`;
}
const cost = costText;

/** Commands that were skipped because they are empty (AC-56). */
function skipped(ctx: Ctx): string[] {
  const out = ctx.cfg.commands.test.trim() === "" ? ["base-check: the test command is empty"] : [];
  for (const t of ctx.run.tasks) for (const c of t.checks) if (c.skipped) out.push(`${t.id}: ${c.cmd}`);
  return out;
}

function commitText(c: string | null): string {
  if (c === null) return "not committed";
  return c === "empty" ? "empty (no changes, no commit)" : `commit ${short(c)}`;
}

/** The mode's final check, run once more before gate:accept (AC-21, AC-61); null when the mode has none. */
async function finalCheck(ctx: Ctx): Promise<CheckRun | null> {
  const item = ctx.mode.finalCheck?.(ctx) ?? null;
  if (item === null) return null;
  const r = await runCheck(item.cmd, ctx.projectDir, ctx.cfg.checkTimeoutMin * 60_000, ctx.signal);
  if (r.aborted) throw new Interrupted();
  if (r.timedOut) throw timedOutError(ctx, "final check", r);
  return r;
}

/** The gate:accept summary (AC-21, AC-46, AC-61). */
function acceptSummary(ctx: Ctx, final: CheckRun | null): void {
  const { run } = ctx;
  ctx.out(`== gate:accept — run ${run.id} on ${run.branch} ==`);
  if (run.baseCommit) {
    ctx.out(`Diff from ${short(run.baseCommit)}:`);
    ctx.out(diffStat(ctx.projectDir, run.baseCommit) || "  (no changes)");
  }
  for (const t of run.tasks) {
    const checks = t.checks.map((c) => (c.skipped ? `${c.cmd} skipped` : `${c.cmd} → ${c.exit}`)).join("; ");
    ctx.out(`${t.id}: ${commitText(t.commit)}; attempts ${t.attempts}; checks: ${checks || "none"}`);
    for (const n of t.notes) ctx.out(`  note: ${n}`);
  }
  if (final !== null) {
    const red = final.exit !== 0;
    ctx.out(`Final check: ${final.cmd} (every task) → ${final.exit}${red ? " RED" : ""}`);
    // A hand fix made while the gate waited is not committed: say so, or the green is taken for the branch's.
    if (dirtyPaths(ctx.projectDir).length > 0) ctx.out("The final check ran on uncommitted changes; the commits alone may differ.");
    if (red) {
      ctx.out(final.tail);
      ctx.out("A later task broke an earlier one: r with a comment adds a fix task; a accepts a red result.");
    }
  }
  const skips = skipped(ctx);
  if (skips.length > 0) ctx.out(`Skipped: ${skips.join("; ")}`);
  showDecisions(ctx);
  ctx.out(`Usage: ${cost(run)}`);
  ctx.out("a approve, r reject (a comment follows), c cancel");
}

/** The fix task F<k> for a gate:accept reject (AC-22, AC-25). */
function newFixTask(ctx: Ctx, comment: string): string {
  const k = ctx.run.tasks.filter((t) => /^F\d+$/.test(t.id)).length + 1;
  const task = newTask(`F${k}`);
  task.lastFeedback = `The human rejected the result at gate:accept: ${comment}`;
  ctx.run.tasks.push(task);
  return task.id;
}

/** The comment of the gate:accept reject that made fix task `id` (F<k> ↔ the k-th reject). */
export function fixComment(run: RunFile, id: string): string {
  const k = Number(id.slice(1));
  const rejects = run.gates.filter((g) => g.gate === "gate:accept" && g.decision === "reject");
  return rejects[k - 1]?.comment ?? "";
}

export const acceptGate: StepHandler = async (ctx) => {
  acceptSummary(ctx, await finalCheck(ctx));
  for (;;) {
    const a = await ask(ctx, "accept> ");
    if (a === null) return NO_INPUT;
    const s = a.trim();
    if (s === "a") {
      recordGate(ctx, "gate:accept", "accept");
      return { type: "accept" };
    }
    if (s === "c") {
      recordGate(ctx, "gate:accept", "cancel");
      return { type: "cancel" };
    }
    if (s === "r" || s.startsWith("r ")) {
      const c = await comment(ctx, s);
      if (c === null) return NO_INPUT;
      recordGate(ctx, "gate:accept", "reject", c);
      return { type: "reject", task: newFixTask(ctx, c) };
    }
    ctx.out("Answer a (approve), r (reject, then a comment) or c (cancel).");
  }
};

function limitSummary(ctx: Ctx): void {
  const { run } = ctx;
  const back = run.returnTo;
  const task = back ? parseNext(back).task : null;
  ctx.out(`== gate:limit — run ${run.id}, reason: ${run.limitReason ?? "attempts"} ==`);
  if (back) ctx.out(`Stopped before ${back}.`);
  const t = run.tasks.find((x) => x.id === task);
  if (t) {
    ctx.out(`${t.id}: attempts ${t.attempts} of ${ctx.mode.maxAttempts}`);
    if (t.lastFeedback) ctx.out(`Last feedback:\n${t.lastFeedback}`);
  }
  showDecisions(ctx);
  ctx.out(`Usage: ${cost(run)}`);
  ctx.out(
    run.limitReason === "fuse"
      ? "f <n> sets a new fuse limit for this run (in its own unit, above what is used), c cancel"
      : run.limitReason === "decision"
        ? "r retry (your answer follows; the role gets it), c cancel"
        : run.limitReason === "test-conflict"
          ? "Fix the test or the spec by hand if needed. r retry (your answer follows; the implementer gets it; no attempt is counted), c cancel"
          : "r retry (on Opus), c cancel"
  );
}

/** A raised fuse from `f <n>`, or an error text (AC-31). */
function raise(run: RunFile, answer: string): RunFile["fuse"] | string {
  const m = /^f\s+([0-9]+(?:\.[0-9]+)?)$/.exec(answer);
  const n = m ? Number(m[1]) : NaN;
  const f = run.fuse;
  if (!Number.isFinite(n) || f === "off") return "Answer f <n> or c.";
  if ("calls" in f) {
    if (!Number.isInteger(n) || n <= run.calls) return `The calls limit must be a whole number above ${run.calls} (used).`;
    return { calls: n };
  }
  // AC-62: name the calls whose cost is unknown, since the used amount is then too low.
  const unknown = run.costUnknownCalls > 0 ? `; plus ${run.costUnknownCalls} call(s) with unknown cost` : "";
  if (n <= run.costUsd) return `The dollar limit must be above $${run.costUsd.toFixed(4)} (used${unknown}).`;
  return { usd: n };
}

export const limitGate: StepHandler = async (ctx) => {
  limitSummary(ctx);
  const { run } = ctx;
  for (;;) {
    const a = await ask(ctx, "limit> ");
    if (a === null) return NO_INPUT;
    const s = a.trim();
    if (s === "c") {
      recordGate(ctx, "gate:limit", "cancel");
      return { type: "cancel" };
    }
    if (run.limitReason === "fuse") {
      const f = raise(run, s);
      if (typeof f === "string") {
        ctx.out(f);
        continue;
      }
      run.fuse = f;
      recordGate(ctx, "gate:limit", "raise", s.slice(1).trim());
      return { type: "resume" };
    }
    if (run.limitReason === "decision" && (s === "r" || s.startsWith("r "))) {
      // AC-57: the answer goes to the role; attempts and the fuse are unchanged.
      const c = await comment(ctx, s);
      if (c === null) return NO_INPUT;
      // recordGate clears humanDecisions, so the questions are kept in the record for the retried role.
      recordGate(ctx, "gate:limit", "retry", c, { asked: [...run.humanDecisions], reason: "decision" });
      return { type: "resume" };
    }
    if (run.limitReason === "test-conflict" && (s === "r" || s.startsWith("r "))) {
      // AC-64: the answer goes to implement with the conflict; no attempt is counted, so the model stays.
      const c = await comment(ctx, s);
      if (c === null) return NO_INPUT;
      const task = run.returnTo ? parseNext(run.returnTo).task : null;
      const t = run.tasks.find((x) => x.id === task);
      if (t) t.lastFeedback = [t.lastFeedback, `FROM THE HUMAN: ${c}`].filter((x) => x !== null).join("\n");
      recordGate(ctx, "gate:limit", "retry", c, { reason: "test-conflict" });
      return { type: "resume" };
    }
    if (s === "r") {
      // A retry is a new attempt, so it runs on Opus (AC-16, AC-31).
      const task = run.returnTo ? parseNext(run.returnTo).task : null;
      const t = run.tasks.find((x) => x.id === task);
      if (t) t.attempts += 1;
      recordGate(ctx, "gate:limit", "retry");
      return { type: "resume" };
    }
    ctx.out("Answer r (retry) or c (cancel).");
  }
};

/** The branches and commits a cancelled run keeps (AC-28). */
export function cancelledText(projectDir: string, run: RunFile): string {
  const commits = run.tasks.flatMap((t) => {
    if (t.commit === null || t.commit === "empty") return [];
    const subject = git(projectDir, ["log", "-1", "--format=%s", t.commit]).stdout.trim();
    return [`  ${short(t.commit)} ${subject}`];
  });
  return [
    `Run ${run.id} cancelled. Branches and commits are kept.`,
    `Branches: ${run.createdBranches.length > 0 ? run.createdBranches.join(", ") : "(none created)"}`,
    ...(commits.length > 0 ? ["Commits:", ...commits] : ["Commits: none"]),
  ].join("\n");
}

export function finishedText(run: RunFile): string {
  const n = run.tasks.filter((t) => t.commit !== null && t.commit !== "empty").length;
  return `Run ${run.id} finished on ${run.branch} with ${n} commit(s). Nothing was pushed: push and merge are yours.`;
}
