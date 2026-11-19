import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupProjects, git, write } from "../hooks/fixture.js";
import { resumeRun, startRun } from "../../src/run/engine/index.js";
import { transition } from "../../src/run/engine/transitions.js";
import { readLock } from "../../src/run/store.js";
import { impl, makeFakeExecutable, repo, review, sh, text } from "./engine-fixture.js";
import {
  clarify,
  mergeSpec,
  plan,
  spec,
  SPEC_BRANCH,
  SPEC_PATH,
  specMd,
  STAGE,
  TASK_DESC,
  TASKS_PATH,
  toSpecMerge,
  twoTasksDone,
  WORK_BRANCH,
} from "./engine-task-fixture.js";

beforeAll(makeFakeExecutable);
afterEach(() => cleanupProjects());

describe("task mode: clarify, answers and the spec", () => {
  it("v04 AC-5: run task starts with clarify on Opus and creates no branch before the answers", async () => {
    const r = repo();
    r.script([clarify()]);
    const code = await startRun({ ...r.opts(), mode: "task", description: TASK_DESC });
    expect(code, text(r)).toBe(3);
    const run = r.run();
    expect(run.next).toBe("gate:answers");
    expect(run.createdBranches).toEqual([]);
    expect(sh(r.dir, "branch", "--show-current")).toBe("main");
    const argv = r.logged()[0]?.argv ?? [];
    expect(argv[argv.indexOf("--model") + 1]).toBe("opus");
  });

  it("v04 AC-6: clarify output is stored as proposal and gate:answers shows the questions, size and stage", async () => {
    const r = repo();
    r.script([clarify()]);
    expect(await startRun({ ...r.opts(), mode: "task", description: TASK_DESC })).toBe(3);
    const run = r.run();
    expect(run.proposal).toMatchObject({ size: "task", stage: { id: STAGE } });
    const t = text(r);
    for (const want of ["Which file?", "hello.txt", "task", STAGE]) expect(t).toContain(want);
  });

  it("v04 AC-6: each question's prompt says that Enter takes the recommended answer", async () => {
    const r = repo();
    r.script([clarify()]);
    const asked: string[] = [];
    const p = { ask: async (q: string) => (asked.push(q), null), close: () => {} };
    expect(await startRun({ ...r.opts(), prompter: p, mode: "task", description: TASK_DESC })).toBe(3);
    expect(asked[0]).toBe("answer 1 (Enter = recommended, or type your own)> ");
  });

  describe("v04 AC-59: the spec's terms are checked after the spec role", () => {
    const withTerms = (terms: string): string => specMd().replace("## Acceptance criteria", `## Terms\n\n${terms}\n## Acceptance criteria`);
    /** A repo whose base commit has docs/GLOSSARY.md with one headword, Greeting. */
    function glossaryRepo(): ReturnType<typeof repo> {
      const r = repo();
      write(r.dir, "docs/GLOSSARY.md", "# Glossary\n\n- **Greeting** — what the file says.\n");
      sh(r.dir, "add", "-A");
      sh(r.dir, "commit", "-q", "-m", "docs: glossary");
      return r;
    }
    const start = (r: ReturnType<typeof repo>) => startRun({ ...r.opts({ gate: ["", "", ""] }), mode: "task", description: TASK_DESC });

    it("v04 AC-59: an unlisted term undoes the spec and re-runs the role with trace's output", async () => {
      const r = glossaryRepo();
      r.script([
        clarify(),
        spec({ writes: { [SPEC_PATH]: withTerms("- **Greeting** — shared.\n- **Wave** — new word.\n") } }),
        spec({ writes: { [SPEC_PATH]: withTerms("- **Greeting** — shared.\n- **Wave** (local): this spec only.\n") } }),
      ]);
      expect(await start(r), text(r)).toBe(3);
      expect(r.run().next).toBe("gate:spec-merge");
      expect(r.logged().length).toBe(3);
      expect(r.logged()[2]?.prompt).toMatch(/FROM THE PROGRAM[\s\S]*terms not in docs\/GLOSSARY\.md: Wave/);
      expect(sh(r.dir, "show", `${SPEC_BRANCH}:${SPEC_PATH}`)).toContain("**Wave** (local)");
    });

    it("v04 AC-8: a glossary edit by the spec role is in bounds and committed with the spec", async () => {
      const r = glossaryRepo();
      const glossary = "# Glossary\n\n- **Greeting** — what the file says.\n- **Wave** — a farewell.\n";
      r.script([clarify(), spec({ writes: { [SPEC_PATH]: withTerms("- **Wave** — shared now.\n"), "docs/GLOSSARY.md": glossary } })]);
      expect(await start(r), text(r)).toBe(3);
      expect(r.logged().length).toBe(2);
      expect(sh(r.dir, "show", "--stat", "--format=", SPEC_BRANCH)).toContain("docs/GLOSSARY.md");
    });

    it("v04 AC-59: unlisted terms twice exit 1 at spec", async () => {
      const r = glossaryRepo();
      const bad = spec({ writes: { [SPEC_PATH]: withTerms("- **Wave** — new word.\n") } });
      r.script([clarify(), bad, bad]);
      expect(await start(r)).toBe(1);
      expect(r.run().next).toBe("spec");
      expect(text(r)).toContain("Wave");
    });
  });

  it("v04 AC-8: the confirmed answers create spec/<stage> from the base ref and the spec is committed as docs(<stage>): spec — <title>", async () => {
    const r = repo();
    const main = sh(r.dir, "rev-parse", "main");
    r.script([clarify(), spec()]);
    const code = await startRun({ ...r.opts({ gate: ["README.md please", "story", ""] }), mode: "task", description: TASK_DESC });
    expect(code, text(r)).toBe(3);
    const run = r.run();
    expect(run.answers).toEqual([{ question: "Which file?", answer: "README.md please" }]);
    expect(run.size).toBe("story");
    expect(run.stage).toBe(STAGE);
    expect(run.createdBranches).toEqual([SPEC_BRANCH]);
    expect(sh(r.dir, "rev-parse", `${SPEC_BRANCH}~1`)).toBe(main);
    expect(sh(r.dir, "log", "-1", "--format=%s", SPEC_BRANCH)).toBe("docs(b1): spec — Add a greeting");
    expect(sh(r.dir, "show", "--name-only", "--format=", SPEC_BRANCH)).toBe(SPEC_PATH);
    expect(r.run().gates.map((g) => `${g.gate} ${g.decision}`)).toEqual(["gate:answers confirm"]);
  });

  it("v04 AC-10: after the spec commit the run waits at gate:spec-merge with exit 3 and names the branch to merge", async () => {
    const r = repo();
    await toSpecMerge(r);
    const run = r.run();
    expect(run.next).toBe("gate:spec-merge");
    expect(run.status).toBe("waiting");
    expect(text(r)).toContain(SPEC_BRANCH);
    expect(readLock(r.dir)?.id).toBe(run.id);
  });

  it("v04 AC-10: with no remote, the spec-merge gate prints the local merge commands and no push", async () => {
    const r = repo();
    await toSpecMerge(r);
    const t = text(r);
    expect(t).toContain(`git checkout main && git merge ${SPEC_BRANCH}`);
    expect(t).not.toMatch(/push|pull request|git fetch/i);
  });

  it("v04 AC-10: with origin/<base>, the spec-merge gate says push, merge the pull request, then git fetch", async () => {
    const r = repo();
    sh(r.dir, "update-ref", "refs/remotes/origin/main", "HEAD");
    await toSpecMerge(r);
    const t = text(r);
    for (const want of [`push -u origin ${SPEC_BRANCH}`, "pull request", "git fetch"]) expect(t).toContain(want);
    expect(t).not.toContain("git merge");
  });

  it("v04 AC-9: an epic writes split.md, prints one run command per part and finishes without a branch or code", async () => {
    const r = repo();
    const split = [
      { id: "B2", goal: "Add the parser" },
      { id: "B3", goal: 'Add the "printer"' },
      { id: "B4", goal: "Say it's $HOME\nand `done`" },
    ];
    r.script([clarify({ size: "epic", split })]);
    const code = await startRun({ ...r.opts({ gate: ["", ""] }), mode: "task", description: TASK_DESC });
    expect(code, text(r)).toBe(0);
    const run = r.run();
    expect(run.status).toBe("finished");
    expect(run.size).toBe("epic");
    const md = readFileSync(join(r.dir, ".claude/tmp/runs", run.id, "split.md"), "utf8");
    expect(md).toContain("B2");
    expect(md).toContain("Add the parser");
    expect(text(r)).toContain("agent-stack run task --stage B2 'Add the parser'");
    expect(text(r)).toContain(`agent-stack run task --stage B3 'Add the "printer"'`);
    expect(text(r)).toContain("agent-stack run task --stage B4 'Say it'\\''s $HOME and `done`'");
    expect(r.logged().length).toBe(1);
    expect(sh(r.dir, "branch", "--list")).toBe("* main");
    expect(readLock(r.dir)).toBeNull();
  });

  it("v04 AC-48: an invalid stage id is explained and asked again at the same gate (AC-7: pattern, spec dir, spec branch)", async () => {
    const r = repo();
    write(r.dir, "docs/specs/B1/SPEC.md", specMd());
    git(r.dir, "add", "-A");
    git(r.dir, "commit", "-q", "-m", "docs: old spec");
    git(r.dir, "branch", "spec/B2");
    r.script([clarify(), spec({ stage: "B3" })]);
    const code = await startRun({ ...r.opts({ gate: ["", "", "", "greeting", "B2", "B3"] }), mode: "task", description: TASK_DESC });
    expect(code, text(r)).toBe(3);
    const t = text(r);
    expect(t).toContain("docs/specs/B1");
    expect(t).toMatch(/greeting.*pattern|pattern.*greeting/);
    expect(t).toContain("spec/B2");
    const run = r.run();
    expect(run.stage).toBe("B3");
    expect(run.next).toBe("gate:spec-merge");
    expect(run.gates.filter((g) => g.gate === "gate:answers").length).toBe(1);
  });

  it("v04 AC-7: --stage pre-fills the stage id, and it is still validated", async () => {
    const r = repo();
    git(r.dir, "branch", "spec/C7");
    r.script([clarify(), spec({ stage: "C8" })]);
    const code = await startRun({ ...r.opts({ gate: ["", "", "", "C8"] }), mode: "task", description: TASK_DESC, stage: "C7" });
    expect(code, text(r)).toBe(3);
    expect(text(r)).toContain("[C7]");
    expect(text(r)).toContain("spec/C7");
    expect(r.run().stage).toBe("C8");
    expect(r.run().stagePrefill).toBe("C7");
  });

  it("v04 AC-7: --stage is kept apart from the confirmed stage, so an epic run leaves stage null", async () => {
    const r = repo();
    r.script([clarify({ size: "epic", split: [{ id: "B2", goal: "Add the parser" }] })]);
    expect(await startRun({ ...r.opts({ gate: ["", ""] }), mode: "task", description: TASK_DESC, stage: "C7" })).toBe(0);
    const run = r.run();
    expect(run.size).toBe("epic");
    expect(run.stage).toBeNull();
    expect(run.stagePrefill).toBe("C7");
  });

  it("v04 AC-9: a split part whose id fails the stage-id characters gets no command, only a note in split.md", async () => {
    const r = repo();
    const split = [
      { id: "B2", goal: "Add the parser" },
      { id: "B3; touch pwned", goal: "Add the printer" },
      { id: ".B4", goal: "Add the docs" },
    ];
    r.script([clarify({ size: "epic", split })]);
    expect(await startRun({ ...r.opts({ gate: ["", ""] }), mode: "task", description: TASK_DESC })).toBe(0);
    const t = text(r);
    expect(t).toContain("agent-stack run task --stage B2 'Add the parser'");
    expect(t).not.toContain("--stage B3");
    expect(t).not.toContain("--stage .B4");
    const md = readFileSync(join(r.dir, ".claude/tmp/runs", r.run().id, "split.md"), "utf8");
    expect(md).toContain("--stage B2");
    expect(md).not.toContain("--stage B3");
    expect(md).toMatch(/B3; touch pwned.*(dropped|not a valid)/);
    expect(md).toMatch(/\.B4.*(dropped|not a valid)/);
  });

  it("v04 AC-28: c at gate:answers cancels the run before any branch exists", async () => {
    const r = repo();
    r.script([clarify()]);
    expect(await startRun({ ...r.opts({ gate: ["c"] }), mode: "task", description: TASK_DESC })).toBe(0);
    expect(r.run().status).toBe("cancelled");
    expect(sh(r.dir, "branch", "--list")).toBe("* main");
  });

  it("v04 AC-40: a spec role that writes outside its bounds is undone and re-run once with that feedback", async () => {
    const r = repo();
    r.script([clarify(), spec({ writes: { [SPEC_PATH]: specMd(), "src/code.ts": "x\n" } }), spec()]);
    const code = await startRun({ ...r.opts({ gate: ["", "", ""] }), mode: "task", description: TASK_DESC });
    expect(code, text(r)).toBe(3);
    expect(existsSync(join(r.dir, "src/code.ts"))).toBe(false);
    expect(sh(r.dir, "show", "--name-only", "--format=", SPEC_BRANCH)).toBe(SPEC_PATH);
    expect(r.logged().length).toBe(3);
    expect(r.logged()[2]?.prompt).toMatch(/FROM THE PROGRAM[\s\S]*src\/code\.ts/);
  });

  it("v04 AC-8: specsDir and adrDir written with a trailing / (or a leading ./) still bound the spec role", async () => {
    const r = repo({ extra: { specsDir: "docs/specs/", adrDir: "./docs/adr/" } });
    r.script([clarify(), spec({ writes: { [SPEC_PATH]: specMd(), "docs/adr/0001-greeting.md": "# ADR\n" } })]);
    const code = await startRun({ ...r.opts({ gate: ["", "", ""] }), mode: "task", description: TASK_DESC });
    expect(code, text(r)).toBe(3);
    expect(r.run().next).toBe("gate:spec-merge");
    expect(sh(r.dir, "show", "--name-only", "--format=", SPEC_BRANCH)).toBe(`docs/adr/0001-greeting.md\n${SPEC_PATH}`);
    expect(r.logged().length).toBe(2);
  });

  it("v04 AC-40: a spec role that commits is reset and re-run; a second violation exits 1 with next kept", async () => {
    const r = repo();
    const commits = "git add docs && git commit -q -m sneaky";
    r.script([clarify(), { ...spec(), exec: commits }, { ...spec(), exec: commits }]);
    const code = await startRun({ ...r.opts({ gate: ["", "", ""] }), mode: "task", description: TASK_DESC });
    expect(code, text(r)).toBe(1);
    const run = r.run();
    expect(run.next).toBe("spec");
    expect(sh(r.dir, "rev-parse", SPEC_BRANCH)).toBe(sh(r.dir, "rev-parse", "main"));
    expect(text(r)).toMatch(/commit/);
  });

  it("v04 AC-44: a spec role that leaves no SPEC.md is re-run once, then the run exits 1 at spec", async () => {
    const r = repo();
    r.script([clarify(), spec({ writes: { "docs/specs/B1/notes.md": "x\n" } }), spec({ writes: {} })]);
    const code = await startRun({ ...r.opts({ gate: ["", "", ""] }), mode: "task", description: TASK_DESC });
    expect(code, text(r)).toBe(1);
    expect(r.run().next).toBe("spec");
    expect(text(r)).toContain(SPEC_PATH);
    expect(r.logged().length).toBe(3);
  });

  it("v04 AC-49: a dirty tree right before spec/<stage> is created is refused with the changes listed", async () => {
    const r = repo();
    r.script([clarify(), spec()]);
    expect(await startRun({ ...r.opts(), mode: "task", description: TASK_DESC })).toBe(3);
    write(r.dir, "stray.txt", "x");
    expect(await resumeRun({ ...r.opts({ gate: ["", "", ""] }) })).toBe(1);
    expect(text(r)).toContain("stray.txt");
    expect(r.run().next).toBe("spec");
    expect(sh(r.dir, "branch", "--list", SPEC_BRANCH)).toBe("");
  });
});

