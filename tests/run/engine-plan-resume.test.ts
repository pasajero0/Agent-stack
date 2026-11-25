import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupProjects, git, write } from "../hooks/fixture.js";
import { resumeRun } from "../../src/run/engine/index.js";
import { commandName } from "../../src/run/engine/command.js";
import { readPlan } from "../../src/run/engine/plan-file.js";
import { loadRunConfig } from "../../src/run/config.js";
import { RunError } from "../../src/run/errors.js";
import { makeFakeExecutable, text, type Json, type Repo, repo } from "./engine-fixture.js";
import { patchRun, plan, planTasks, STAGE, TASKS_PATH, toPlanApprove, TWO_TASKS, WORK_BRANCH, type PlanTask } from "./engine-task-fixture.js";

beforeAll(makeFakeExecutable);
afterEach(() => cleanupProjects());

const HEAD = `.claude/tmp/${STAGE}/tasks.json is no longer a valid plan:`;
const cancel = (id: string): string => `or cancel the run: ${commandName()} run --cancel ${id}.`;
const noComplexity = (task: string, id: string): string =>
  `${HEAD} task ${task} needs a complexity of low, medium or high. Add "complexity" to each task by hand, ${cancel(id)}`;
const noSplit = (task: string, id: string): string =>
  `${HEAD} task ${task} is tier L and needs a splitReason: why it is not split. Add "splitReason" to that task by hand, ${cancel(id)}`;
const longSplit = (task: string, id: string): string =>
  `${HEAD} task ${task}: splitReason must be at most 80 characters. Shorten it by hand, ${cancel(id)}`;

/** The tasks.json text with each task changed by `edit` (e.g. a 0.4.7 plan: no complexity). */
function planText(tasks: PlanTask[], edit: (t: Json) => Json): string {
  return JSON.stringify({ stage: STAGE, tasks: planTasks(tasks).map(edit) });
}

const without =
  (key: string) =>
  (t: Json): Json =>
    Object.fromEntries(Object.entries(t).filter(([k]) => k !== key));

/** A 0.4.7 plan: the same tasks without complexity. */
const OLD_PLAN = planText(TWO_TASKS, without("complexity"));

const runFilePath = (r: Repo): string => join(r.dir, ".claude/tmp/runs", r.run().id, "run.json");

/** A task run at gate:plan-approve (exit 3), with `tasks` written over its tasks.json. */
async function atPlanApprove(r: Repo, tasks: string, after: Json[] = [plan()]): Promise<void> {
  await toPlanApprove(r, after);
  write(r.dir, TASKS_PATH, tasks);
  r.out.length = 0;
}

