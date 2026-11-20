/**
 * Task mode: the spec step on `spec/<stage>` and gate:spec-merge. Spec: docs/specs/v04/SPEC.md, "Task mode"
 * table, AC-8, AC-10, AC-11, AC-40, AC-42, AC-44, AC-47, AC-49, AC-54, AC-55.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { RunError } from "../errors.js";
import { baseRef, branchExists, checkout, commitPaths, createBranch, currentBranch, dirtyPaths, existsOnRef, git, headSha, normaliseHeader, slugify } from "../git.js";
import { runCheck } from "../checks.js";
import { specPrompt } from "../prompts.js";
import { parseClarify, parseSpecOut, type ClarifyOutput } from "../schemas.js";
import { writeRun } from "../store.js";
import type { RunConfig, RunFile } from "../types.js";
import { judgeCall } from "./call.js";
import { resumeHint, type Ctx, type StepHandler } from "./context.js";
import { humanFeedback, NO_INPUT, recordGate } from "./gates.js";
import { decisionFacts, Facts, showCard } from "./card.js";
import { specPath } from "./plan-file.js";
import { boundsFeedback, checkRole, guardRole, requireBranch, requireClean, undoGit, undoOutside, under, withFeedback, type RoleMark } from "./role-bounds.js";
import { toLimit } from "./task-core.js";

/** The stored clarify output; a run file without a valid one cannot go on. */
export function proposalOf(run: RunFile): ClarifyOutput {
  const p = parseClarify(run.proposal);
  if (typeof p === "string") throw new RunError(`Run ${run.id} has no valid clarify proposal (${p}); cancel it: agent-stack run --cancel ${run.id}.`, 1);
  return p;
}

export function stageOf(run: RunFile): string {
  if (run.stage === null) throw new RunError(`Run ${run.id} has no confirmed stage id; cancel it: agent-stack run --cancel ${run.id}.`, 1);
  return run.stage;
}

/**
 * The spec role may change only `<specsDir>/<stage>/`, `<adrDir>/` and the glossary file (AC-8); all are
 * normalised by loadRunConfig. The glossary is in bounds so a shared word lands in the spec's own commit.
 */
export function specInBounds(cfg: RunConfig, stage: string): (path: string) => boolean {
  return (p) => under(p, `${cfg.specsDir}/${stage}`) || under(p, cfg.adrDir) || (cfg.glossary !== "" && p === cfg.glossary);
}

/**
 * `.claude/bin/trace --terms <stage>` after the spec role (AC-59): its output when it exits 1, else null. A
 * missing trace, or another exit code (2: no spec, which AC-44 reports), is no check.
 */
async function termsProblem(ctx: Ctx, stage: string): Promise<string | null> {
  const bin = join(ctx.projectDir, ".claude", "bin", "trace");
  if (!existsSync(bin)) return null;
  // The stage id passed AC-7 (letters and digits), so it is one shell word.
  const r = await runCheck(`.claude/bin/trace --terms ${stage}`, ctx.projectDir, ctx.cfg.checkTimeoutMin * 60_000, ctx.signal);
  return r.exit === 1 ? r.tail.trim() : null;
}

/**
 * A branch this run creates from `from`: created on a clean tree, or checked out when this run already made
 * it (AC-55). One that exists and is not the run's is refused (AC-54).
 */
export function enterRunBranch(ctx: Ctx, name: string, from: string): "created" | "existing" {
  const { run } = ctx;
  const dir = ctx.projectDir;
  if (branchExists(dir, name)) {
    if (!run.createdBranches.includes(name)) {
      throw new RunError(`Branch ${name} already exists and this run did not create it. Delete or rename it (git branch -m ${name} <new name>), then ${resumeHint(run.id)}.`, 1);
    }
    if (currentBranch(dir) !== name) checkout(dir, name);
    return "existing";
  }
  requireClean(dir, `before creating ${name}`);
  createBranch(dir, name, from);
  run.createdBranches.push(name);
  return "created";
}