describe("task mode: gate:spec-merge", () => {
  it("v04 AC-47: --resume with the spec not on the base ref stays at gate:spec-merge and exits 3 with the same steps", async () => {
    const r = repo();
    await toSpecMerge(r);
    r.out.length = 0;
    expect(await resumeRun({ ...r.opts() })).toBe(3);
    const run = r.run();
    expect(run.next).toBe("gate:spec-merge");
    const t = text(r);
    for (const want of [`git checkout main && git merge ${SPEC_BRANCH}`, SPEC_PATH]) expect(t).toContain(want);
  });

  it("v04 AC-11: --resume with the spec merged creates <stage>-<slug> from the base ref, sets branch and baseCommit, and runs plan", async () => {
    const r = repo();
    await toSpecMerge(r, [plan()]);
    mergeSpec(r);
    const main = sh(r.dir, "rev-parse", "main");
    expect(await resumeRun({ ...r.opts() })).toBe(3);
    const run = r.run();
    expect(run.branch).toBe(WORK_BRANCH);
    expect(run.baseCommit).toBe(main);
    expect(run.createdBranches).toEqual([SPEC_BRANCH, WORK_BRANCH]);
    expect(sh(r.dir, "branch", "--show-current")).toBe(WORK_BRANCH);
    expect(run.next).toBe("gate:plan-approve");
    expect(existsSync(join(r.dir, TASKS_PATH))).toBe(true);
  });

  it("v04 AC-54: an existing <stage>-<slug> branch this run did not create is refused at gate:spec-merge", async () => {
    const r = repo();
    await toSpecMerge(r, [plan()]);
    mergeSpec(r);
    git(r.dir, "branch", WORK_BRANCH);
    expect(await resumeRun({ ...r.opts() })).toBe(1);
    expect(text(r)).toContain(WORK_BRANCH);
    expect(r.run().next).toBe("gate:spec-merge");
  });
});