describe("effort1 AC-15: a resume with a plan that is no longer valid", () => {
  it("effort1 AC-15: a 0.4.7 plan at gate:plan-approve exits 1 with the complexity line; the run file is unchanged", async () => {
    const r = repo();
    await atPlanApprove(r, OLD_PLAN);
    const before = readFileSync(runFilePath(r), "utf8");
    const id = r.run().id;
    expect(await resumeRun({ ...r.opts({ gate: ["a"] }) })).toBe(1);
    expect(text(r)).toContain(noComplexity("T1", id));
    expect(readFileSync(runFilePath(r), "utf8")).toBe(before);
    expect(r.run()).toMatchObject({ next: "gate:plan-approve", status: "waiting" });
  });

  it("effort1 AC-15: a 0.4.7 plan at implement exits 1 before the lock; the run file is unchanged", async () => {
    const r = repo();
    await atPlanApprove(r, OLD_PLAN);
    patchRun(r, { next: "implement:T1", status: "running" });
    const before = readFileSync(runFilePath(r), "utf8");
    const id = r.run().id;
    expect(await resumeRun({ ...r.opts() })).toBe(1);
    expect(text(r)).toContain(noComplexity("T1", id));
    expect(readFileSync(runFilePath(r), "utf8")).toBe(before);
    expect(r.logged().length).toBe(3);
  });

  it("effort1 AC-15: the first task that fails is named", async () => {
    const r = repo();
    const tasks = planText(TWO_TASKS, (t) => (t.id === "T2" ? without("complexity")(t) : t));
    await atPlanApprove(r, tasks);
    patchRun(r, { next: "implement:T1", status: "running" });
    expect(await resumeRun({ ...r.opts() })).toBe(1);
    expect(text(r)).toContain(noComplexity("T2", r.run().id));
  });

  it("effort1 AC-15: an L task with no splitReason exits 1 with the splitReason line", async () => {
    const r = repo();
    const tasks = planText([{ ...TWO_TASKS[0]!, tier: "L" }, TWO_TASKS[1]!], without("splitReason"));
    await atPlanApprove(r, tasks);
    patchRun(r, { next: "implement:T1", status: "running" });
    const before = readFileSync(runFilePath(r), "utf8");
    expect(await resumeRun({ ...r.opts() })).toBe(1);
    expect(text(r)).toContain(noSplit("T1", r.run().id));
    expect(readFileSync(runFilePath(r), "utf8")).toBe(before);
  });

  it("effort1 AC-15: an L task with a splitReason longer than 80 characters exits 1 with the shorten line", async () => {
    const r = repo();
    const tasks = planText([{ ...TWO_TASKS[0]!, tier: "L", splitReason: "x".repeat(81) }, TWO_TASKS[1]!], (t) => t);
    await atPlanApprove(r, tasks);
    patchRun(r, { next: "implement:T1", status: "running" });
    expect(await resumeRun({ ...r.opts() })).toBe(1);
    expect(text(r)).toContain(longSplit("T1", r.run().id));
  });

  it("effort1 AC-15: a wrong branch gets its git switch hint first", async () => {
    const r = repo();
    await atPlanApprove(r, OLD_PLAN);
    git(r.dir, "checkout", "-q", "main");
    expect(await resumeRun({ ...r.opts({ gate: ["a"] }) })).toBe(1);
    expect(text(r)).toContain(`Run git switch ${WORK_BRANCH}`);
    expect(text(r)).not.toContain("no longer a valid plan");
  });

  it("effort1 AC-15: at gate:limit with returnTo plan the check does not run", async () => {
    const r = repo();
    await atPlanApprove(r, OLD_PLAN);
    patchRun(r, { next: "gate:limit", status: "waiting", returnTo: "plan", limitReason: "fuse" });
    expect(await resumeRun({ ...r.opts() })).toBe(3);
    expect(text(r)).not.toContain("no longer a valid plan");
    expect(r.run().next).toBe("gate:limit");
  });

  it("effort1 AC-15: at next=plan a 0.4.7 leftover is deleted and plan runs again", async () => {
    const r = repo();
    await atPlanApprove(r, OLD_PLAN, [plan(), plan()]);
    patchRun(r, { next: "plan", status: "running", humanDecisions: [] });
    expect(await resumeRun({ ...r.opts() }), text(r)).toBe(3);
    expect(r.run().next).toBe("gate:plan-approve");
    expect(r.logged().length).toBe(4);
    const tasks: unknown = JSON.parse(readFileSync(join(r.dir, TASKS_PATH), "utf8"));
    expect(tasks).toMatchObject({ tasks: [{ id: "T1", complexity: "low" }, { id: "T2", complexity: "low" }] });
  });

  it("effort1 AC-15: readPlan mid-run uses the same lines, never a default complexity; other problems keep Restore it", async () => {
    const r = repo();
    await atPlanApprove(r, OLD_PLAN);
    const id = r.run().id;
    const cfg = loadRunConfig(r.dir);
    const err = (): string => {
      try {
        readPlan(r.dir, cfg, STAGE, id);
      } catch (e) {
        if (e instanceof RunError) return e.message;
        throw e;
      }
      return "no error";
    };
    expect(err()).toBe(noComplexity("T1", id));
    write(r.dir, TASKS_PATH, planText([{ ...TWO_TASKS[0]!, tier: "L" }, TWO_TASKS[1]!], without("splitReason")));
    expect(err()).toBe(noSplit("T1", id));
    write(r.dir, TASKS_PATH, planText([TWO_TASKS[0]!], (t) => t));
    expect(err()).toBe(`${HEAD} no task covers AC-2 of the spec. Restore it, or cancel the run.`);
  });
});
