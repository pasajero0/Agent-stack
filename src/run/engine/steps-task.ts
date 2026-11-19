/**
 * Task mode: clarify, gate:answers (stage id, epic split), then spec / plan (steps-spec.ts, steps-plan.ts) and
 * the common task loop with 3 attempts. Spec: docs/specs/v04/SPEC.md, "Task mode" table, "Gate input",
 * AC-5..AC-9, AC-13, AC-16, AC-22, AC-48, AC-49.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { RunError } from "../errors.js";
import { baseRef, branchExists, existsOnRef } from "../git.js";
import { clarifyPrompt } from "../prompts.js";
import { parseClarify, type ClarifyOutput } from "../schemas.js";
import { runDir } from "../store.js";
import type { AnswerRecord } from "../types.js";
import { judgeCall } from "./call.js";
import { resumeHint, type Ctx, type ModeSteps, type StepHandler } from "./context.js";
import { ask, fixComment, NO_INPUT, recordGate, showDecisions } from "./gates.js";
import { readPlan, readSpec } from "./plan-file.js";
import { withFeedback } from "./role-bounds.js";
import { lintItems, toLimit } from "./steps-common.js";
import { planHandlers, planTaskInfo } from "./steps-plan.js";
import { proposalOf, specHandlers, stageOf } from "./steps-spec.js";
import type { StepEvent } from "./transitions.js";

const isFix = (id: string): boolean => /^F\d+$/.test(id);

const clarify: StepHandler = async (ctx) => {
  const base = clarifyPrompt({ description: ctx.run.description });
  const r = await judgeCall(ctx, "clarify", (fb) => withFeedback(base, [fb]), parseClarify);
  if (r.kind === "fuse") return toLimit(ctx, "fuse", "clarify");
  ctx.run.proposal = r.value;
  return { type: "clarified" };
};

/** The stage-id characters: letters, digits, ".", "_" and "-", not starting with "." (AC-7, AC-9). */
const stageIdChars = (id: string): boolean => /^[A-Za-z0-9._-]+$/.test(id) && !id.startsWith(".");

/** Why `id` cannot be the stage id (AC-7), or null when it can. */
export function stageIdProblem(ctx: Ctx, id: string): string | null {
  const dir = ctx.projectDir;
  if (!stageIdChars(id)) return 'it may hold only letters, digits, ".", "_" and "-", and not start with "."';
  const m = new RegExp(ctx.cfg.stagePattern).exec(`${id}-x`);
  if (!m || m[1] !== id) {
    return `the stage pattern ${ctx.cfg.stagePattern} maps "${id}-x" to ${m?.[1] ? `"${m[1]}"` : "no stage"}, not "${id}" (use letters then digits, e.g. B1)`;
  }
  const base = baseRef(dir, ctx.cfg.baseBranch);
  const specDir = `${ctx.cfg.specsDir}/${id}`;
  if (existsOnRef(dir, base, specDir)) return `${specDir}/ already exists on ${base}`;
  if (branchExists(dir, `spec/${id}`)) return `branch spec/${id} already exists`;
  return null;
}

function answersSummary(ctx: Ctx, p: ClarifyOutput): void {
  ctx.out(`== gate:answers — run ${ctx.run.id} ==`);
  ctx.out(`Description: ${ctx.run.description}`);
  ctx.out(`Proposed: size ${p.size}, stage ${p.stage.id} — ${p.stage.title}`);
  for (const s of p.split ?? []) ctx.out(`  part ${s.id}: ${s.goal}`);
  showDecisions(ctx);
  ctx.out("For each prompt: Enter accepts the recommended answer or keeps the value, text replaces it, c cancels.");
}

/** One shell word: single quotes, a `'` as `'\''`; newlines become spaces so the command stays one line. */
const quote = (s: string): string => `'${s.replace(/[\r\n]+/g, " ").replace(/'/g, "'\\''")}'`;

/**
 * AC-9: split.md in the run folder and one command per part; the run then finishes. A part whose id fails the
 * stage-id characters gets no command (it would be pasted into a shell), only a note.
 */
function writeSplit(ctx: Ctx, p: ClarifyOutput): void {
  const all = p.split ?? [];
  const parts = all.filter((s) => stageIdChars(s.id));
  const dropped = all.filter((s) => !stageIdChars(s.id));
  const cmds = parts.map((s) => `agent-stack run task --stage ${s.id} ${quote(s.goal)}`);
  const body = [
    `# Epic split — ${p.stage.title}`,
    "",
    `Description: ${ctx.run.description}`,
    "",
    ...(parts.length > 0
      ? parts.flatMap((s, i) => [`- **${s.id}**: ${s.goal}`, `  \`${cmds[i] ?? ""}\``])
      : ["No usable split was proposed. Split the work by hand and start each part with agent-stack run task --stage <id> \"<goal>\"."]),
    ...dropped.map((s) => `- dropped: the proposed id ${JSON.stringify(s.id)} is not a valid stage id (letters, digits, ".", "_", "-"); goal: ${s.goal}`),
    "",
  ].join("\n");
  const file = join(runDir(ctx.projectDir, ctx.run.id), "split.md");
  writeFileSync(file, body);
  ctx.out(`Epic: the split is in ${file}. Start each part as its own run:`);
  for (const c of cmds) ctx.out(`  ${c}`);
  if (dropped.length > 0) ctx.out(`  (${dropped.length} part(s) with an invalid id dropped; see split.md)`);
}

