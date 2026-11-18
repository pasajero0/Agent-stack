/**
 * Task mode: the plan step and gate:plan-approve. Spec: docs/specs/v04/SPEC.md, "Task mode" table, "Valid
 * plan", AC-12, AC-13, AC-14, AC-40, AC-45.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { RunError } from "../errors.js";
import { headSha } from "../git.js";
import { isRisky, planPrompt } from "../prompts.js";
import { parsePlanOut } from "../schemas.js";
import { writeRun } from "../store.js";
import type { GateRecord, RunFile } from "../types.js";
import { judgeCall } from "./call.js";
import { newTask, resumeHint, type Ctx, type StepHandler, type TaskInfo } from "./context.js";
import { ask, NO_INPUT, recordGate, showDecisions } from "./gates.js";
import { criteriaOf, deletePlan, parsePlan, planSha256, readPlan, readSpec, stageTmp, tasksPath, type PlanTask } from "./plan-file.js";
import { boundsFeedback, checkRole, guardRole, requireBranch, requireClean, undoGit, undoOutside, withFeedback, type RoleMark } from "./role-bounds.js";
import { implementModel, lastCallOutput, toLimit } from "./steps-common.js";
import { proposalOf, stageOf } from "./steps-spec.js";
import { transition, type StepEvent } from "./transitions.js";

/** A plan task as implement, checks and review see it; risky only for tier S or M (AC-13). */
export function planTaskInfo(t: PlanTask, specMd: string): TaskInfo {
  const criteria = criteriaOf(specMd, t.ac);
  const risky = t.tier !== "L" && [t.desc, ...criteria].some(isRisky);
  return { id: t.id, desc: t.desc, criteria, tier: t.tier, risky, fix: false, verify: t.verify };
}

const lastPlanGate = (run: RunFile): GateRecord | undefined => [...run.gates].reverse().find((g) => g.gate === "gate:plan-approve");

/** The last plan-approve decision, if it was a reject: the plan run answers its comment. */
function lastReject(run: RunFile): GateRecord | null {
  const last = lastPlanGate(run);
  return last?.decision === "reject" ? last : null;
}

/**
 * A tasks.json left by an interrupted plan call, kept for the gate when valid (with the needsHumanDecision of
 * a plan call newer than the last plan-approve decision, if any). The rejected plan itself (a kill between the
 * reject and its deletion: its sha256, or for a record without one an mtime not newer than the reject) and an
 * invalid one are deleted; guard-file blocks the role from rewriting an existing file.
 */
function keepLeftover(ctx: Ctx, stage: string, specMd: string): boolean {
  const dir = ctx.projectDir;
  const file = tasksPath(dir, stage);
  if (!existsSync(file)) return false;
  const text = readFileSync(file, "utf8");
  const reject = lastReject(ctx.run);
  const rejected =
    reject !== null && (reject.planSha256 !== undefined ? reject.planSha256 === planSha256(text) : statSync(file).mtimeMs <= Date.parse(reject.at));
  if (!rejected && typeof parsePlan(text, specMd) !== "string") {
    const gate = lastPlanGate(ctx.run);
    const since = gate === undefined ? null : Date.parse(gate.at);
    ctx.run.humanDecisions.push(...(lastCallOutput(ctx, "plan", parsePlanOut, since)?.needsHumanDecision ?? []));
    return true;
  }
  deletePlan(dir, stage);
  return false;
}

