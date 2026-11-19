import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { cleanupProjects, git, write } from "../hooks/fixture.js";
import { resumeRun, startRun } from "../../src/run/engine/index.js";
import { makeFakeExecutable, repo, sh, text, type Repo } from "./engine-fixture.js";
import {
  clarify,
  mergeSpec,
  patchRun,
  plan,
  prompter,
  spec,
  SPEC_BRANCH,
  STAGE,
  TASK_DESC,
  TASKS_PATH,
  tasksJson,
  toPlanApprove,
  toSpecMerge,
  TWO_TASKS,
  WORK_BRANCH,
} from "./engine-task-fixture.js";

beforeAll(makeFakeExecutable);
afterEach(() => cleanupProjects());

const HUMAN = "src/foo.ts";
const humanEdit = (r: Repo): void => write(r.dir, HUMAN, "human work\n");
const kept = (r: Repo): string => readFileSync(join(r.dir, HUMAN), "utf8");

/** A run stopped by the calls fuse right before the plan call (clarify and spec used the 2 calls). */
async function toFuseBeforePlan(r: Repo): Promise<void> {
  await toSpecMerge(r, [plan(), plan()]);
  mergeSpec(r);
  expect(await resumeRun({ ...r.opts() }), text(r)).toBe(3);
  expect(r.run()).toMatchObject({ next: "gate:limit", returnTo: "plan", limitReason: "fuse" });
  r.out.length = 0;
}

describe("task mode: AC-49, the human's changes before the spec and plan roles", () => {
  it("v04 AC-49: after a fuse stop before plan, a human edit is refused when the fuse is raised, and kept", async () => {
    const r = repo({ run: { fuse: { calls: 2 } } });
    await toFuseBeforePlan(r);
    humanEdit(r);
    expect(await resumeRun({ ...r.opts({ gate: ["f 5"] }) })).toBe(1);
    expect(text(r)).toContain(HUMAN);
    expect(kept(r)).toBe("human work\n");
    expect(r.run().next).toBe("plan");
    expect(r.logged().length).toBe(2);
  });

  it("v04 AC-49: a human edit while gate:plan-approve waits for the reject comment is refused before plan re-runs, and kept", async () => {
    const r = repo();
    await toPlanApprove(r, [plan(), plan()]);
    const p = prompter(["r", "smaller tasks"], (i) => (i === 1 ? humanEdit(r) : undefined));
    expect(await resumeRun({ ...r.opts(), prompter: p })).toBe(1);
    expect(text(r)).toContain(HUMAN);
    expect(kept(r)).toBe("human work\n");
    expect(r.run().next).toBe("plan");
    expect(r.logged().length).toBe(3);
  });

  it("v04 AC-49: a resume at spec with a change outside the spec's bounds is refused, and the change is kept", async () => {
    const r = repo();
    r.script([clarify(), spec({ writes: {} }), spec({ writes: {} }), spec()]);
    expect(await startRun({ ...r.opts({ gate: ["", "", ""] }), mode: "task", description: TASK_DESC })).toBe(1);
    expect(r.run().next).toBe("spec");
    humanEdit(r);
    r.out.length = 0;
    expect(await resumeRun({ ...r.opts() })).toBe(1);
    expect(text(r)).toContain(HUMAN);
    expect(kept(r)).toBe("human work\n");
    expect(r.logged().length).toBe(3);
  });

  it("v04 AC-49: a resume at plan with a change outside .claude/tmp/ is refused, and the change is kept", async () => {
    const r = repo();
    await toSpecMerge(r, [plan({ tasks: [] }), plan({ tasks: [] }), plan()]);
    mergeSpec(r);
    expect(await resumeRun({ ...r.opts() })).toBe(1);
    expect(r.run().next).toBe("plan");
    humanEdit(r);
    r.out.length = 0;
    expect(await resumeRun({ ...r.opts() })).toBe(1);
    expect(text(r)).toContain(HUMAN);
    expect(kept(r)).toBe("human work\n");
    expect(r.logged().length).toBe(4);
  });
});

