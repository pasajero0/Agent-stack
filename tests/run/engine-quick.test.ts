import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupProjects, git, patchGates, write } from "../hooks/fixture.js";
import { cancelRun, resumeRun, startRun, statusRun } from "../../src/run/engine/index.js";
import { transition } from "../../src/run/engine/transitions.js";
import { listRuns, readLock } from "../../src/run/store.js";
import { runCommand } from "../../src/commands/run.js";
import { DEAD_PID, impl, makeFakeExecutable, repo, review, sh, text } from "./engine-fixture.js";

beforeAll(makeFakeExecutable);
afterEach(() => cleanupProjects());

const BRANCH = "quick/fix-the-readme-line";
const DESC = "Fix the README line";
const lines = (n: number): string => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n") + "\n";

describe("quick mode: the path", () => {
  it("v04 AC-24: creates quick/<slug> from HEAD, runs base-check and Q1, commits once and finishes without a push", async () => {
    const r = repo();
    const head = sh(r.dir, "rev-parse", "HEAD");
    r.script([impl({ writes: { "README.md": "# demo\nfixed\n" } })]);
    const code = await startRun({ ...r.opts({ gate: ["a"] }), mode: "quick", description: DESC });
    expect(code, text(r)).toBe(0);
    const run = r.run();
    expect(run.status).toBe("finished");
    expect(run.branch).toBe(BRANCH);
    expect(run.createdBranches).toEqual([BRANCH]);
    expect(run.baseCommit).toBe(head);
    expect(sh(r.dir, "branch", "--show-current")).toBe(BRANCH);
    expect(sh(r.dir, "rev-list", "--count", `main..${BRANCH}`)).toBe("1");
    expect(sh(r.dir, "log", "-1", "--format=%s")).toBe("fix: fix the README line");
    expect(sh(r.dir, "remote")).toBe("");
    expect(run.tasks[0]?.commit).toBe(sh(r.dir, "rev-parse", "HEAD"));
    expect(readLock(r.dir)).toBeNull();
    const calls = readdirSync(join(r.dir, ".claude/tmp/runs", run.id, "calls"));
    expect(calls).toEqual(["1-implement.json"]);
    expect(r.logged()[0]?.env.AGENT_STACK_RUN).toBe(run.id);
    expect(text(r)).toContain("gate:accept");
  });

  it("v04 AC-25: a diff above quickReviewLines is reviewed before the commit; review notes are kept", async () => {
    const r = repo({ run: { quickReviewLines: 3 } });
    r.script([impl({ writes: { "notes.txt": lines(5) } }), review({ warning: "name the file better" })]);
    const code = await startRun({ ...r.opts({ gate: ["a"] }), mode: "quick", description: DESC });
    expect(code, text(r)).toBe(0);
    const task = r.run().tasks[0];
    expect(task?.notes.join("\n")).toContain("name the file better");
    expect(r.logged().length).toBe(2);
    expect(sh(r.dir, "show", "--stat", "--format=%s", "HEAD")).toContain("notes.txt");
  });

  it("v04 AC-25: a diff within quickReviewLines skips the review", async () => {
    const r = repo({ run: { quickReviewLines: 10 } });
    r.script([impl({ writes: { "notes.txt": lines(5) } })]);
    expect(await startRun({ ...r.opts({ gate: ["a"] }), mode: "quick", description: DESC })).toBe(0);
    expect(r.logged().length).toBe(1);
  });

  it("v04 AC-46: an empty task diff records commit \"empty\", makes no commit and shows it at gate:accept", async () => {
    const r = repo();
    const head = sh(r.dir, "rev-parse", "HEAD");
    r.script([impl({})]);
    expect(await startRun({ ...r.opts({ gate: ["a"] }), mode: "quick", description: DESC })).toBe(0);
    expect(r.run().tasks[0]?.commit).toBe("empty");
    expect(sh(r.dir, "rev-parse", "HEAD")).toBe(head);
    expect(text(r)).toMatch(/Q1.*empty/);
  });
});

