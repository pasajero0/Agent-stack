/**
 * gate:accept and gate:limit, and the texts the run prints. Spec: "Gate input", AC-21, AC-22, AC-28, AC-29,
 * AC-31, AC-32, AC-46, AC-56. Task-mode gates (T9) reuse `ask`, `recordGate` and `showDecisions`.
 */
import { runCheck, type CheckRun } from "../checks.js";
import { RunError } from "../errors.js";
import { diffStat, dirtyPaths, git, headSha } from "../git.js";
import type { CardAnswer, GateRecord, RunFile } from "../types.js";
import { A, cardText, decisionFacts, Facts, GateChanged, invalid, sha256, showCard, type CardInput } from "./card.js";
import { fuseText } from "./call.js";
import { Interrupted, newTask, resumeHint, type Ctx, type StepHandler } from "./context.js";
import { timedOutError } from "./task-core.js";
import { parseNext, taskNext, type StepEvent } from "./transitions.js";

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
  // AC-70: a gate records its decision before any file is written, so extra answers refuse it here.
  const left = ctx.answering ? (ctx.prompter.left?.() ?? []) : [];
  if (left.length > 0) {
    throw new RunError(
      `Extra answers: ${left.map((a) => JSON.stringify(a)).join(", ")}. The gate at ${ctx.run.next} takes fewer, and one --resume answers one gate. Nothing was applied; the run keeps waiting.`,
      1
    );
  }
  ctx.run.gates.push({ gate, at: new Date().toISOString(), decision, comment, ...extra });
  // Shown at this gate; a decision clears them (AC-32).
  ctx.run.humanDecisions = [];
}


export const NO_INPUT: StepEvent = { type: "no-input" };

