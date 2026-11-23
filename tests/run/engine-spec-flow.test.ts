/**
 * Spec flow (0.4.6): `gates.json → specFlow` picks how a human approves a spec — `merge` (the default, a merged
 * spec branch) or `branch` (spec, plan and code in the current branch, approved at gate:spec-approve).
 * Spec: docs/specs/v04/SPEC.md, "Spec flow", AC-83 to AC-90.
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupProjects, git, write } from "../hooks/fixture.js";
import { resumeRun, startRun, statusRun } from "../../src/run/engine/index.js";
import { SPEC_FLOWS } from "../../src/run/spec-flow.js";
import { impl, makeFakeExecutable, repo, review, sh, text, type Repo } from "./engine-fixture.js";
import { clarify, plan, prompter, spec, SPEC_PATH, specMd, STAGE, TASK_DESC, twoTasksDone } from "./engine-task-fixture.js";

beforeAll(makeFakeExecutable);
afterEach(() => cleanupProjects());

const WORK = "release/1.0";
const BRANCH = { extra: { specFlow: "branch" } };

/** A repo in spec flow `branch`, on its own work branch. */
function branchRepo(): Repo {
  const r = repo(BRANCH);
  git(r.dir, "switch", "-q", "-c", WORK);
  return r;
}

/** Starts a task run in flow `branch` up to gate:spec-approve (exit 3). */
async function toSpecApprove(r: Repo, extra: unknown[] = []): Promise<void> {
  r.script([clarify(), spec(), ...(extra as never[])]);
  const code = await startRun({ ...r.opts({ gate: ["", "", ""] }), mode: "task", description: TASK_DESC });
  expect(code, text(r)).toBe(3);
}

/** The spec with AC-2 reworded and (by default) a `## Changes` entry, committed on the current branch. */
function changeSpec(r: Repo, withEntry = true): void {
  const body = specMd().replace("SHALL say bye too.", "SHALL say bye too, in one line.");
  write(r.dir, SPEC_PATH, withEntry ? `${body}\n## Changes\n\n- 2026-11-23 — AC-2: bye in one line.\n` : body);
  git(r.dir, "add", SPEC_PATH);
  git(r.dir, "commit", "-q", "-m", "docs(b1): spec — read twice");
}

describe("spec flow: the setting (AC-83, AC-84)", () => {
  it("v04 AC-83: the allowed names are merge and branch, and a missing key is merge", async () => {
    expect([...SPEC_FLOWS]).toEqual(["merge", "branch"]);
    const r = repo();
    r.script([clarify()]);
    expect(await startRun({ ...r.opts(), mode: "task", description: TASK_DESC })).toBe(3);
    expect(r.run().specFlow).toBe("merge");
  });

  it("v04 AC-83: the run file and --status --json carry the flow", async () => {
    const r = branchRepo();
    r.script([clarify()]);
    expect(await startRun({ ...r.opts(), mode: "task", description: TASK_DESC })).toBe(3);
    expect(r.run().specFlow).toBe("branch");
    r.out.length = 0;
    expect(await statusRun({ ...r.opts(), json: true })).toBe(0);
    const status = JSON.parse(text(r)) as { run: { specFlow: string } };
    expect(status.run.specFlow).toBe("branch");
  });

  it("v04 AC-83: an unknown flow refuses run task and run quick with the allowed names", async () => {
    for (const mode of ["task", "quick"] as const) {
      const r = repo({ extra: { specFlow: "brnach" } });
      expect(await startRun({ ...r.opts(), mode, description: TASK_DESC })).toBe(1);
      const t = text(r);
      expect(t).toContain("specFlow");
      expect(t).toContain("merge");
      expect(t).toContain("branch");
      expect(existsSync(join(r.dir, ".claude/tmp/runs/lock"))).toBe(false);
    }
  });

  it("v04 AC-84: --resume with another flow than the run started with changes nothing and exits 1", async () => {
    const r = branchRepo();
    await toSpecApprove(r);
    const gates = join(r.dir, ".claude/gates.json");
    const cfg = JSON.parse(readFileSync(gates, "utf8")) as Record<string, unknown>;
    writeFileSync(gates, JSON.stringify({ ...cfg, specFlow: "merge" }));
    r.out.length = 0;
    expect(await resumeRun({ ...r.opts({ gate: ["a"] }) })).toBe(1);
    const t = text(r);
    expect(t).toContain("branch");
    expect(t).toContain("--cancel");
    expect(r.run().next).toBe("gate:spec-approve");
  });

  it("v04 AC-84: a run file without specFlow reads as merge", async () => {
    const r = repo();
    r.script([clarify()]);
    expect(await startRun({ ...r.opts(), mode: "task", description: TASK_DESC })).toBe(3);
    const file = join(r.dir, ".claude/tmp/runs", r.run().id, "run.json");
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    delete raw["specFlow"];
    delete raw["specApproved"];
    writeFileSync(file, JSON.stringify(raw));
    expect(r.run().specFlow).toBe("merge");
    expect(r.run().specApproved).toBeNull();
  });
});