describe("task mode: a leftover tasks.json at plan", () => {
  it("v04 AC-49: a leftover valid tasks.json with a change outside .claude/tmp/ is refused, not taken as the plan", async () => {
    const r = repo({ run: { fuse: { calls: 2 } } });
    await toFuseBeforePlan(r);
    write(r.dir, TASKS_PATH, tasksJson(TWO_TASKS));
    humanEdit(r);
    expect(await resumeRun({ ...r.opts({ gate: ["f 5"] }) })).toBe(1);
    expect(text(r)).toContain(HUMAN);
    expect(kept(r)).toBe("human work\n");
    expect(r.run().next).toBe("plan");
  });

  it("v04 AC-32: a leftover valid tasks.json is shown with the needsHumanDecision of the newest plan call", async () => {
    const r = repo({ run: { fuse: { calls: 2 } } });
    await toFuseBeforePlan(r);
    // A kill after the plan call: its tasks.json and its call record are there, the run file is not updated.
    write(r.dir, TASKS_PATH, tasksJson(TWO_TASKS));
    const call = (needs: string[]) =>
      JSON.stringify({ argv: [], exitCode: 0, result: { structured_output: { summary: "s", tasks: [], needsHumanDecision: needs } } });
    const calls = join(".claude/tmp/runs", r.run().id, "calls");
    write(r.dir, join(calls, "1-plan.json"), call(["an older decision"]));
    write(r.dir, join(calls, "3-plan.json"), call(["the leftover's decision"]));
    expect(await resumeRun({ ...r.opts({ gate: ["f 5"] }) })).toBe(3);
    expect(r.run().next).toBe("gate:plan-approve");
    expect(text(r)).toContain("the leftover's decision");
    expect(text(r)).not.toContain("an older decision");
    expect(r.logged().length).toBe(2);
  });

  it("v04 AC-14: a kill after the reject is written but before tasks.json is deleted re-runs plan with the comment", async () => {
    const r = repo();
    const one = tasksJson([{ id: "T1", ac: ["AC-1", "AC-2"] }]);
    await toPlanApprove(r, [plan(), plan({ tasks: [{ id: "T1", ac: ["AC-1", "AC-2"] }] })]);
    const past = new Date(Date.now() - 60_000);
    utimesSync(join(r.dir, TASKS_PATH), past, past);
    const reject = { gate: "gate:plan-approve", at: new Date().toISOString(), decision: "reject", comment: "one task only" };
    patchRun(r, { next: "plan", status: "running", gates: [...r.run().gates, reject] });
    r.out.length = 0;
    expect(await resumeRun({ ...r.opts() })).toBe(3);
    expect(r.run().next).toBe("gate:plan-approve");
    expect(r.logged().length).toBe(4);
    expect(r.logged()[3]?.prompt).toContain("one task only");
    expect(JSON.parse(readFileSync(join(r.dir, TASKS_PATH), "utf8"))).toEqual(JSON.parse(one));
  });
});

describe("task mode: AC-55, a resume after a git side effect", () => {
  it("v04 AC-55: a spec/<stage> in createdBranches that exists is checked out on resume, not refused or created again", async () => {
    const r = repo();
    r.script([clarify(), spec()]);
    expect(await startRun({ ...r.opts(), mode: "task", description: TASK_DESC })).toBe(3);
    git(r.dir, "branch", SPEC_BRANCH);
    patchRun(r, { next: "spec", stage: STAGE, size: "task", createdBranches: [SPEC_BRANCH] });
    expect(await resumeRun({ ...r.opts() }), text(r)).toBe(3);
    const run = r.run();
    expect(run.next).toBe("gate:spec-merge");
    expect(run.createdBranches).toEqual([SPEC_BRANCH]);
    expect(sh(r.dir, "branch", "--show-current")).toBe(SPEC_BRANCH);
    expect(sh(r.dir, "rev-parse", `${SPEC_BRANCH}~1`)).toBe(sh(r.dir, "rev-parse", "main"));
  });

  it("v04 AC-55: a <stage>-<slug> in createdBranches that exists is checked out at gate:spec-merge, keeping its commits", async () => {
    const r = repo();
    await toSpecMerge(r, [plan()]);
    mergeSpec(r);
    git(r.dir, "checkout", "-q", "-b", WORK_BRANCH);
    git(r.dir, "commit", "-q", "--allow-empty", "-m", "chore: marker");
    const tip = sh(r.dir, "rev-parse", "HEAD");
    git(r.dir, "checkout", "-q", "main");
    patchRun(r, { createdBranches: [SPEC_BRANCH, WORK_BRANCH] });
    expect(await resumeRun({ ...r.opts() }), text(r)).toBe(3);
    const run = r.run();
    expect(run.next).toBe("gate:plan-approve");
    expect(run.createdBranches).toEqual([SPEC_BRANCH, WORK_BRANCH]);
    expect(sh(r.dir, "branch", "--show-current")).toBe(WORK_BRANCH);
    expect(sh(r.dir, "rev-parse", WORK_BRANCH)).toBe(tip);
  });

  it("v04 AC-55: a HEAD that already has the spec header is not committed again and no spec call is made", async () => {
    const r = repo();
    await toSpecMerge(r);
    patchRun(r, { next: "spec", status: "running" });
    r.out.length = 0;
    expect(await resumeRun({ ...r.opts() }), text(r)).toBe(3);
    expect(r.run().next).toBe("gate:spec-merge");
    expect(sh(r.dir, "rev-list", "--count", `main..${SPEC_BRANCH}`)).toBe("1");
    expect(r.logged().length).toBe(2);
  });
});

describe("task mode: AC-15, base-check on a clean tree", () => {
  it("v04 AC-15: a change made while gate:plan-approve waits is refused at base-check with the change listed, and kept", async () => {
    const r = repo();
    await toPlanApprove(r, [plan()]);
    const p = prompter(["a"], () => humanEdit(r));
    r.out.length = 0;
    expect(await resumeRun({ ...r.opts(), prompter: p })).toBe(1);
    expect(text(r)).toContain(HUMAN);
    expect(kept(r)).toBe("human work\n");
    expect(r.run().next).toBe("base-check");
    expect(r.logged().length).toBe(3);
    expect(existsSync(join(r.dir, "hello.txt"))).toBe(false);
  });
});

