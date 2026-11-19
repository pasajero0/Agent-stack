/** Task-mode helpers for the v04 engine tests: clarify / spec / plan responses and the path up to the gates. */
import { expect } from "vitest";
import { git } from "../hooks/fixture.js";
import { resumeRun, startRun } from "../../src/run/engine/index.js";
import type { Prompter } from "../../src/run/gate.js";
import { writeRun } from "../../src/run/store.js";
import type { RunFile } from "../../src/run/types.js";
import { impl, review, text, type Json, type Repo } from "./engine-fixture.js";

export const TASK_DESC = "Add a greeting file";
export const STAGE = "B1";
export const TITLE = "Add a greeting";
export const SPEC_BRANCH = "spec/B1";
export const WORK_BRANCH = "B1-add-a-greeting";
export const SPEC_PATH = "docs/specs/B1/SPEC.md";
export const TASKS_PATH = ".claude/tmp/B1/tasks.json";

export const specMd = (stage = STAGE): string =>
  [
    "---",
    `stage: ${stage}`,
    "---",
    "",
    "# Greeting",
    "",
    "## Acceptance criteria",
    "",
    "- **AC-1:** WHEN the repo is set up, THE SYSTEM SHALL have a hello file.",
    "- **AC-2:** WHEN the greeting is read, THE SYSTEM SHALL say bye too.",
    "",
  ].join("\n");

export const clarify = (o: { size?: "task" | "story" | "epic"; id?: string; split?: { id: string; goal: string }[] } = {}): Json => ({
  expectRole: "clarify",
  output: {
    questions: [{ text: "Which file?", recommended: "hello.txt" }],
    size: o.size ?? "task",
    stage: { id: o.id ?? STAGE, title: TITLE },
    ...(o.split ? { split: o.split } : {}),
  },
});

export const spec = (o: { writes?: Record<string, string>; needs?: string[]; stage?: string } = {}): Json => ({
  expectRole: "spec",
  writes: o.writes ?? { [`docs/specs/${o.stage ?? STAGE}/SPEC.md`]: specMd(o.stage) },
  output: { specPath: `docs/specs/${o.stage ?? STAGE}/SPEC.md`, summary: "the spec", needsHumanDecision: o.needs ?? [] },
});

export interface PlanTask {
  id: string;
  ac: string[];
  tier?: "S" | "M" | "L";
  desc?: string;
  verify?: string;
}

/** The tasks as the plan role returns them and as tasks.json holds them. */
export const planTasks = (tasks: PlanTask[]): Json[] =>
  tasks.map((t) => ({ id: t.id, ac: t.ac, tier: t.tier ?? "S", desc: t.desc ?? `do ${t.id}`, verify: t.verify ?? "true", passes: false }));

export const tasksJson = (tasks: PlanTask[]): string => JSON.stringify({ stage: STAGE, tasks: planTasks(tasks) });

/** The default plan: T1 makes hello.txt (AC-1), T2 makes bye.txt (AC-2). */
export const TWO_TASKS: PlanTask[] = [
  { id: "T1", ac: ["AC-1"], desc: "create the hello file", verify: "test -f hello.txt" },
  { id: "T2", ac: ["AC-2"], desc: "create the bye file", verify: "test -f bye.txt" },
];

/**
 * A plan call: it returns its tasks in the output and the driver writes tasks.json (AC-12). `raw` replaces the
 * tasks with any value; `writes` are files the role changes (out of bounds); `denials` go to permission_denials.
 */
export const plan = (
  o: { tasks?: PlanTask[]; raw?: unknown; writes?: Record<string, string>; needs?: string[]; exec?: string; denials?: Json[] } = {}
): Json => {
  const output = { summary: "the plan", tasks: o.raw !== undefined ? o.raw : planTasks(o.tasks ?? TWO_TASKS), needsHumanDecision: o.needs ?? [] };
  return {
    expectRole: "plan",
    writes: o.writes ?? {},
    ...(o.exec ? { exec: o.exec } : {}),
    output,
    ...(o.denials
      ? { stdout: { type: "result", subtype: "success", is_error: false, num_turns: 3, total_cost_usd: 0.01, permission_denials: o.denials, structured_output: output } }
      : {}),
  };
};

/** implement + review for T1 and T2 of TWO_TASKS. */
export const twoTasksDone = (): Json[] => [
  impl({ writes: { "hello.txt": "hello\n" }, subject: "Add the hello file." }),
  review(),
  impl({ writes: { "bye.txt": "bye\n" }, subject: "Add the bye file" }),
  review(),
];

/** Starts a task run that stops at gate:spec-merge (exit 3): clarify, answers (Enter × 3), spec. */
export async function toSpecMerge(r: Repo, extra: Json[] = []): Promise<void> {
  r.script([clarify(), spec(), ...extra]);
  const code = await startRun({ ...r.opts({ gate: ["", "", ""] }), mode: "task", description: TASK_DESC });
  expect(code, text(r)).toBe(3);
}

/** The human's merge of the spec branch into main, with no remote. */
export function mergeSpec(r: Repo): void {
  git(r.dir, "checkout", "-q", "main");
  git(r.dir, "merge", "-q", "--no-ff", "-m", "merge spec", SPEC_BRANCH);
}

/** Start, merge, resume to gate:plan-approve (no gate input after the plan: exit 3). */
export async function toPlanApprove(r: Repo, after: Json[]): Promise<void> {
  await toSpecMerge(r, after);
  mergeSpec(r);
  const code = await resumeRun({ ...r.opts() });
  expect(code, text(r)).toBe(3);
}

/** Rewrites the run file as a kill at some point would have left it. */
export function patchRun(r: Repo, over: Partial<RunFile>): void {
  writeRun(r.dir, { ...r.run(), ...over });
}

/** Gate answers in order; `before(i)` runs before answer i is given (a human acting while the gate waits). */
export function prompter(answers: string[], before: (i: number) => void = () => {}): Prompter {
  let i = 0;
  return {
    ask: async () => {
      before(i);
      return answers[i++] ?? null;
    },
    close: () => {},
  };
}