describe("spec flow branch: the run stays on the branch (AC-85, AC-86, AC-90)", () => {
  it("v04 AC-85: run task commits the spec on the current branch and creates no branch", async () => {
    const r = branchRepo();
    await toSpecApprove(r);
    const run = r.run();
    expect(run.branch).toBe(WORK);
    expect(run.createdBranches).toEqual([]);
    expect(sh(r.dir, "branch", "--show-current")).toBe(WORK);
    expect(sh(r.dir, "log", "-1", "--format=%s")).toBe("docs(b1): spec — Add a greeting");
    expect(sh(r.dir, "branch", "--list", "spec/*")).toBe("");
    expect(run.next).toBe("gate:spec-approve");
  });

  it("v04 AC-85: a stage id whose spec folder exists on HEAD is refused, though main has none", async () => {
    const r = branchRepo();
    write(r.dir, `docs/specs/${STAGE}/SPEC.md`, specMd());
    git(r.dir, "add", "docs");
    git(r.dir, "commit", "-q", "-m", "docs(b1): spec — old");
    r.script([clarify()]);
    expect(await startRun({ ...r.opts(), mode: "task", description: TASK_DESC })).toBe(3);
    expect(text(r)).toContain(`docs/specs/${STAGE}/ already exists on HEAD`);
  });

  it("v04 AC-86: flow branch refuses run task and run quick on the base branch", async () => {
    for (const mode of ["task", "quick"] as const) {
      const r = repo(BRANCH);
      expect(await startRun({ ...r.opts(), mode, description: TASK_DESC })).toBe(1);
      expect(text(r)).toContain("git switch -c");
      expect(existsSync(join(r.dir, ".claude/tmp/runs/lock"))).toBe(false);
    }
  });

  it("v04 AC-90: run quick in flow branch works and commits on the current branch", async () => {
    const r = branchRepo();
    r.script([impl({ writes: { "hello.txt": "hello\n" }, subject: "Add the hello file" })]);
    expect(await startRun({ ...r.opts({ gate: ["a"] }), mode: "quick", description: "add a hello file" }), text(r)).toBe(0);
    const run = r.run();
    expect(run.branch).toBe(WORK);
    expect(run.createdBranches).toEqual([]);
    expect(sh(r.dir, "branch", "--show-current")).toBe(WORK);
    expect(sh(r.dir, "log", "-1", "--format=%s")).toBe("fix(quick): add the hello file");
    expect(sh(r.dir, "branch", "--list", "quick/*")).toBe("");
  });
});