describe("task mode: re-review fixes at plan (branch, leftover decisions, rejected-plan hash)", () => {
  const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

  it("v04 AC-52: a branch switch while gate:plan-approve waits for a reject is refused before plan; both branches are untouched", async () => {
    const r = repo();
    await toPlanApprove(r, [plan(), plan()]);
    const other = "human/other";
    let otherTip = "";
    const runTip = sh(r.dir, "rev-parse", WORK_BRANCH);
    const p = prompter(["r smaller tasks"], (i) => {
      if (i !== 0) return;
      git(r.dir, "checkout", "-q", "-b", other, "main");
      write(r.dir, "other.txt", "human\n");
      git(r.dir, "add", "other.txt");
      git(r.dir, "commit", "-q", "-m", "chore: human work");
      otherTip = sh(r.dir, "rev-parse", "HEAD");
    });
    r.out.length = 0;
    expect(await resumeRun({ ...r.opts(), prompter: p })).toBe(1);
    expect(text(r)).toContain(WORK_BRANCH);
    expect(sh(r.dir, "rev-parse", WORK_BRANCH)).toBe(runTip);
    expect(sh(r.dir, "rev-parse", other)).toBe(otherTip);
    expect(sh(r.dir, "branch", "--show-current")).toBe(other);
    expect(sh(r.dir, "status", "--porcelain", "--", ".", ":!.claude/tmp")).toBe("");
    expect(readFileSync(join(r.dir, "other.txt"), "utf8")).toBe("human\n");
    expect(r.logged().length).toBe(3);
    expect(r.run().next).toBe("plan");
    expect(r.run().gates.at(-1)?.planSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("v04 AC-32: a leftover tasks.json after a reject is not shown with the rejected plan call's needsHumanDecision", async () => {
    const r = repo();
    await toPlanApprove(r, [plan({ needs: ["an old decision"] })]);
    const reject = { gate: "gate:plan-approve", at: new Date(Date.now() - 60_000).toISOString(), decision: "reject", comment: "one task" };
    patchRun(r, { next: "plan", status: "running", humanDecisions: [], gates: [...r.run().gates, reject] });
    const calls = join(r.dir, ".claude/tmp/runs", r.run().id, "calls");
    const past = new Date(Date.now() - 120_000);
    utimesSync(join(calls, "3-plan.json"), past, past);
    write(r.dir, TASKS_PATH, tasksJson([{ id: "T1", ac: ["AC-1", "AC-2"] }]));
    r.out.length = 0;
    expect(await resumeRun({ ...r.opts() })).toBe(3);
    expect(r.run().next).toBe("gate:plan-approve");
    expect(text(r)).not.toContain("an old decision");
    expect(r.logged().length).toBe(3);
  });

  it("v04 AC-14: the rejected plan is recognised by its sha256 even when its mtime is newer than the reject", async () => {
    const r = repo();
    const one = tasksJson([{ id: "T1", ac: ["AC-1", "AC-2"] }]);
    await toPlanApprove(r, [plan(), plan({ tasks: [{ id: "T1", ac: ["AC-1", "AC-2"] }] })]);
    const rejected = readFileSync(join(r.dir, TASKS_PATH), "utf8");
    const at = new Date(Date.now() - 60_000).toISOString();
    const reject = { gate: "gate:plan-approve", at, decision: "reject", comment: "one task only", planSha256: sha256(rejected) };
    patchRun(r, { next: "plan", status: "running", gates: [...r.run().gates, reject] });
    r.out.length = 0;
    expect(await resumeRun({ ...r.opts() })).toBe(3);
    expect(r.logged().length).toBe(4);
    expect(r.logged()[3]?.prompt).toContain("one task only");
    expect(JSON.parse(readFileSync(join(r.dir, TASKS_PATH), "utf8"))).toEqual(JSON.parse(one));
  });

  it("v04 AC-14: a leftover whose sha256 differs from the rejected plan's is kept even when its mtime is older than the reject", async () => {
    const r = repo();
    await toPlanApprove(r, [plan()]);
    const one = tasksJson([{ id: "T1", ac: ["AC-1", "AC-2"] }]);
    write(r.dir, TASKS_PATH, one);
    const past = new Date(Date.now() - 60_000);
    utimesSync(join(r.dir, TASKS_PATH), past, past);
    const reject = { gate: "gate:plan-approve", at: new Date().toISOString(), decision: "reject", comment: "c", planSha256: "0".repeat(64) };
    patchRun(r, { next: "plan", status: "running", humanDecisions: [], gates: [...r.run().gates, reject] });
    expect(await resumeRun({ ...r.opts() })).toBe(3);
    expect(r.run().next).toBe("gate:plan-approve");
    expect(r.logged().length).toBe(3);
    expect(readFileSync(join(r.dir, TASKS_PATH), "utf8")).toBe(one);
  });
});