/** A comment after `r`: the rest of the line, or the next non-empty answer; null for no input. */
export async function comment(ctx: Ctx, answer: string, prompt = "What should change? "): Promise<string | null> {
  let c = answer.slice(1).trim();
  while (c === "") {
    const a = await ask(ctx, prompt);
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
    // A test conflict's or tests-changed answer is implement's (AC-64, AC-66); an older record has no reason.
    if (g.decision !== "retry" || !g.comment || (g.reason !== undefined && g.reason !== "decision")) return null;
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

/**
 * What gate:accept decides on: the HEAD commit, plus a hash of the uncommitted changes when there are any, so a
 * hand edit made while the gate waited rebuilds the card (AC-68).
 */
function acceptSource(dir: string): string {
  const head = headSha(dir);
  const dirty = dirtyPaths(dir);
  return dirty.length === 0 ? head : `${head}+${sha256(dirty.join("\n") + git(dir, ["diff", "HEAD"]).stdout).slice(0, 12)}`;
}

/** The gate:accept card (AC-21, AC-46, AC-61, AC-68); `source` is what the final check ran on. */
function acceptCard(ctx: Ctx, final: CheckRun | null): CardInput {
  const { run } = ctx;
  const f = new Facts();
  if (run.baseCommit) f.whole(`Diff from ${short(run.baseCommit)}:\n${diffStat(ctx.projectDir, run.baseCommit) || "  (no changes)"}`);
  for (const t of run.tasks) {
    const checks = t.checks.map((c) => (c.skipped ? `${c.cmd} skipped` : `${c.cmd} → ${c.exit}`)).join("; ");
    f.add(`${t.id}: ${commitText(t.commit)}; attempts ${t.attempts}; checks: ${checks || "none"}`);
    for (const n of t.notes) f.add(`${t.id} note: ${n}`);
    for (const c of t.allowedChanges) f.whole(`${t.id} test change allowed: ${c}`);
  }
  if (final !== null) {
    const red = final.exit !== 0;
    f.add(`Final check: ${final.cmd} (every task) → ${final.exit}${red ? " RED" : ""}; on ${short(headSha(ctx.projectDir))}`);
    // A hand fix made while the gate waited is not committed: say so, or the green is taken for the branch's.
    if (dirtyPaths(ctx.projectDir).length > 0) f.add("The final check ran on uncommitted changes; the commits alone may differ.");
    if (red) {
      f.whole(final.tail);
      f.add("A later task broke an earlier one: r with a comment adds a fix task; a accepts a red result.");
    }
  }
  const skips = skipped(ctx);
  if (skips.length > 0) f.add(`Skipped: ${skips.join("; ")}`);
  f.whole(...decisionFacts(ctx));
  f.whole(`Usage: ${cost(run)}`);
  return {
    gate: "accept",
    title: `Accept: run ${run.id} on ${run.branch}`,
    facts: f.list,
    keep: f.keep,
    prompts: [{ text: "accept the result", default: null, answers: [{ ...A.approve, label: "accept" }, { ...A.reject, label: "reject (a comment follows; it becomes a fix task)" }, A.cancel] }],
    source: acceptSource(ctx.projectDir),
    hint: resumeHint(run.id),
  };
}

/** The kept card when it still holds (same HEAD), so a resume does not run the final check again (AC-68). */
async function acceptShown(ctx: Ctx): Promise<void> {
  const kept = ctx.run.card;
  if (kept !== null && kept.gate === "accept" && kept.source === acceptSource(ctx.projectDir)) {
    ctx.out(cardText(kept));
    return;
  }
  const changed = kept !== null && kept.gate === "accept";
  showCard(ctx, acceptCard(ctx, await finalCheck(ctx)));
  if (changed && ctx.answering) throw new GateChanged(resumeHint(ctx.run.id));
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
  await acceptShown(ctx);
  for (;;) {
    const a = await ask(ctx, "accept> ");
    if (a === null) return NO_INPUT;
    const s = a.trim();
    if (s === "a" || s === "r" || s.startsWith("r ")) {
      // AC-68: the human decides on what the card showed; a moved HEAD rebuilds it first.
      if (ctx.run.card?.source !== acceptSource(ctx.projectDir)) {
        await acceptShown(ctx);
        continue;
      }
    }
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
    invalid(ctx, "Answer a (accept), r (reject, then a comment) or c (cancel).");
  }
};

const LIMIT_ANSWERS: Record<string, { text: string; answers: CardAnswer[] }> = {
  fuse: { text: "raise the fuse for this run (in its own unit, above what is used), or cancel", answers: [{ key: "f", follows: "number", label: "new limit" }, A.cancel] },
  decision: { text: "answer the role's questions", answers: [{ key: "r", follows: "text", label: "retry with your answer (the role gets it)" }, A.cancel] },
  "tests-changed": {
    text: "allow these test changes, or send the task back",
    answers: [{ key: "a", follows: null, label: "allow exactly these (the checks run next)" }, { key: "r", follows: "text", label: "retry with a comment (a new attempt, on Opus)" }, A.cancel],
  },
  "test-conflict": {
    text: "fix the test or the spec by hand if needed, then answer the implementer",
    answers: [{ key: "r", follows: "text", label: "retry with your answer for the implementer (no attempt is counted)" }, A.cancel],
  },
  other: { text: "retry or cancel", answers: [{ key: "r", follows: null, label: "retry (a new attempt, on Opus)" }, A.cancel] },
};

/** The gate:limit card (AC-31, AC-35, AC-38, AC-57, AC-64, AC-66, AC-68). */
function limitCard(ctx: Ctx): CardInput {
  const { run } = ctx;
  const back = run.returnTo;
  const task = back ? parseNext(back).task : null;
  const reason = run.limitReason ?? "attempts";
  const f = new Facts();
  if (back) f.add(`Stopped before ${back}.`);
  const t = run.tasks.find((x) => x.id === task);
  if (t) {
    f.add(`${t.id}: attempts ${t.attempts} of ${ctx.mode.maxAttempts}`);
    if (t.lastFeedback) f.whole(`Last feedback:\n${t.lastFeedback}`);
  }
  f.whole(...decisionFacts(ctx));
  f.whole(`Usage: ${cost(run)}`);
  const p = LIMIT_ANSWERS[reason] ?? LIMIT_ANSWERS["other"];
  return {
    gate: "limit",
    title: `Stopped — reason: ${reason} — run ${run.id}`,
    facts: f.list,
    keep: f.keep,
    prompts: p ? [{ text: p.text, default: null, answers: p.answers }] : [],
    hint: resumeHint(run.id),
  };
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
  showCard(ctx, limitCard(ctx));
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
        invalid(ctx, f);
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
      const c = await comment(ctx, s, "answer for the implementer> ");
      if (c === null) return NO_INPUT;
      const task = run.returnTo ? parseNext(run.returnTo).task : null;
      const t = run.tasks.find((x) => x.id === task);
      if (t) t.lastFeedback = [t.lastFeedback, `FROM THE HUMAN: ${c}`].filter((x) => x !== null).join("\n");
      recordGate(ctx, "gate:limit", "retry", c, { reason: "test-conflict" });
      return { type: "resume" };
    }
    if (run.limitReason === "tests-changed") {
      const ev = await testsChangedAnswer(ctx, s);
      if (ev !== null) return ev;
      invalid(ctx, "Answer a (allow), r (retry, then a comment) or c (cancel).");
      continue;
    }
    if (s === "r") {
      // A retry is a new attempt, so it runs on Opus (AC-16, AC-31).
      const task = run.returnTo ? parseNext(run.returnTo).task : null;
      const t = run.tasks.find((x) => x.id === task);
      if (t) t.attempts += 1;
      recordGate(ctx, "gate:limit", "retry");
      return { type: "resume" };
    }
    invalid(ctx, run.limitReason === "decision" || run.limitReason === "test-conflict" ? "Answer r and your answer, or c (cancel)." : "Answer r (retry) or c (cancel).");
  }
};

/**
 * gate:limit (tests changed), AC-66: `a` allows exactly the changes listed, and the checks run; `r` and a
 * comment send the task back to implement as a new attempt. Null for any other answer.
 */
async function testsChangedAnswer(ctx: Ctx, s: string): Promise<StepEvent | null> {
  const { run } = ctx;
  const id = run.returnTo ? parseNext(run.returnTo).task : null;
  const t = run.tasks.find((x) => x.id === id);
  if (!t) throw new Error(`gate:limit (tests-changed) has no task`);
  if (s === "a") {
    // Exactly what was listed: a change made while the gate waited stops again at the checks.
    for (const c of t.pendingChanges) if (!t.allowedChanges.includes(c)) t.allowedChanges.push(c);
    t.pendingChanges = [];
    recordGate(ctx, "gate:limit", "allow", null, { reason: "tests-changed" });
    return { type: "resume" };
  }
  if (s !== "r" && !s.startsWith("r ")) return null;
  const c = await comment(ctx, s);
  if (c === null) return NO_INPUT;
  t.attempts += 1;
  t.pendingChanges = [];
  t.lastFeedback = [t.lastFeedback, `FROM THE HUMAN: ${c}`].filter((x) => x !== null).join("\n");
  run.returnTo = taskNext("implement", t.id);
  recordGate(ctx, "gate:limit", "retry", c, { reason: "tests-changed" });
  return { type: "resume" };
}

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