/** Runs the spec role on `spec/<stage>`, checks its bounds and commits the spec (AC-8, AC-40, AC-44). */
const specStep: StepHandler = async (ctx) => {
  const { run, cfg } = ctx;
  const dir = ctx.projectDir;
  const stage = stageOf(run);
  const title = proposalOf(run).stage.title;
  const name = `spec/${stage}`;
  const inBounds = specInBounds(cfg, stage);
  // AC-49: the undo below removes what is out of bounds, so nothing out of bounds may be there before the role.
  requireClean(dir, "before the spec role", inBounds);
  if (!(currentBranch(dir) === name && run.createdBranches.includes(name))) {
    enterRunBranch(ctx, name, baseRef(dir, cfg.baseBranch));
  }
  run.branch = name;
  writeRun(dir, run);
  const header = normaliseHeader("docs", stage, `spec — ${title}`);
  // AC-55: a kill after the spec commit; the commit is not made again.
  if (git(dir, ["log", "-1", "--format=%s"]).stdout.trim() === header) return { type: "spec-done" };

  // AC-52: the mark is the spec branch's HEAD, so the undo after the role cannot move another branch.
  requireBranch(ctx, name);
  const mark: RoleMark = { head: headSha(dir), branch: name };
  const file = specPath(cfg, stage);
  const base = specPrompt(dir, { stage, title, description: run.description, answers: run.answers });
  const human = humanFeedback(run);
  let feedback: string | null = null;
  let last: string[] = [];
  for (let round = 0; round < 2; round++) {
    // AC-32: the denials of a call that is undone are dropped.
    const kept = run.humanDecisions.length;
    const r = await guardRole(ctx, mark, () => judgeCall(ctx, "spec", (fb) => withFeedback(base, [human, feedback, fb]), parseSpecOut));
    if (r.kind === "fuse") {
      undoGit(ctx, mark);
      return toLimit(ctx, "fuse", "spec");
    }
    const { problems, outside } = checkRole(ctx, mark, inBounds);
    const missing = !existsSync(join(dir, file));
    if (missing) problems.push(`${file} does not exist; write the spec there`);
    else {
      const terms = await termsProblem(ctx, stage);
      if (terms !== null) problems.push(terms);
    }
    if (problems.length === 0) {
      const c = commitPaths(dir, dirtyPaths(dir).filter(inBounds), header);
      if (!c.ok) {
        // AC-32: a resume re-runs the spec role, so this call's items would be shown twice.
        run.humanDecisions.length = kept;
        throw new RunError(`The spec commit was refused:\n${c.output.trim()}\nFix the cause and commit ${file} on ${name} as "${header}", then ${resumeHint(run.id)}.`, 1);
      }
      run.humanDecisions.push(...r.value.needsHumanDecision);
      return { type: "spec-done" };
    }
    undoOutside(ctx, mark, outside);
    if (missing && r.value.needsHumanDecision.length > 0) {
      // AC-57: the role asks instead of writing the spec; a blind re-run would ask again.
      run.humanDecisions.push(...r.value.needsHumanDecision);
      return toLimit(ctx, "decision", "spec");
    }
    run.humanDecisions.length = kept;
    last = problems;
    feedback = boundsFeedback("spec", problems);
    ctx.out(`spec: ${problems.join("; ")}.${round === 0 ? " Undone; running spec once more." : ""}`);
  }
  throw new RunError(`The spec role broke its bounds twice (${last.join("; ")}). The run stays at spec; ${resumeHint(run.id)} tries again.`, 1);
};

/**
 * Waits until the spec is on the base ref (exit 3 every time it is not, AC-10, AC-47); then creates
 * `<stage>-<slug>` from the base ref and goes to plan (AC-11).
 */
const specMergeGate: StepHandler = async (ctx) => {
  const { run, cfg } = ctx;
  const dir = ctx.projectDir;
  const stage = stageOf(run);
  const base = baseRef(dir, cfg.baseBranch);
  const file = specPath(cfg, stage);
  if (!existsOnRef(dir, base, file)) {
    const f = new Facts().add(`The spec is committed on spec/${stage}, but ${file} is not on ${base} yet.`);
    // AC-10, AC-47: with no origin/<base> the local merge is the approval, so a push would only confuse.
    f.whole(
      base === cfg.baseBranch
        ? `Review spec/${stage}, then approve it with a local merge: git checkout ${cfg.baseBranch} && git merge spec/${stage}; then ${resumeHint(run.id)}.`
        : `Push and merge it: git push -u origin spec/${stage}, open and merge the pull request into ${cfg.baseBranch}; then git fetch, and ${resumeHint(run.id)}.`
    );
    f.whole(...decisionFacts(ctx));
    showCard(ctx, { gate: "spec-merge", title: `Spec ${stage} is ready to review — run ${run.id}`, facts: f.list, keep: f.keep, prompts: [], hint: resumeHint(run.id) });
    return NO_INPUT;
  }
  const name = `${stage}-${slugify(proposalOf(run).stage.title)}`;
  const how = enterRunBranch(ctx, name, base);
  run.branch = name;
  if (how === "created" || run.baseCommit === null) run.baseCommit = headSha(dir);
  recordGate(ctx, "gate:spec-merge", "merged");
  return { type: "merged" };
};

export const specHandlers = { spec: specStep, "gate:spec-merge": specMergeGate };