describe("spec flow branch: gate:spec-approve (AC-87)", () => {
  it("v04 AC-87: the card names the spec, its criteria and the answers a, r, c", async () => {
    const r = branchRepo();
    await toSpecApprove(r);
    const card = r.run().card;
    expect(card?.gate).toBe("spec-approve");
    expect(card?.title).toBe(`Spec ${STAGE}: approve`);
    expect(card?.facts.join("\n")).toContain(SPEC_PATH);
    expect(card?.facts.join("\n")).toContain("AC-1");
    expect(card?.facts.join("\n")).toContain("AC-2");
    expect(card?.prompts[0]?.answers.map((a) => a.key)).toEqual(["a", "r", "c"]);
    expect(card?.source).toBe(sh(r.dir, "rev-parse", `HEAD:${SPEC_PATH}`));
  });

  it("v04 AC-87: a records the approved spec and HEAD, then plans on the same branch", async () => {
    const r = branchRepo();
    await toSpecApprove(r, [plan()]);
    const head = sh(r.dir, "rev-parse", "HEAD");
    const blob = sh(r.dir, "rev-parse", `HEAD:${SPEC_PATH}`);
    expect(await resumeRun({ ...r.opts({ gate: ["a"] }) }), text(r)).toBe(3);
    const run = r.run();
    expect(run.specApproved).toBe(blob);
    expect(run.baseCommit).toBe(head);
    expect(run.branch).toBe(WORK);
    expect(run.next).toBe("gate:plan-approve");
    expect(sh(r.dir, "branch", "--show-current")).toBe(WORK);
  });

  it("v04 AC-87: r with a comment runs the spec role again with it and commits on the same branch", async () => {
    const r = branchRepo();
    const again = spec({ writes: { [SPEC_PATH]: `${specMd()}\nOne more line.\n` } });
    await toSpecApprove(r, [again]);
    expect(await resumeRun({ ...r.opts({ gate: ["r say who greets"] }) }), text(r)).toBe(3);
    const run = r.run();
    expect(run.next).toBe("gate:spec-approve");
    expect(sh(r.dir, "log", "--format=%s", `main..${WORK}`)).toBe("docs(b1): spec — Add a greeting\ndocs(b1): spec — Add a greeting");
    expect(r.logged().at(-1)?.prompt ?? "").toContain("FROM THE HUMAN: say who greets");
  });

  it("v04 AC-87: when the spec role changes nothing after r, nothing is committed and the card says so", async () => {
    const r = branchRepo();
    await toSpecApprove(r, [spec()]);
    const head = sh(r.dir, "rev-parse", "HEAD");
    expect(await resumeRun({ ...r.opts({ gate: ["r say who greets"] }) }), text(r)).toBe(3);
    expect(sh(r.dir, "rev-parse", "HEAD")).toBe(head);
    expect(r.run().next).toBe("gate:spec-approve");
    expect(r.run().card?.facts.join("\n")).toContain("the spec role changed nothing");
  });
});