describe("task mode: the whole path", () => {
  it("v04 AC-21: the happy path ends at gate:accept with the diff stat, checks, notes and cost, then finishes without a push", async () => {
    const r = repo();
    await toSpecMerge(r, [plan(), ...twoTasksDone()]);
    mergeSpec(r);
    const code = await resumeRun({ ...r.opts({ gate: ["a", "a"] }) });
    expect(code, text(r)).toBe(0);
    const run = r.run();
    expect(run.status).toBe("finished");
    expect(run.tasks.map((t) => t.id)).toEqual(["T1", "T2"]);
    expect(sh(r.dir, "log", "--format=%s", `main..${WORK_BRANCH}`)).toBe("fix(b1): add the bye file\nfix(b1): add the hello file");
    const t = text(r);
    expect(t).toContain("gate:accept");
    expect(t).toContain("hello.txt");
    expect(t).toContain(".claude/bin/verify T1 → 0");
    expect(t).toContain("$0.0");
    const tasks: unknown = JSON.parse(readFileSync(join(r.dir, TASKS_PATH), "utf8"));
    expect(tasks).toMatchObject({ tasks: [{ id: "T1", passes: true }, { id: "T2", passes: true }] });
    expect(readLock(r.dir)).toBeNull();
  });

  it("v04 AC-21: with two plan tasks, gate:accept shows a final check of every task's verify", async () => {
    const r = repo();
    await toSpecMerge(r, [plan(), ...twoTasksDone()]);
    mergeSpec(r);
    expect(await resumeRun({ ...r.opts({ gate: ["a", "a"] }) }), text(r)).toBe(0);
    expect(text(r)).toContain("Final check: .claude/bin/verify (every task) → 0");
  });

  it("v04 AC-61: a later task that breaks an earlier one's verify shows a red final check; a still accepts", async () => {
    const r = repo();
    // T2 makes bye.txt (its own verify passes) and deletes hello.txt, which T1's verify needs.
    const breaker = impl({ writes: { "bye.txt": "bye\n" }, exec: "rm hello.txt", subject: "Add the bye file" });
    await toSpecMerge(r, [plan(), impl({ writes: { "hello.txt": "hello\n" }, subject: "Add the hello file" }), review(), breaker, review()]);
    mergeSpec(r);
    expect(await resumeRun({ ...r.opts({ gate: ["a", "a"] }) }), text(r)).toBe(0);
    const t = text(r);
    expect(t).toMatch(/Final check: \.claude\/bin\/verify \(every task\) → [1-9]\d* RED/);
    expect(t).toContain("r with a comment adds a fix task; a accepts a red result");
    expect(r.run().status).toBe("finished");
  });

  it("v04 AC-20: each task's checks are its verify plus lint, then review, then the commit; the next task follows", async () => {
    const r = repo({ lint: "true {file}", extra: { lintMatch: ["*.txt"] } });
    await toSpecMerge(r, [plan(), ...twoTasksDone()]);
    mergeSpec(r);
    expect(await resumeRun({ ...r.opts({ gate: ["a", "a"] }) })).toBe(0);
    const [t1, t2] = r.run().tasks;
    expect(t1?.checks).toEqual([
      { cmd: ".claude/bin/verify T1", exit: 0, skipped: false },
      { cmd: "true './hello.txt'", exit: 0, skipped: false },
    ]);
    expect(t2?.checks.map((c) => c.cmd)).toEqual([".claude/bin/verify T2", "true './bye.txt'"]);
    expect(r.logged().length).toBe(7);
    expect(t1?.commit).toBe(sh(r.dir, "rev-parse", `${WORK_BRANCH}~1`));
  });

  it("v04 AC-1: the task-mode rows of the transition table", () => {
    expect(transition("clarify", { type: "clarified" }, null).next).toBe("gate:answers");
    expect(transition("gate:answers", { type: "answered" }, null).next).toBe("spec");
    expect(transition("gate:answers", { type: "epic" }, null).status).toBe("finished");
    expect(transition("spec", { type: "spec-done" }, null).next).toBe("gate:spec-merge");
    expect(transition("gate:spec-merge", { type: "merged" }, null).next).toBe("plan");
    expect(transition("plan", { type: "planned" }, null).next).toBe("gate:plan-approve");
    expect(transition("gate:plan-approve", { type: "approve" }, null).next).toBe("base-check");
    expect(transition("gate:plan-approve", { type: "reject" }, null).next).toBe("plan");
    expect(transition("spec", { type: "fuse" }, null).next).toBe("gate:limit");
  });
});