/** Runs the plan role and checks a valid plan in bounds (AC-12); a violation is undone and re-run once (AC-40, AC-45). */
const planStep: StepHandler = async (ctx) => {
  const { run, cfg } = ctx;
  const dir = ctx.projectDir;
  // AC-52: the mark below is the run branch's HEAD; on another branch (switched while a gate waited) the undo would move the run branch.
  requireBranch(ctx, run.branch);
  // AC-49: the undo below removes everything outside .claude/tmp/, so the tree must be clean before the role.
  requireClean(dir, "before the plan role");
  const stage = stageOf(run);
  const specMd = readSpec(dir, cfg, stage);
  const file = tasksPath(dir, stage);
  const read = (): string => (existsSync(file) ? readFileSync(file, "utf8") : "");
  if (keepLeftover(ctx, stage, specMd)) return { type: "planned" };
  const mark: RoleMark = { head: headSha(dir), branch: run.branch };
  const base = planPrompt(dir, { stage, title: proposalOf(run).stage.title, comment: lastReject(run)?.comment ?? null });
  let feedback: string | null = null;
  let last: string[] = [];
  for (let round = 0; round < 2; round++) {
    const r = await guardRole(ctx, mark, () => judgeCall(ctx, "plan", (fb) => withFeedback(base, [feedback, fb]), parsePlanOut));
    if (r.kind === "fuse") {
      undoGit(ctx, mark);
      return toLimit(ctx, "fuse", "plan");
    }
    const { problems, outside } = checkRole(ctx, mark, () => false);
    const text = read();
    const plan = text === "" ? `${stageTmp(stage)}/tasks.json was not written` : parsePlan(text, specMd);
    if (typeof plan === "string") problems.push(plan);
    if (problems.length === 0) {
      run.humanDecisions.push(...r.value.needsHumanDecision);
      return { type: "planned" };
    }
    undoOutside(ctx, mark, outside);
    deletePlan(dir, stage);
    last = problems;
    feedback = boundsFeedback("plan", problems);
    ctx.out(`plan: ${problems.join("; ")}.${round === 0 ? " Undone; running plan once more." : ""}`);
  }
  throw new RunError(`The plan role failed twice (${last.join("; ")}). The run stays at plan; ${resumeHint(run.id)} tries again.`, 1);
};

/** A comment after `r`: the rest of the line, or the next non-empty answer; null for no input. */
async function comment(ctx: Ctx, answer: string): Promise<string | null> {
  let c = answer.slice(1).trim();
  while (c === "") {
    const a = await ask(ctx, "What should change? ");
    if (a === null) return null;
    c = a.trim();
  }
  return c;
}

/** Shows each task with its criteria, tier, risky mark, model and verify (AC-12, AC-13); approve, reject or cancel (AC-14). */
const planApproveGate: StepHandler = async (ctx) => {
  const { run, cfg } = ctx;
  const dir = ctx.projectDir;
  const stage = stageOf(run);
  const specMd = readSpec(dir, cfg, stage);
  const tasks = readPlan(dir, cfg, stage);
  ctx.out(`== gate:plan-approve — run ${run.id}, stage ${stage} on ${run.branch} ==`);
  for (const t of tasks) {
    const info = planTaskInfo(t, specMd);
    const model = implementModel(info, { ...newTask(t.id), attempts: 1 });
    ctx.out(`${t.id} [${t.ac.join(", ")}] tier ${t.tier}${info.risky ? ", risky" : ""} → ${model} — ${t.desc}`);
    ctx.out(`    verify: ${t.verify}`);
  }
  showDecisions(ctx);
  ctx.out("a approve, r reject (a comment follows), c cancel");
  for (;;) {
    const a = await ask(ctx, "plan> ");
    if (a === null) return NO_INPUT;
    const s = a.trim();
    if (s === "a") {
      recordGate(ctx, "gate:plan-approve", "approve");
      run.tasks = tasks.map((t) => newTask(t.id));
      return { type: "approve" };
    }
    if (s === "c") {
      recordGate(ctx, "gate:plan-approve", "cancel");
      return { type: "cancel" };
    }
    if (s === "r" || s.startsWith("r ")) {
      const c = await comment(ctx, s);
      if (c === null) return NO_INPUT;
      // The rejected plan's hash marks a leftover copy of it after a kill (keepLeftover).
      recordGate(ctx, "gate:plan-approve", "reject", c, { planSha256: planSha256(readFileSync(tasksPath(dir, stage), "utf8")) });
      // The reject and `next` go to disk before the plan is deleted, so a kill in between re-plans (keepLeftover).
      const reject: StepEvent = { type: "reject" };
      const t = transition(run.next, reject, run.returnTo);
      writeRun(dir, { ...run, next: t.next, status: t.status });
      deletePlan(dir, stage);
      return reject;
    }
    ctx.out("Answer a (approve), r (reject, then a comment) or c (cancel).");
  }
};

export const planHandlers = { plan: planStep, "gate:plan-approve": planApproveGate };