describe("quick mode: attempts, review and the fuse", () => {
  it("v04 AC-34: a red check retries on Opus, then stops at gate:limit (attempts); cancel there (AC-31)", async () => {
    const r = repo({ test: "test ! -f bad.txt" });
    r.script([impl({ writes: { "bad.txt": "x\n" } }), impl({ writes: { "bad.txt": "y\n" }, model: "opus" })]);
    const code = await startRun({ ...r.opts({ gate: ["c"] }), mode: "quick", description: DESC });
    expect(code, text(r)).toBe(0);
    const run = r.run();
    expect(run.status).toBe("cancelled");
    expect(run.tasks[0]?.attempts).toBe(2);
    expect(run.tasks[0]?.lastFeedback).toContain("test ! -f bad.txt");
    expect(run.tasks[0]?.lastFeedback).toContain("exited 1");
    expect(run.gates.map((g) => `${g.gate} ${g.decision}`)).toEqual(["gate:limit cancel"]);
    expect(text(r)).toContain("attempts");
    expect(readLock(r.dir)).toBeNull();
    expect(sh(r.dir, "branch", "--list", BRANCH)).toContain(BRANCH);
  });

  it("v04 AC-34: a blocking review returns to implement as a new attempt on Opus", async () => {
    const r = repo({ run: { quickReviewLines: 1 } });
    r.script([
      impl({ writes: { "notes.txt": lines(4) } }),
      review({ quality: "fail" }),
      impl({ model: "opus" }),
      review(),
    ]);
    const code = await startRun({ ...r.opts({ gate: ["a"] }), mode: "quick", description: DESC });
    expect(code, text(r)).toBe(0);
    const task = r.run().tasks[0];
    expect(task?.attempts).toBe(2);
    expect(task?.blockingCount).toBe(1);
    expect(task?.lastFeedback).toContain("quality: fail");
    expect(sh(r.dir, "rev-list", "--count", `main..${BRANCH}`)).toBe("1");
  });

  it("v04 AC-39: a blocking count not lower than at the previous review stops at gate:limit (review loop)", async () => {
    const r = repo({ run: { quickReviewLines: 1 } });
    r.script([
      impl({ writes: { "notes.txt": lines(4) } }),
      review({ verifyProves: false }),
      impl({ model: "opus" }),
      review({ quality: "fail" }),
    ]);
    const code = await startRun({ ...r.opts(), mode: "quick", description: DESC });
    expect(code, text(r)).toBe(3);
    const run = r.run();
    expect(run.status).toBe("waiting");
    expect(run.next).toBe("gate:limit");
    expect(run.limitReason).toBe("review-loop");
    expect(run.returnTo).toBe("implement:Q1");
  });

  it("v04 AC-35: the calls fuse stops at gate:limit before the next call; raising it returns there (AC-31)", async () => {
    const r = repo({ run: { quickReviewLines: 1, fuse: { calls: 1 } } });
    r.script([impl({ writes: { "notes.txt": lines(4) } }), review()]);
    expect(await startRun({ ...r.opts(), mode: "quick", description: DESC })).toBe(3);
    let run = r.run();
    expect(run.next).toBe("gate:limit");
    expect(run.limitReason).toBe("fuse");
    expect(run.returnTo).toBe("review:Q1");
    expect(run.calls).toBe(1);
    expect(r.logged().length).toBe(1);

    const code = await resumeRun({ ...r.opts({ gate: ["f 1", "f 3", "a"] }) });
    expect(code, text(r)).toBe(0);
    run = r.run();
    expect(run.status).toBe("finished");
    expect(run.fuse).toEqual({ calls: 3 });
    expect(run.calls).toBe(2);
    expect(run.tasks[0]?.attempts).toBe(1);
    expect(run.gates.map((g) => `${g.gate} ${g.decision}`)).toEqual(["gate:limit raise", "gate:accept accept"]);
  });

  it("v04 AC-31: BLOCKED goes to gate:limit (blocked) with the report; retry runs on Opus", async () => {
    const r = repo();
    r.script([
      impl({ status: "BLOCKED", report: "the API key is missing", needs: ["which key?"] }),
      impl({ model: "opus", writes: { "README.md": "# demo\nok\n" } }),
    ]);
    expect(await startRun({ ...r.opts(), mode: "quick", description: DESC })).toBe(3);
    let run = r.run();
    expect(run.limitReason).toBe("blocked");
    expect(run.tasks[0]?.lastFeedback).toContain("the API key is missing");
    expect(run.humanDecisions).toEqual(["which key?"]);
    expect(text(r)).toContain("the API key is missing");

    const code = await resumeRun({ ...r.opts({ gate: ["r", "a"] }) });
    expect(code, text(r)).toBe(0);
    run = r.run();
    expect(run.status).toBe("finished");
    expect(run.tasks[0]?.attempts).toBe(2);
    expect(run.humanDecisions).toEqual([]);
  });

  it("v04 AC-38: an implement call stopped at max turns is a failed attempt; its edits stay for the next one", async () => {
    const r = repo();
    const turns = { type: "result", subtype: "error_max_turns", is_error: true, num_turns: 60, total_cost_usd: 0.02 };
    r.script([
      { expectRole: "implement", expectModel: "sonnet", writes: { "README.md": "# demo\nhalf\n" }, stdout: turns },
      impl({ model: "opus" }),
    ]);
    const code = await startRun({ ...r.opts({ gate: ["a"] }), mode: "quick", description: DESC });
    expect(code, text(r)).toBe(0);
    const run = r.run();
    expect(run.tasks[0]?.attempts).toBe(2);
    expect(run.tasks[0]?.lastFeedback).toContain("max turns");
    expect(run.costUsd).toBeCloseTo(0.03);
    expect(sh(r.dir, "show", "HEAD:README.md")).toBe("# demo\nhalf");
  });

  it("v04 AC-42: a commit refused by a git hook returns to implement with the hook's output", async () => {
    const r = repo();
    write(r.dir, ".git/hooks/commit-msg", "#!/bin/sh\nif [ -f .git/refuse-once ]; then rm .git/refuse-once; echo 'hook says no' >&2; exit 1; fi\n");
    chmodSync(join(r.dir, ".git/hooks/commit-msg"), 0o755);
    write(r.dir, ".git/refuse-once", "1");
    r.script([impl({ writes: { "README.md": "# demo\nfixed\n" } }), impl({ model: "opus" })]);
    const code = await startRun({ ...r.opts({ gate: ["a"] }), mode: "quick", description: DESC });
    expect(code, text(r)).toBe(0);
    const task = r.run().tasks[0];
    expect(task?.attempts).toBe(2);
    expect(task?.lastFeedback).toContain("hook says no");
    expect(sh(r.dir, "rev-list", "--count", `main..${BRANCH}`)).toBe("1");
  });

  it("v04 AC-43: implement committing by itself is soft-reset to taskBase and counted as a failed attempt", async () => {
    const r = repo();
    r.script([
      impl({ writes: { "README.md": "# demo\nfixed\n" }, exec: "git add README.md && git commit -q -m sneaky" }),
      impl({ model: "opus" }),
    ]);
    const code = await startRun({ ...r.opts({ gate: ["a"] }), mode: "quick", description: DESC });
    expect(code, text(r)).toBe(0);
    const task = r.run().tasks[0];
    expect(task?.attempts).toBe(2);
    expect(task?.lastFeedback).toContain("commit");
    expect(sh(r.dir, "log", "--format=%s", `main..${BRANCH}`)).toBe("fix: fix the README line");
    expect(readFileSync(join(r.dir, "README.md"), "utf8")).toBe("# demo\nfixed\n");
  });

  it("v04 AC-43: implement switching the branch is returned to the run's branch, edits kept", async () => {
    const r = repo();
    r.script([
      impl({ writes: { "README.md": "# demo\nfixed\n" }, exec: "git checkout -q -b stray" }),
      impl({ model: "opus" }),
    ]);
    const code = await startRun({ ...r.opts({ gate: ["a"] }), mode: "quick", description: DESC });
    expect(code, text(r)).toBe(0);
    expect(r.run().tasks[0]?.lastFeedback).toContain("branch");
    expect(sh(r.dir, "branch", "--show-current")).toBe(BRANCH);
    expect(sh(r.dir, "log", "-1", "--format=%s", BRANCH)).toBe("fix: fix the README line");
  });
});

