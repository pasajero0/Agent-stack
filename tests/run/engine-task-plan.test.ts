import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupProjects, write } from "../hooks/fixture.js";
import { resumeRun, startRun } from "../../src/run/engine/index.js";
import { impl, makeFakeExecutable, repo, review, sh, text } from "./engine-fixture.js";
import {
  clarify,
  scout,
  mergeSpec,
  plan,
  planTasks,
  spec,
  SPEC_BRANCH,
  TASK_DESC,
  TASKS_PATH,
  toPlanApprove,
  toSpecMerge,
  TWO_TASKS,
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
    expect(t).toMatch(/T1 {2}S · low -> sonnet · low · AC-1/);
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
    expect(t).toMatch(/T1 {2}\w · \w+ -> opus · high · risky/);
    expect(t).not.toMatch(/T2.*risky/);
    const code = await resumeRun({ ...r.opts({ gate: ["a", "a"] }) });
    expect(code, text(r)).toBe(0);
  });

  it("v04 AC-14: reject at gate:plan-approve deletes tasks.json and verify.log and re-runs plan with the comment", async () => {
    const r = repo();
    // The second plan call fails (no result) unless the reject deleted tasks.json and verify.log first.
    const deleted = `test ! -f ${TASKS_PATH} && test ! -f .claude/tmp/B1/verify.log`;
    await toPlanApprove(r, [plan(), plan({ tasks: [{ id: "T1", ac: ["AC-1", "AC-2"] }], exec: deleted })]);
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
    expect(r.logged().length).toBe(5);
    expect(r.logged()[4]?.prompt).toContain("split T1 in two");
    expect(r.logged()[3]?.prompt).not.toContain("split T1 in two");
  });

  it("v04 AC-45: a plan that does not cover every criterion is deleted and re-run once with the error", async () => {
    const r = repo();
    await toPlanApprove(r, [plan({ tasks: [{ id: "T1", ac: ["AC-1"] }] }), plan()]);
    expect(r.run().next).toBe("gate:plan-approve");
    expect(r.logged().length).toBe(5);
    const tasks: unknown = JSON.parse(readFileSync(join(r.dir, TASKS_PATH), "utf8"));
    expect(tasks).toMatchObject({ tasks: [{ id: "T1" }, { id: "T2" }] });
  });

  it("v04 AC-65: a verify that cannot fail makes the plan invalid; plan is re-run once with the error", async () => {
    const r = repo();
    const bad = [
      { id: "T1", ac: ["AC-1"], verify: "test -f hello.txt || true" },
      { id: "T2", ac: ["AC-2"], verify: "test -f bye.txt" },
    ];
    await toPlanApprove(r, [plan({ tasks: bad }), plan()]);
    expect(r.run().next).toBe("gate:plan-approve");
    expect(r.logged()[4]?.prompt).toContain("task T1: verify cannot fail (|| true); remove it");
    const tasks: unknown = JSON.parse(readFileSync(join(r.dir, TASKS_PATH), "utf8"));
    expect(tasks).toMatchObject({ tasks: [{ verify: "test -f hello.txt" }, { verify: "test -f bye.txt" }] });
  });

  it("v04 AC-45: an invalid plan twice exits 1 at plan and leaves no tasks.json", async () => {
    const r = repo();
    const bad = [
      { id: "Q1", ac: ["AC-1"] },
      { id: "T2", ac: ["AC-2"] },
    ];
    await toSpecMerge(r, [plan({ tasks: bad }), plan({ tasks: [] })]);
    mergeSpec(r);
    expect(await resumeRun({ ...r.opts() })).toBe(1);
    expect(r.run().next).toBe("plan");
    expect(existsSync(join(r.dir, TASKS_PATH))).toBe(false);
    expect(text(r)).toMatch(/Q1/);
  });

  it("v04 AC-45: a task id outside [A-Za-z0-9._-] makes the plan invalid, and plan is re-run once with the error", async () => {
    const r = repo();
    const bad = [
      { id: "T1;touch pwned", ac: ["AC-1"] },
      { id: "T2", ac: ["AC-2"] },
    ];
    await toPlanApprove(r, [plan({ tasks: bad }), plan()]);
    expect(r.run().next).toBe("gate:plan-approve");
    expect(r.logged().length).toBe(5);
    expect(r.logged()[4]?.prompt).toMatch(/FROM THE PROGRAM[\s\S]*T1;touch pwned/);
    expect(text(r)).toMatch(/^ {2}T1 {2}\w · \w+ -> \w+ · \w+ · AC-1 /m);
  });

  it("v04 AC-40: a plan role that writes outside .claude/tmp/<stage>/ is undone and, the second time, exits 1", async () => {
    const r = repo();
    const out = (n: number) => plan({ tasks: [{ id: "T1", ac: ["AC-1", "AC-2"] }], writes: { [`src/x${n}.ts`]: "x\n" } });
    await toSpecMerge(r, [out(1), out(2)]);
    mergeSpec(r);
    expect(await resumeRun({ ...r.opts() })).toBe(1);
    expect(existsSync(join(r.dir, "src/x1.ts"))).toBe(false);
    expect(existsSync(join(r.dir, "src/x2.ts"))).toBe(false);
    expect(existsSync(join(r.dir, TASKS_PATH))).toBe(false);
    expect(text(r)).toContain("src/x2.ts");
    expect(r.logged()[4]?.prompt).toMatch(/FROM THE PROGRAM[\s\S]*src\/x1\.ts/);
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
    expect(r.logged().length).toBe(4);
    expect(text(r)).toMatch(/^ {2}Fixture {2}\w · \w+ -> \w+ · \w+ · AC-1,2 /m);
  });

  it("v04 AC-45: a task id F<digits> clashes with the fix tasks and makes the plan invalid", async () => {
    const r = repo();
    await toPlanApprove(r, [plan({ tasks: [{ id: "F1", ac: ["AC-1", "AC-2"] }] }), plan()]);
    expect(r.logged().length).toBe(5);
    expect(r.logged()[4]?.prompt).toMatch(/FROM THE PROGRAM[\s\S]*F1/);
  });

  it("v04 AC-32: needsHumanDecision from spec and plan is shown at the next gate, then cleared", async () => {
    const r = repo();
    r.script([scout(), clarify(), spec({ needs: ["pick a greeting language"] }), plan({ needs: ["T2 may need a new dependency"] })]);
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

  it("v04 AC-12: the driver writes the plan role's tasks to tasks.json; the role writes nothing", async () => {
    const r = repo();
    await toPlanApprove(r, [plan()]);
    expect(r.run().next).toBe("gate:plan-approve");
    const onDisk: unknown = JSON.parse(readFileSync(join(r.dir, TASKS_PATH), "utf8"));
    expect(onDisk).toEqual({ stage: "B1", tasks: planTasks(TWO_TASKS) });
    expect(r.logged()[3]?.prompt).toMatch(/do not write `?tasks\.json`?/i);
  });

  it("v04 AC-57: a plan role with no valid plan that asks for a decision stops at gate:limit, not a blind re-run", async () => {
    const r = repo();
    await toSpecMerge(r, [plan({ tasks: [], needs: ["Approve writing tasks.json?"] }), plan()]);
    mergeSpec(r);
    expect(await resumeRun({ ...r.opts() }), text(r)).toBe(3);
    expect(r.run()).toMatchObject({ next: "gate:limit", returnTo: "plan", limitReason: "decision" });
    expect(text(r)).toContain("Approve writing tasks.json?");
    expect(r.logged().length).toBe(4);
    expect(existsSync(join(r.dir, TASKS_PATH))).toBe(false);
  });

  it("v04 AC-57: r at gate:limit (decision) re-runs the role with the human's comment, labelled FROM THE HUMAN", async () => {
    const r = repo();
    await toSpecMerge(r, [plan({ tasks: [], needs: ["Approve writing tasks.json?"] }), plan()]);
    mergeSpec(r);
    expect(await resumeRun({ ...r.opts({ gate: ["r", "return the tasks in the output"] }) }), text(r)).toBe(3);
    expect(r.run().next).toBe("gate:plan-approve");
    expect(r.logged().length).toBe(5);
    expect(r.logged()[4]?.prompt).toContain(
      "FROM THE HUMAN: you asked: Approve writing tasks.json?; the answer: return the tasks in the output"
    );
    expect(r.run().gates.at(-1)).toMatchObject({
      gate: "gate:limit",
      decision: "retry",
      comment: "return the tasks in the output",
      asked: ["Approve writing tasks.json?"],
    });
  });

  it("v04 AC-57: the human's answer survives a fuse stop between the decision retry and the next plan call", async () => {
    const r = repo({ run: { fuse: { calls: 4 } } });
    await toSpecMerge(r, [plan({ tasks: [], needs: ["Which file?"] }), plan()]);
    mergeSpec(r);
    expect(await resumeRun({ ...r.opts({ gate: ["r", "use hello.txt", "f 6"] }) }), text(r)).toBe(3);
    expect(r.run().next).toBe("gate:plan-approve");
    expect(r.logged().length).toBe(5);
    expect(r.logged()[4]?.prompt).toContain("FROM THE HUMAN: you asked: Which file?; the answer: use hello.txt");
  });

  it("v04 AC-57: a spec role with no SPEC.md that asks for a decision stops at gate:limit (decision)", async () => {
    const r = repo();
    r.script([scout(), clarify(), spec({ writes: {}, needs: ["Which greeting language?"] })]);
    expect(await startRun({ ...r.opts({ gate: ["", "", ""] }), mode: "task", description: TASK_DESC })).toBe(3);
    expect(r.run()).toMatchObject({ next: "gate:limit", returnTo: "spec", limitReason: "decision" });
    expect(text(r)).toContain("Which greeting language?");
    expect(r.logged().length).toBe(3);
  });

  it("v04 AC-57: r at gate:limit (decision) re-runs the spec role with its question and the answer", async () => {
    const r = repo();
    r.script([scout(), clarify(), spec({ writes: {}, needs: ["Which greeting language?"] }), spec()]);
    expect(await startRun({ ...r.opts({ gate: ["", "", "", "r", "English"] }), mode: "task", description: TASK_DESC }), text(r)).toBe(3);
    expect(r.run().next).toBe("gate:spec-merge");
    expect(r.logged().length).toBe(4);
    expect(r.logged()[3]?.prompt).toContain("FROM THE HUMAN: you asked: Which greeting language?; the answer: English");
  });

  it("v04 AC-57: the human's decision answer does not leak into a plan re-run after a plan-approve reject", async () => {
    const r = repo();
    await toSpecMerge(r, [plan({ tasks: [], needs: ["Which file?"] }), plan(), plan()]);
    mergeSpec(r);
    const gate = ["r", "use hello.txt", "r", "smaller tasks", "c"];
    expect(await resumeRun({ ...r.opts({ gate }) }), text(r)).toBe(0);
    expect(r.logged().length).toBe(6);
    expect(r.logged()[4]?.prompt).toContain("FROM THE HUMAN: you asked: Which file?; the answer: use hello.txt");
    const last = r.logged()[5]?.prompt ?? "";
    expect(last).toContain("smaller tasks");
    expect(last).not.toContain("use hello.txt");
  });

  it("v04 AC-32: a denial is one short line, and the denials of an undone plan call are dropped", async () => {
    const r = repo();
    const long = "x".repeat(500);
    const deny = (path: string) => ({ tool_name: "Write", tool_use_id: "t", tool_input: { file_path: path, content: long } });
    await toPlanApprove(r, [plan({ tasks: [], denials: [deny("/repo/first.json")] }), plan({ denials: [deny("/repo/second.json")] })]);
    const t = text(r);
    expect(t).toContain("permission denied: Write /repo/second.json");
    expect(t).not.toContain("first.json");
    expect(t).not.toContain(long.slice(0, 50));
    for (const d of r.run().humanDecisions) expect(d.length).toBeLessThanOrEqual(120);
  });

  it("v04 AC-35: the calls fuse stops before the spec call at gate:limit; raising it returns to spec", async () => {
    // scout1: the scout and clarify calls come before spec.
    const r = repo({ run: { fuse: { calls: 2 } } });
    r.script([scout(), clarify(), spec()]);
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
    expect(r.logged().length).toBe(4);
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

  describe("v04 AC-63: the start check", () => {
    const START_NOTE = "its verify passed before the task started";

    it("v04 AC-63: a verify that is red before the task adds no note", async () => {
      const r = repo();
      await toPlanApprove(r, [plan(), ...twoTasksDone()]);
      expect(await resumeRun({ ...r.opts({ gate: ["a", "a"] }) }), text(r)).toBe(0);
      for (const t of r.run().tasks) expect(t.notes.join("\n")).not.toContain(START_NOTE);
    });

    it("v04 AC-63: a verify that is green before the task gets a note, shown at gate:accept; the run goes on", async () => {
      const r = repo();
      await toPlanApprove(r, [plan({ tasks: [{ id: "T1", ac: ["AC-1", "AC-2"], verify: "true" }] }), impl({ writes: { "hello.txt": "hi\n" } }), review()]);
      expect(await resumeRun({ ...r.opts({ gate: ["a", "a"] }) }), text(r)).toBe(0);
      expect(r.run().tasks[0]?.notes.join("\n")).toContain(START_NOTE);
      expect(text(r)).toMatch(/note: .*its verify passed before the task started/);
      expect(r.run().status).toBe("finished");
    });

    it("v04 AC-63: only the first attempt is start-checked", async () => {
      const r = repo();
      const verify = "echo run >> .git/verify-runs && test -f hello.txt";
      await toPlanApprove(r, [
        plan({ tasks: [{ id: "T1", ac: ["AC-1", "AC-2"], verify }] }),
        impl({}),
        impl({ model: "opus", writes: { "hello.txt": "hi\n" } }),
        review(),
      ]);
      expect(await resumeRun({ ...r.opts({ gate: ["a", "a"] }) }), text(r)).toBe(0);
      // start check (1) + red check of attempt 1 (2) + its rerun (3, defect 56) + check of attempt 2 (4);
      // one task, so no final check.
      expect(readFileSync(join(r.dir, ".git/verify-runs"), "utf8").trim().split("\n")).toHaveLength(4);
    });

    it("v04 AC-63: a start check that times out exits 1 before the implement call (AC-60)", async () => {
      const r = repo({ run: { checkTimeoutMin: 0.02 } }); // 1.2 s: verify reaches the sleep, holding its lock
      await toPlanApprove(r, [plan({ tasks: [{ id: "T1", ac: ["AC-1", "AC-2"], verify: "sleep 5" }] })]);
      expect(await resumeRun({ ...r.opts({ gate: ["a"] }) })).toBe(1);
      expect(r.run().next).toBe("implement:T1");
      expect(text(r)).toMatch(/timed out after .*checkTimeoutMin/);
      expect(r.logged().length).toBe(4); // scout, clarify, spec, plan: no implement call
      // AC-60: no attempt counted, no base recorded; --dry wrote no log (AC-63).
      expect(r.run().tasks[0]).toMatchObject({ attempts: 0, taskBase: null });
      expect(existsSync(join(r.dir, ".claude/tmp/B1/verify.log"))).toBe(false);
      // The killed verify could not drop its lock; the driver does, or the resume would wait 60 s and fail.
      expect(existsSync(join(r.dir, ".claude/tmp/B1/.verify.lock"))).toBe(false);
    });

    it("v04 AC-63: a verify that guard-bash refuses is not run by the start check", async () => {
      const r = repo();
      // pnpm add asks first, so guard-bash refuses the whole command; it must never run.
      const verify = "touch .git/ran; pnpm add left-pad";
      await toPlanApprove(r, [plan({ tasks: [{ id: "T1", ac: ["AC-1", "AC-2"], verify }] }), impl({}), impl({ model: "opus" })]);
      await resumeRun({ ...r.opts({ gate: ["a"] }) });
      expect(existsSync(join(r.dir, ".git/ran"))).toBe(false);
      expect(r.run().tasks[0]?.notes.join("\n") ?? "").not.toContain(START_NOTE);
    });
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
    expect(text(r).match(/━━ Accept:/g)?.length).toBe(2);
    // AC-21: F1's own checks are every task's verify, so the gate after it runs no final check.
    expect(text(r).match(/Final check:/g)?.length).toBe(1);
    // AC-63: a fix task is not start-checked (every verify is green before it, by design).
    expect(run.tasks.find((t) => t.id === "F1")?.notes.join("\n") ?? "").not.toContain("passed before");
  });
});
