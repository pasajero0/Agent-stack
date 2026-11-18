import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupProjects, write } from "../hooks/fixture.js";
import { resumeRun, startRun } from "../../src/run/engine/index.js";
import { impl, makeFakeExecutable, repo, review, sh, text } from "./engine-fixture.js";
import {
  clarify,
  mergeSpec,
  plan,
  spec,
  SPEC_BRANCH,
  TASK_DESC,
  TASKS_PATH,
  tasksJson,
  toPlanApprove,
  toSpecMerge,
  twoTasksDone,
  WORK_BRANCH,
} from "./engine-task-fixture.js";

beforeAll(makeFakeExecutable);
afterEach(() => cleanupProjects());

describe("task mode: plan and gate:plan-approve", () => {
  it("v04 AC-12: a valid plan in bounds stops at gate:plan-approve showing each task's id, criteria, tier, model and verify", async () => {
    const r = repo();
    await toPlanApprove(r, [plan()]);
    const run = r.run();
    expect(run.next).toBe("gate:plan-approve");
    expect(run.status).toBe("waiting");
    const t = text(r);
    expect(t).toMatch(/T1.*AC-1.*tier S.*sonnet/);
    expect(t).toContain("verify: test -f hello.txt");
    expect(t).toMatch(/T2.*AC-2/);
  });

  it("v04 AC-13: an S/M task whose description or criterion has a risk word is marked risky at the gate and runs on Opus (AC-16)", async () => {
    const r = repo();
    const tasks = [
      { id: "T1", ac: ["AC-1"], tier: "S" as const, desc: "store the auth Token for the greeting", verify: "test -f hello.txt" },
      { id: "T2", ac: ["AC-2"], tier: "M" as const, desc: "say bye", verify: "true" },
    ];
    await toPlanApprove(r, [
      plan({ tasks }),
      impl({ model: "opus", writes: { "hello.txt": "hi\n" } }),
      review(),
      impl({ model: "sonnet", writes: { "bye.txt": "bye\n" } }),
      review(),
    ]);
    const t = text(r);
    expect(t).toMatch(/T1.*risky.*opus/);
    expect(t).not.toMatch(/T2.*risky/);
    const code = await resumeRun({ ...r.opts({ gate: ["a", "a"] }) });
    expect(code, text(r)).toBe(0);
  });

  it("v04 AC-14: reject at gate:plan-approve deletes tasks.json and verify.log and re-runs plan with the comment", async () => {
    const r = repo();
    // The fake writes before it runs exec, so the second plan copies its tasks.json after checking the deletion.
    const again = `test ! -f ${TASKS_PATH} && test ! -f .claude/tmp/B1/verify.log && cp .git/plan2.json ${TASKS_PATH}`;
    write(r.dir, ".git/plan2.json", tasksJson([{ id: "T1", ac: ["AC-1", "AC-2"] }]));
    await toPlanApprove(r, [plan(), plan({ writes: {}, exec: again })]);
    write(r.dir, ".claude/tmp/B1/verify.log", "old\n");
    const code = await resumeRun({ ...r.opts({ gate: ["r", "split T1 in two", "c"] }) });
    expect(code, text(r)).toBe(0);
    const run = r.run();
    expect(run.status).toBe("cancelled");
    expect(run.gates.map((g) => `${g.gate} ${g.decision} ${g.comment ?? ""}`.trim())).toEqual([
      "gate:answers confirm",
      "gate:spec-merge merged",
      "gate:plan-approve reject split T1 in two",
      "gate:plan-approve cancel",
    ]);
    expect(r.logged().length).toBe(4);
    expect(r.logged()[3]?.prompt).toContain("split T1 in two");
    expect(r.logged()[2]?.prompt).not.toContain("split T1 in two");
  });

  it("v04 AC-45: a plan that does not cover every criterion is deleted and re-run once with the error", async () => {
    const r = repo();
    const partial = tasksJson([{ id: "T1", ac: ["AC-1"] }]);
    await toPlanApprove(r, [plan({ writes: { [TASKS_PATH]: partial } }), plan()]);
    expect(r.run().next).toBe("gate:plan-approve");
    expect(r.logged().length).toBe(4);
    const tasks: unknown = JSON.parse(readFileSync(join(r.dir, TASKS_PATH), "utf8"));
    expect(tasks).toMatchObject({ tasks: [{ id: "T1" }, { id: "T2" }] });
  });

  it("v04 AC-45: an invalid plan twice exits 1 at plan and leaves no tasks.json", async () => {
    const r = repo();
    const bad = tasksJson([
      { id: "Q1", ac: ["AC-1"] },
      { id: "T2", ac: ["AC-2"] },
    ]);
    await toSpecMerge(r, [plan({ writes: { [TASKS_PATH]: bad } }), plan({ writes: { [TASKS_PATH]: "{}" } })]);
    mergeSpec(r);
    expect(await resumeRun({ ...r.opts() })).toBe(1);
    expect(r.run().next).toBe("plan");
    expect(existsSync(join(r.dir, TASKS_PATH))).toBe(false);
    expect(text(r)).toMatch(/Q1/);
  });

  it("v04 AC-45: a task id outside [A-Za-z0-9._-] makes the plan invalid, and plan is re-run once with the error", async () => {
    const r = repo();
    const bad = tasksJson([
      { id: "T1;touch pwned", ac: ["AC-1"] },
      { id: "T2", ac: ["AC-2"] },
    ]);
    await toPlanApprove(r, [plan({ writes: { [TASKS_PATH]: bad } }), plan()]);
    expect(r.run().next).toBe("gate:plan-approve");
    expect(r.logged().length).toBe(4);
    expect(r.logged()[3]?.prompt).toMatch(/FROM THE PROGRAM[\s\S]*T1;touch pwned/);
    expect(text(r)).toMatch(/^T1 \[AC-1\]/m);
  });

  it("v04 AC-40: a plan role that writes outside .claude/tmp/<stage>/ is undone and, the second time, exits 1", async () => {
    const r = repo();
    const out = (n: number) => plan({ writes: { [TASKS_PATH]: tasksJson([{ id: "T1", ac: ["AC-1", "AC-2"] }]), [`src/x${n}.ts`]: "x\n" } });
    await toSpecMerge(r, [out(1), out(2)]);
    mergeSpec(r);
    expect(await resumeRun({ ...r.opts() })).toBe(1);
    expect(existsSync(join(r.dir, "src/x1.ts"))).toBe(false);
    expect(existsSync(join(r.dir, "src/x2.ts"))).toBe(false);
    expect(existsSync(join(r.dir, TASKS_PATH))).toBe(false);
    expect(text(r)).toContain("src/x2.ts");
    expect(r.logged()[3]?.prompt).toMatch(/FROM THE PROGRAM[\s\S]*src\/x1\.ts/);
    expect(r.run().next).toBe("plan");
    expect(sh(r.dir, "branch", "--show-current")).toBe(WORK_BRANCH);
  });

  it("v04 AC-40: a plan role that commits and then ends with error_max_budget_usd leaves no new commit on the run branch", async () => {
    const r = repo();
    const budget = { type: "result", subtype: "error_max_budget_usd", is_error: true, num_turns: 9, total_cost_usd: 0.5 };
    const sneaky = { ...plan({ exec: "git commit -q --allow-empty -m sneaky" }), stdout: budget, exit: 1 };
    await toSpecMerge(r, [sneaky]);
    mergeSpec(r);
    expect(await resumeRun({ ...r.opts() }), text(r)).toBe(3);
    expect(r.run()).toMatchObject({ next: "gate:limit", returnTo: "plan", limitReason: "fuse" });
    expect(sh(r.dir, "branch", "--show-current")).toBe(WORK_BRANCH);
    expect(sh(r.dir, "rev-parse", WORK_BRANCH)).toBe(sh(r.dir, "rev-parse", "main"));
    expect(sh(r.dir, "log", "--format=%s", WORK_BRANCH)).not.toContain("sneaky");
  });

  it("v04 AC-45: a task id that only starts with F (not F<digits>) is a valid plan id", async () => {
    const r = repo();
    await toPlanApprove(r, [plan({ tasks: [{ id: "Fixture", ac: ["AC-1", "AC-2"] }] })]);
    expect(r.run().next).toBe("gate:plan-approve");
    expect(r.logged().length).toBe(3);
    expect(text(r)).toMatch(/^Fixture \[AC-1, AC-2\]/m);
  });

  it("v04 AC-45: a task id F<digits> clashes with the fix tasks and makes the plan invalid", async () => {
    const r = repo();
    const bad = tasksJson([{ id: "F1", ac: ["AC-1", "AC-2"] }]);
    await toPlanApprove(r, [plan({ writes: { [TASKS_PATH]: bad } }), plan()]);
    expect(r.logged().length).toBe(4);
    expect(r.logged()[3]?.prompt).toMatch(/FROM THE PROGRAM[\s\S]*F1/);
  });

  it("v04 AC-32: needsHumanDecision from spec and plan is shown at the next gate, then cleared", async () => {
    const r = repo();
    r.script([clarify(), spec({ needs: ["pick a greeting language"] }), plan({ needs: ["T2 may need a new dependency"] })]);
    expect(await startRun({ ...r.opts({ gate: ["", "", ""] }), mode: "task", description: TASK_DESC })).toBe(3);
    expect(text(r)).toContain("pick a greeting language");
    mergeSpec(r);
    r.out.length = 0;
    expect(await resumeRun({ ...r.opts() })).toBe(3);
    const run = r.run();
    expect(text(r)).toContain("T2 may need a new dependency");
    expect(text(r)).not.toContain("pick a greeting language");
    expect(run.humanDecisions).toEqual(["T2 may need a new dependency"]);
  });

  it("v04 AC-35: the calls fuse stops before the spec call at gate:limit; raising it returns to spec", async () => {
    const r = repo({ run: { fuse: { calls: 1 } } });
    r.script([clarify(), spec()]);
    expect(await startRun({ ...r.opts({ gate: ["", "", ""] }), mode: "task", description: TASK_DESC })).toBe(3);
    let run = r.run();
    expect(run.next).toBe("gate:limit");
    expect(run.returnTo).toBe("spec");
    expect(run.limitReason).toBe("fuse");
    expect(await resumeRun({ ...r.opts({ gate: ["f 5"] }) })).toBe(3);
    run = r.run();
    expect(run.next).toBe("gate:spec-merge");
    expect(sh(r.dir, "log", "-1", "--format=%s", SPEC_BRANCH)).toContain("spec");
  });
});