type Size = ClarifyOutput["size"];
const SIZES: readonly Size[] = ["task", "story", "epic"];
const sizeOf = (s: string): Size | undefined => SIZES.find((x) => x === s);

/** gate:answers: per question, then the size, then the stage id (AC-6, AC-7, AC-9, AC-48). */
const answersGate: StepHandler = async (ctx) => {
  const { run } = ctx;
  const p = proposalOf(run);
  answersSummary(ctx, p);
  const cancel = (): StepEvent => {
    recordGate(ctx, "gate:answers", "cancel");
    return { type: "cancel" };
  };
  const answers: AnswerRecord[] = [];
  for (const [i, q] of p.questions.entries()) {
    ctx.out(`Q${i + 1}: ${q.text} [recommended: ${q.recommended}]`);
    // Gate input: the prompt itself says what Enter does, so a reply meant for another prompt is not typed over it.
    const a = await ask(ctx, `answer ${i + 1} (Enter = recommended, or type your own)> `);
    if (a === null) return NO_INPUT;
    const s = a.trim();
    if (s === "c") return cancel();
    answers.push({ question: q.text, answer: s === "" ? q.recommended : s });
  }
  let size: Size = p.size;
  for (;;) {
    ctx.out(`Size [${size}]: Enter keeps it, or type task, story or epic`);
    const a = await ask(ctx, "size> ");
    if (a === null) return NO_INPUT;
    const s = a.trim();
    if (s === "c") return cancel();
    const picked = s === "" ? size : sizeOf(s);
    if (picked !== undefined) {
      size = picked;
      break;
    }
    ctx.out("Answer task, story or epic.");
  }
  if (size === "epic") {
    run.answers = answers;
    run.size = size;
    writeSplit(ctx, p);
    recordGate(ctx, "gate:answers", "epic");
    return { type: "epic" };
  }
  let id = run.stagePrefill ?? p.stage.id;
  for (;;) {
    ctx.out(`Stage id [${id}]: Enter keeps it, or type a new one`);
    const a = await ask(ctx, "stage> ");
    if (a === null) return NO_INPUT;
    const s = a.trim();
    if (s === "c") return cancel();
    if (s !== "") id = s;
    const why = stageIdProblem(ctx, id);
    if (why === null) break;
    ctx.out(`Stage id ${id} cannot be used: ${why}. Type another one.`);
  }
  run.answers = answers;
  run.size = size;
  run.stage = id;
  recordGate(ctx, "gate:answers", "confirm");
  return { type: "answered" };
};

export const taskMode: ModeSteps = {
  maxAttempts: 3,
  handlers: { clarify, "gate:answers": answersGate, ...specHandlers, ...planHandlers },

  /** AC-5: clarify first; no branch until the answers are confirmed. `--stage` pre-fills the stage id (AC-7). */
  start(input) {
    return { next: "clarify", tasks: [], newBranch: null, stagePrefill: input.stage };
  },

  taskInfo(ctx, id) {
    const { run } = ctx;
    if (isFix(id)) {
      const desc = `Fix what the human asked for after rejecting the result of "${run.description}" (stage ${run.stage ?? "?"}): ${fixComment(run, id)}`;
      return { id, desc, criteria: [], tier: "M", risky: false, fix: true, verify: "" };
    }
    const stage = stageOf(run);
    const t = readPlan(ctx.projectDir, ctx.cfg, stage).find((x) => x.id === id);
    if (!t) throw new RunError(`Task ${id} is not in .claude/tmp/${stage}/tasks.json any more. Restore the plan, then ${resumeHint(run.id)}.`, 1);
    return planTaskInfo(t, readSpec(ctx.projectDir, ctx.cfg, stage));
  },

  /**
   * A plan task: its verify through `.claude/bin/verify <id>`, plus lint (AC-19); F<k>: every task's verify plus
   * lint (AC-22). A plan task id is one shell word: parsePlan accepts only [A-Za-z0-9._-].
   */
  checkItems(ctx, task) {
    const verify = isFix(task.id) ? ".claude/bin/verify" : `.claude/bin/verify ${task.id}`;
    return [{ label: "verify", cmd: verify }, ...lintItems(ctx, task)];
  },

  /** Task mode reviews every task, an empty diff included (AC-20, AC-46). */
  needsReview: () => true,

  firstTask(ctx) {
    const first = ctx.run.tasks.find((t) => !isFix(t.id));
    if (!first) throw new RunError(`Run ${ctx.run.id} has no approved tasks; cancel it: agent-stack run --cancel ${ctx.run.id}.`, 1);
    return first.id;
  },

  nextTaskAfter(ctx, id) {
    if (isFix(id)) return null;
    const plan = ctx.run.tasks.filter((t) => !isFix(t.id));
    const i = plan.findIndex((t) => t.id === id);
    return plan[i + 1]?.id ?? null;
  },

  /**
   * Every task's verify once more before gate:accept, so a later task that broke an earlier one shows up
   * (AC-21, AC-61). Skipped with one plan task, and after a fix task, whose checks already are this.
   */
  finalCheck(ctx) {
    const last = ctx.run.tasks.at(-1);
    if (last === undefined || isFix(last.id)) return null;
    return ctx.run.tasks.filter((t) => !isFix(t.id)).length > 1 ? { label: "verify", cmd: ".claude/bin/verify" } : null;
  },

};