describe("quick mode: failures that exit 1", () => {
  it("v04 AC-36: an infrastructure failure keeps next, counts no attempt, exits 1; --resume retries the step", async () => {
    const r = repo();
    r.script([{ stdout: "not json", exit: 1 }, impl({ writes: { "README.md": "# demo\nfixed\n" } })]);
    expect(await startRun({ ...r.opts(), mode: "quick", description: DESC })).toBe(1);
    let run = r.run();
    expect(run.status).toBe("running");
    expect(run.next).toBe("implement:Q1");
    expect(run.tasks[0]?.attempts).toBe(1);
    expect(text(r)).toContain("--resume");

    const code = await resumeRun({ ...r.opts({ gate: ["a"] }) });
    expect(code, text(r)).toBe(0);
    run = r.run();
    expect(run.status).toBe("finished");
    expect(run.tasks[0]?.attempts).toBe(1);
  });

  it("v04 AC-37: a schema mismatch is re-run once; a second one keeps next and exits 1", async () => {
    const r = repo();
    const bad = { expectRole: "implement", output: { status: "DONE" } };
    r.script([bad, bad]);
    expect(await startRun({ ...r.opts(), mode: "quick", description: DESC })).toBe(1);
    const run = r.run();
    expect(run.next).toBe("implement:Q1");
    expect(run.calls).toBe(2);
    expect(text(r)).toMatch(/schema/i);
  });

  it("v04 AC-41: a red test at base-check exits 1 naming the command and keeps next", async () => {
    const r = repo({ test: "test -f ok.txt" });
    r.script([]);
    expect(await startRun({ ...r.opts(), mode: "quick", description: DESC })).toBe(1);
    expect(r.run().next).toBe("base-check");
    expect(text(r)).toContain("test -f ok.txt");
    expect(r.logged().length).toBe(0);
  });
});

