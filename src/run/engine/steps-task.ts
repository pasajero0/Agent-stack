/**
 * Task mode: clarify, gate:answers (stage id, epic split), then spec / plan (steps-spec.ts, steps-plan.ts) and
 * the common task loop with 3 attempts. Spec: docs/specs/v04/SPEC.md, "Task mode" table, "Gate input",
 * AC-5..AC-9, AC-13, AC-16, AC-22, AC-48, AC-49.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { RunError } from "../errors.js";
import { baseRef, branchExists, existsOnRef, git } from "../git.js";
import { clarifyPrompt } from "../prompts.js";
import { parseClarify, type ClarifyOutput } from "../schemas.js";
import { runDir } from "../store.js";
import type { AnswerRecord } from "../types.js";
import { judgeCall } from "./call.js";
import { resumeHint, type Ctx, type ModeSteps, type StepHandler } from "./context.js";
import { ask, fixComment, NO_INPUT, recordGate, showDecisions } from "./gates.js";
import { readPlan, readSpec } from "./plan-file.js";
import { withFeedback } from "./role-bounds.js";
import { lintItems, toLimit } from "./task-core.js";
import { planHandlers, planTaskInfo } from "./steps-plan.js";
import { proposalOf, specHandlers, stageOf } from "./steps-spec.js";
import type { StepEvent } from "./transitions.js";

const isFix = (id: string): boolean => /^F\d+$/.test(id);

/** Stage ids in use: spec folders on the base ref and `spec/*` branches, sorted (AC-48). */
export function usedStageIds(ctx: Ctx): string[] {
  const dir = ctx.projectDir;
  const base = baseRef(dir, ctx.cfg.baseBranch);
  const lines = (out: string): string[] => out.split("\n").map((l) => l.trim()).filter((l) => l !== "");
  // Folders only (-d): a README.md in the specs folder is not an id.
  const tree = git(dir, ["ls-tree", "-d", "--name-only", `${base}:${ctx.cfg.specsDir}`]);
  // spec/A5/wip takes A5 too: git cannot create spec/A5 next to it.
  const branches = lines(git(dir, ["for-each-ref", "--format=%(refname:lstrip=3)", "refs/heads/spec/"]).stdout).map(
    (b) => b.split("/")[0] ?? b
  );
  return [...new Set([...(tree.ok ? lines(tree.stdout) : []), ...branches])].sort();
}

/**
 * The id the gate offers when no proposal passes AC-7 (AC-48): the letters of the id in use with the highest
 * number, and the next number in the same width; `A1` when none is in use.
 */
export function offeredStageId(used: string[]): string {
  let best: { letters: string; n: number; width: number } | null = null;
  for (const id of used) {
    const m = /^([A-Za-z]+)([0-9]+)$/.exec(id);
    if (!m || m[1] === undefined || m[2] === undefined) continue;
    const n = Number(m[2]);
    if (best === null || n > best.n) best = { letters: m[1], n, width: m[2].length };
  }
  if (best === null) return "A1";
  return `${best.letters}${String(best.n + 1).padStart(best.width, "0")}`;
}

/** A free id that passes AC-7, counting up from the offered one. */
function freeStageId(ctx: Ctx, used: string[]): string {
  const first = offeredStageId(used);
  const m = /^([A-Za-z]+)([0-9]+)$/.exec(first);
  const letters = m?.[1] ?? "A";
  const width = m?.[2]?.length ?? 1;
  for (let n = Number(m?.[2] ?? 1), i = 0; i < 1000; n++, i++) {
    const id = `${letters}${String(n).padStart(width, "0")}`;
    if (stageIdProblem(ctx, id) === null) return id;
  }
  throw new RunError("No free stage id found; type one at the gate.", 1);
}

const clarify: StepHandler = async (ctx) => {
  const base = clarifyPrompt({ description: ctx.run.description, used: usedStageIds(ctx) });
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
  // AC-48: one plain reason; the pattern check below would refuse any other character anyway.
  if (!stageIdChars(id)) return "it must be letters then digits, like A1";
  const m = new RegExp(ctx.cfg.stagePattern).exec(`${id}-x`);
  if (!m || m[1] !== id) {
    return "it must be letters then digits, like A1";
  }
  const base = baseRef(dir, ctx.cfg.baseBranch);
  const specDir = `${ctx.cfg.specsDir}/${id}`;
  if (existsOnRef(dir, base, specDir)) return `${specDir}/ already exists on ${base}`;
  if (branchExists(dir, `spec/${id}`)) return `branch spec/${id} already exists`;
  const nested = git(dir, ["for-each-ref", "--count=1", "--format=%(refname:short)", `refs/heads/spec/${id}/`]).stdout.trim();
  if (nested !== "") return `branch ${nested} exists, so git cannot create spec/${id}`;
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
  // AC-48: the default is always a valid id, so Enter never loops on a failed one.
  let id = run.stagePrefill ?? p.stage.id;
  const first = stageIdProblem(ctx, id);
  if (first !== null) {
    ctx.out(`Stage id ${id} cannot be used: ${first}.`);
    id = id !== p.stage.id && stageIdProblem(ctx, p.stage.id) === null ? p.stage.id : freeStageId(ctx, usedStageIds(ctx));
  }
  for (;;) {
    ctx.out(`Stage id [${id}]: Enter keeps it, or type a new one`);
    const a = await ask(ctx, "stage> ");
    if (a === null) return NO_INPUT;
    const s = a.trim();
    if (s === "c") return cancel();
    if (s === "") break;
    const why = stageIdProblem(ctx, s);
    if (why === null) {
      id = s;
      break;
    }
    ctx.out(`Stage id ${s} cannot be used: ${why}. Type another one.`);
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
   * A plan task's own verify through `verify --dry`: guarded like every verify, nothing recorded (AC-63). A fix
   * task has an empty verify today; the isFix test keeps it out even if that changes.
   */
  startCheck(_ctx, task, info) {
    return isFix(task.id) || info.verify.trim() === "" ? null : `.claude/bin/verify --dry ${task.id}`;
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