describe("spec flow branch: a spec changed after its approval (AC-88)", () => {
  it("v04 AC-88: a spec change while gate:plan-approve waits comes back to gate:spec-approve, and a returns to the plan", async () => {
    const r = branchRepo();
    await toSpecApprove(r, [plan()]);
    expect(await resumeRun({ ...r.opts({ gate: ["a"] }) }), text(r)).toBe(3);
    changeSpec(r);
    r.out.length = 0;
    expect(await resumeRun({ ...r.opts() }), text(r)).toBe(3);
    let run = r.run();
    expect(run.next).toBe("gate:spec-approve");
    expect(run.returnTo).toBe("gate:plan-approve");
    expect(run.card?.facts.join("\n")).toContain("AC-2: bye in one line");
    expect(run.card?.prompts[0]?.answers.map((a) => a.key)).toEqual(["a", "c"]);
    expect(await resumeRun({ ...r.opts({ gate: ["a"] }) }), text(r)).toBe(3);
    run = r.run();
    expect(run.next).toBe("gate:plan-approve");
    expect(run.returnTo).toBeNull();
    expect(run.specApproved).toBe(sh(r.dir, "rev-parse", `HEAD:${SPEC_PATH}`));
  });

  it("v04 AC-88: a spec changed while implement is interrupted stops before the next attempt", async () => {
    const r = branchRepo();
    // No implement response is scripted: the call fails and the run stays at implement:T1 (exit 1).
    await toSpecApprove(r, [plan()]);
    expect(await resumeRun({ ...r.opts({ gate: ["a"] }) }), text(r)).toBe(3);
    expect(await resumeRun({ ...r.opts({ gate: ["a"] }) })).toBe(1);
    expect(r.run().next).toBe("implement:T1");
    changeSpec(r);
    r.out.length = 0;
    expect(await resumeRun({ ...r.opts() }), text(r)).toBe(3);
    expect(r.run().next).toBe("gate:spec-approve");
    expect(r.run().returnTo).toBe("implement:T1");
  });

  it("v04 AC-88: a spec change with no new ## Changes entry exits 1 and keeps the gate", async () => {
    const r = branchRepo();
    await toSpecApprove(r, [plan()]);
    expect(await resumeRun({ ...r.opts({ gate: ["a"] }) }), text(r)).toBe(3);
    changeSpec(r, false);
    r.out.length = 0;
    expect(await resumeRun({ ...r.opts() })).toBe(1);
    expect(text(r)).toContain("## Changes");
    expect(r.run().next).toBe("gate:plan-approve");
  });

  it("v04 AC-88: an uncommitted spec edit before an implement attempt exits 1 and asks for a commit with a ## Changes entry", async () => {
    const r = branchRepo();
    // No implement response: the call fails and the run stays at implement:T1, a step that needs no clean tree.
    await toSpecApprove(r, [plan()]);
    expect(await resumeRun({ ...r.opts({ gate: ["a"] }) }), text(r)).toBe(3);
    expect(await resumeRun({ ...r.opts({ gate: ["a"] }) })).toBe(1);
    write(r.dir, SPEC_PATH, `${specMd()}\nedit\n`);
    r.out.length = 0;
    expect(await resumeRun({ ...r.opts() })).toBe(1);
    const t = text(r);
    expect(t).toContain("uncommitted changes");
    expect(t).toContain("## Changes");
    expect(r.run().next).toBe("implement:T1");
  });

  it("v04 AC-88: a spec change while gate:accept waits comes back to gate:spec-approve, and a returns to gate:accept", async () => {
    const r = branchRepo();
    await toSpecApprove(r, [plan(), ...twoTasksDone()]);
    // A live driver (this process): verify finds the stage through the run (AC-89).
    expect(await resumeRun({ ...r.opts({ gate: ["a", "a"], pid: process.pid }) }), text(r)).toBe(3);
    expect(r.run().next).toBe("gate:accept");
    changeSpec(r);
    r.out.length = 0;
    // --answer a, meant for gate:accept (AC-70): the gate finds the changed spec and uses no answer.
    expect(await resumeRun({ ...r.opts({ pid: process.pid }), answers: ["a"] }), text(r)).toBe(3);
    let run = r.run();
    expect(run.next).toBe("gate:spec-approve");
    expect(run.returnTo).toBe("gate:accept");
    // AC-70: the answer meant for gate:accept was not used, and the chat is told.
    expect(text(r)).toContain('Not used: "a"');
    expect(await resumeRun({ ...r.opts({ gate: ["a"], pid: process.pid }) }), text(r)).toBe(3);
    run = r.run();
    expect(run.next).toBe("gate:accept");
    expect(run.status).toBe("waiting");
  });

  it("v04 AC-84: a specFlow edit while the run is open stops it before the next step", async () => {
    const r = branchRepo();
    await toSpecApprove(r, [plan()]);
    const gates = join(r.dir, ".claude/gates.json");
    const cfg = JSON.parse(readFileSync(gates, "utf8")) as Record<string, unknown>;
    // The human approves the spec, then edits gates.json while gate:plan-approve waits, then approves the plan.
    const p = prompter(["a", "a"], (i) => {
      if (i === 1) writeFileSync(gates, JSON.stringify({ ...cfg, specFlow: "merge" }));
    });
    expect(await resumeRun({ ...r.opts(), prompter: p })).toBe(1);
    expect(text(r)).toContain('started with specFlow "branch"');
    expect(r.run().next).toBe("base-check");
  });

  it("v04 AC-87: after r, an edit of the glossary alone is undone and nothing is committed", async () => {
    const r = branchRepo();
    await toSpecApprove(r, [spec({ writes: { "docs/GLOSSARY.md": "# Glossary\n\n- **Greeting** — a word.\n" } })]);
    const head = sh(r.dir, "rev-parse", "HEAD");
    expect(await resumeRun({ ...r.opts({ gate: ["r say who greets"] }) }), text(r)).toBe(3);
    expect(sh(r.dir, "rev-parse", "HEAD")).toBe(head);
    expect(existsSync(join(r.dir, "docs/GLOSSARY.md"))).toBe(false);
    expect(r.run().card?.facts.join("\n")).toContain("the spec role changed nothing");
  });
});

describe("spec flow branch: the whole path", () => {
  it("v04 AC-85: spec, plan and both tasks end on the one branch, and the run finishes", async () => {
    const r = branchRepo();
    await toSpecApprove(r, [plan(), ...twoTasksDone()]);
    // A live driver (this process): verify finds the stage through the run, as the branch name has none (AC-89).
    expect(await resumeRun({ ...r.opts({ gate: ["a", "a", "a"], pid: process.pid }) }), text(r)).toBe(0);
    expect(r.run().status).toBe("finished");
    expect(sh(r.dir, "log", "--format=%s", `main..${WORK}`)).toBe(
      "fix(b1): add the bye file\nfix(b1): add the hello file\ndocs(b1): spec — Add a greeting"
    );
    expect(sh(r.dir, "branch", "--format=%(refname:short)")).toBe(`main\n${WORK}`);
  });
});