describe("gates, resume and the lock", () => {
  it("v04 AC-29: without a terminal or gate input the gate is recorded, --resume printed, exit 3; resume answers it", async () => {
    const r = repo();
    r.script([impl({ writes: { "README.md": "# demo\nfixed\n" } })]);
    expect(await startRun({ ...r.opts(), mode: "quick", description: DESC })).toBe(3);
    let run = r.run();
    expect(run.status).toBe("waiting");
    expect(run.next).toBe("gate:accept");
    expect(text(r)).toContain(`agent-stack run --resume ${run.id}`);
    expect(readLock(r.dir)?.id).toBe(run.id);

    expect(await resumeRun({ ...r.opts({ gate: ["a"] }) })).toBe(0);
    run = r.run();
    expect(run.status).toBe("finished");
    expect(readLock(r.dir)).toBeNull();
  });

  it("v04 AC-28: --cancel of a waiting run marks it cancelled, removes the lock and keeps the branch", async () => {
    const r = repo();
    r.script([impl({ writes: { "README.md": "# demo\nfixed\n" } })]);
    expect(await startRun({ ...r.opts(), mode: "quick", description: DESC })).toBe(3);
    const head = sh(r.dir, "rev-parse", "HEAD");
    expect(await cancelRun({ ...r.opts() })).toBe(0);
    expect(r.run().status).toBe("cancelled");
    expect(readLock(r.dir)).toBeNull();
    expect(sh(r.dir, "rev-parse", BRANCH)).toBe(head);
    expect(text(r)).toContain(BRANCH);
  });

  it("v04 AC-28: --cancel removes a lock whose run folder is missing (AC-55)", async () => {
    const r = repo();
    write(r.dir, ".claude/tmp/runs/lock", JSON.stringify({ id: "r-20260101-000000", pid: DEAD_PID }));
    expect(await cancelRun({ ...r.opts() })).toBe(0);
    expect(readLock(r.dir)).toBeNull();
  });

  it("v04 AC-23: --status prints id, mode, status, next, branch, attempts, calls, cost and fuse, changing nothing", async () => {
    const r = repo();
    r.script([impl({ writes: { "README.md": "# demo\nfixed\n" } })]);
    expect(await startRun({ ...r.opts(), mode: "quick", description: DESC })).toBe(3);
    const run = r.run();
    const file = join(r.dir, ".claude/tmp/runs", run.id, "run.json");
    const before = readFileSync(file, "utf8");
    r.out.length = 0;
    expect(await statusRun({ ...r.opts() })).toBe(0);
    const t = text(r);
    for (const want of [run.id, "quick", "waiting", "gate:accept", BRANCH, "Q1", "attempts 1", "calls 1", "$0.01", "calls 40"]) {
      expect(t).toContain(want);
    }
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("v04 AC-1: a new run while a lock exists removes its own folder and names the locked run (AC-50)", async () => {
    const r = repo();
    r.script([impl({ writes: { "README.md": "# demo\nfixed\n" } })]);
    expect(await startRun({ ...r.opts(), mode: "quick", description: DESC })).toBe(3);
    const first = r.run().id;
    r.out.length = 0;
    expect(await startRun({ ...r.opts(), mode: "quick", description: "another fix" })).toBe(1);
    expect(listRuns(r.dir)).toEqual([first]);
    const t = text(r);
    for (const want of [first, `--resume ${first}`, `--status ${first}`, `--cancel ${first}`]) expect(t).toContain(want);
    expect(sh(r.dir, "branch", "--list", "quick/another-fix")).toBe("");
  });

  it("v04 AC-50: a live run refuses --resume and --cancel (stop it first)", async () => {
    const r = repo();
    r.script([{ stdout: "not json", exit: 1 }]);
    expect(await startRun({ ...r.opts({ pid: process.pid }), mode: "quick", description: DESC })).toBe(1);
    r.out.length = 0;
    expect(await resumeRun({ ...r.opts() })).toBe(1);
    expect(text(r)).toMatch(/live/);
    r.out.length = 0;
    expect(await cancelRun({ ...r.opts() })).toBe(1);
    expect(text(r)).toContain("stop it first (Ctrl-C)");
    expect(r.run().status).toBe("running");
  });

  it("v04 AC-51: an abort stops the Claude child, writes the run file and exits 1; resume continues it (AC-30)", async () => {
    const r = repo();
    r.script([
      { ...impl({ writes: { "late.txt": "x\n" } }), sleepMs: 5000 },
      impl({ writes: { "README.md": "# demo\nfixed\n" } }),
    ]);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 800);
    const started = Date.now();
    expect(await startRun({ ...r.opts({ signal: ac.signal }), mode: "quick", description: DESC })).toBe(1);
    expect(Date.now() - started).toBeLessThan(4000);
    let run = r.run();
    expect(run.status).toBe("running");
    expect(run.next).toBe("implement:Q1");
    expect(existsSync(join(r.dir, "late.txt"))).toBe(false);

    const code = await resumeRun({ ...r.opts({ gate: ["a"] }) });
    expect(code, text(r)).toBe(0);
    run = r.run();
    expect(run.tasks[0]?.attempts).toBe(1);
    expect(run.tasks[0]?.lastFeedback).toContain("git status");
  });

  it("v04 AC-52: --resume on a branch other than the run's refuses and names the branch", async () => {
    const r = repo();
    r.script([impl({ writes: { "README.md": "# demo\nfixed\n" } })]);
    expect(await startRun({ ...r.opts(), mode: "quick", description: DESC })).toBe(3);
    git(r.dir, "checkout", "-q", "main");
    r.out.length = 0;
    expect(await resumeRun({ ...r.opts({ gate: ["a"] }) })).toBe(1);
    expect(text(r)).toContain(BRANCH);
    expect(r.run().status).toBe("waiting");
  });

  it("v04 AC-53: a missing, absent or finished run is reported; --resume and --cancel exit 1, --status exits 0", async () => {
    const r = repo();
    expect(await resumeRun({ ...r.opts() })).toBe(1);
    expect(await cancelRun({ ...r.opts() })).toBe(1);
    expect(await resumeRun({ ...r.opts(), id: "r-20990101-000000" })).toBe(1);
    expect(text(r)).toContain("r-20990101-000000");
    expect(await statusRun({ ...r.opts() })).toBe(0);

    r.script([impl({})]);
    expect(await startRun({ ...r.opts({ gate: ["a"] }), mode: "quick", description: DESC })).toBe(0);
    const id = r.run().id;
    r.out.length = 0;
    expect(await resumeRun({ ...r.opts(), id })).toBe(1);
    expect(await cancelRun({ ...r.opts(), id })).toBe(1);
    expect(text(r)).toContain("finished");
    r.out.length = 0;
    expect(await statusRun({ ...r.opts(), id })).toBe(0);
    expect(text(r)).toContain(id);
  });
});

describe("refusals", () => {
  it("v04 AC-54: an empty description, a detached HEAD, an existing quick branch and a custom task stagePattern are refused", async () => {
    const r = repo();
    expect(await startRun({ ...r.opts(), mode: "quick", description: "   " })).toBe(1);
    expect(text(r)).toMatch(/description/i);

    git(r.dir, "branch", BRANCH);
    r.out.length = 0;
    expect(await startRun({ ...r.opts(), mode: "quick", description: DESC })).toBe(1);
    expect(text(r)).toContain(BRANCH);

    git(r.dir, "checkout", "-q", "--detach");
    r.out.length = 0;
    expect(await startRun({ ...r.opts(), mode: "quick", description: "other" })).toBe(1);
    expect(text(r)).toMatch(/detached/i);
    git(r.dir, "checkout", "-q", "main");

    patchGates(r.dir, { stagePattern: "^(x[0-9]+)" });
    git(r.dir, "commit", "-q", "-am", "chore: custom pattern");
    r.out.length = 0;
    expect(await startRun({ ...r.opts(), mode: "task", description: "a feature" })).toBe(1);
    expect(text(r)).toContain("stagePattern");
    expect(listRuns(r.dir)).toEqual([]);
  });

  it("v04 AC-54: the CLI refuses an unknown mode and a missing description with code 1", async () => {
    const r = repo();
    const out: string[] = [];
    expect(await runCommand("bogus", "x", {}, { projectDir: r.dir, out: (l) => out.push(l) })).toBe(1);
    expect(out.join("\n")).toContain("bogus");
    expect(await runCommand("quick", undefined, {}, { projectDir: r.dir, out: (l) => out.push(l) })).toBe(1);
    expect(await runCommand(undefined, undefined, { status: true }, { projectDir: r.dir, out: (l) => out.push(l) })).toBe(0);
  });

  it("v04 AC-49: a dirty tree is refused at the start and the changes are listed", async () => {
    const r = repo();
    write(r.dir, "stray.txt", "x");
    expect(await startRun({ ...r.opts(), mode: "quick", description: DESC })).toBe(1);
    expect(text(r)).toContain("stray.txt");
    expect(listRuns(r.dir)).toEqual([]);
  });
});

describe("transitions", () => {
  it("v04 AC-1: the next step comes from the table; an unknown (next, event) pair throws", () => {
    expect(transition("base-check", { type: "green", task: "Q1" }, null)).toEqual({ next: "implement:Q1", status: "running" });
    expect(transition("checks:Q1", { type: "review" }, null)).toEqual({ next: "review:Q1", status: "running" });
    expect(transition("commit:Q1", { type: "committed-last" }, null)).toEqual({ next: "gate:accept", status: "running" });
    expect(transition("gate:limit", { type: "resume" }, "review:Q1")).toEqual({ next: "review:Q1", status: "running" });
    expect(transition("gate:accept", { type: "accept" }, null)).toEqual({ next: "gate:accept", status: "finished" });
    expect(() => transition("base-check", { type: "accept" }, null)).toThrow(/base-check/);
    expect(() => transition("implement:Q1", { type: "review" }, null)).toThrow();
  });
});