describe("task mode: base-check, tasks and gate:accept", () => {
  it("v04 AC-15: approve goes to base-check, which runs test on the clean tree before T1", async () => {
    const r = repo({ test: "test ! -f hello.txt || test -f bye.txt" });
    await toPlanApprove(r, [plan(), ...twoTasksDone()]);
    expect(await resumeRun({ ...r.opts({ gate: ["a", "a"] }) })).toBe(0);
    expect(r.run().gates.map((g) => g.decision)).toEqual(["confirm", "merged", "approve", "accept"]);
  });

  it("v04 AC-41: a red test at base-check exits 1 naming the command and keeps next at base-check", async () => {
    const r = repo({ test: "test -f base-ok.txt" });
    await toPlanApprove(r, [plan()]);
    expect(await resumeRun({ ...r.opts({ gate: ["a"] }) })).toBe(1);
    expect(r.run().next).toBe("base-check");
    expect(text(r)).toContain("test -f base-ok.txt");
    expect(r.logged().length).toBe(3);
  });

  it("v04 AC-16: tier L runs on Opus, S on Sonnet, and a retry after a red verify on Opus", async () => {
    const r = repo();
    const tasks = [
      { id: "T1", ac: ["AC-1"], tier: "L" as const, verify: "test -f hello.txt" },
      { id: "T2", ac: ["AC-2"], tier: "S" as const, verify: "test -f bye.txt" },
    ];
    await toPlanApprove(r, [
      plan({ tasks }),
      impl({ model: "opus", writes: { "hello.txt": "hi\n" } }),
      review(),
      impl({ model: "sonnet" }),
      impl({ model: "opus", writes: { "bye.txt": "bye\n" } }),
      review(),
    ]);
    const code = await resumeRun({ ...r.opts({ gate: ["a", "a"] }) });
    expect(code, text(r)).toBe(0);
    const t2 = r.run().tasks[1];
    expect(t2?.attempts).toBe(2);
    expect(t2?.lastFeedback).toContain(".claude/bin/verify T2");
    expect(t2?.lastFeedback).toContain("test -f bye.txt");
  });

  it("v04 AC-22: reject at gate:accept implements a fix task F1 on Opus, checks every task's verify, reviews, commits and returns to gate:accept", async () => {
    const r = repo();
    await toPlanApprove(r, [
      plan(),
      ...twoTasksDone(),
      impl({ model: "opus", writes: { "hello.txt": "hello, world\n" }, subject: "Greet the world" }),
      review(),
    ]);
    const code = await resumeRun({ ...r.opts({ gate: ["a", "r", "greet the world", "a"] }) });
    expect(code, text(r)).toBe(0);
    const run = r.run();
    expect(run.status).toBe("finished");
    const f1 = run.tasks.find((t) => t.id === "F1");
    expect(f1?.checks.map((c) => c.cmd)).toEqual([".claude/bin/verify", "(empty lint command)"]);
    expect(f1?.commit).toBe(sh(r.dir, "rev-parse", "HEAD"));
    expect(sh(r.dir, "log", "-1", "--format=%s")).toBe("fix(b1): greet the world");
    expect(sh(r.dir, "rev-list", "--count", `main..${WORK_BRANCH}`)).toBe("3");
    expect(text(r).match(/== gate:accept/g)?.length).toBe(2);
  });
});
