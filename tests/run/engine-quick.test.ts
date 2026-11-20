import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { chmodSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { cleanupProjects, git, patchGates, write } from "../hooks/fixture.js";
import { resumeRun, startRun } from "../../src/run/engine/index.js";
import { transition } from "../../src/run/engine/transitions.js";
import { listRuns, readLock } from "../../src/run/store.js";
import { runCommand } from "../../src/commands/run.js";
import { loadRunConfig } from "../../src/run/config.js";
import type { Ctx, ModeSteps } from "../../src/run/engine/context.js";
import { runLoop } from "../../src/run/engine/loop.js";
import { quickMode } from "../../src/run/engine/steps-quick.js";
import { selectPrompter } from "../../src/run/gate.js";
import { humanFeedback } from "../../src/run/engine/gates.js";
import { BRANCH, DESC, impl, lines, makeFakeExecutable, repo, review, sh, text } from "./engine-fixture.js";

beforeAll(makeFakeExecutable);
afterEach(() => cleanupProjects());

describe("quick mode: the path", () => {
  it("v04 AC-24: creates quick/<slug> from HEAD, runs base-check and Q1, commits once and finishes without a push", async () => {
    const r = repo();
    const head = sh(r.dir, "rev-parse", "HEAD");
    const origin = join(r.dir, ".git", "origin.git");
    git(r.dir, "init", "-q", "--bare", origin);
    git(r.dir, "remote", "add", "origin", origin);
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
    expect(sh(origin, "for-each-ref")).toBe("");
    expect(run.tasks[0]?.commit).toBe(sh(r.dir, "rev-parse", "HEAD"));
    expect(readLock(r.dir)).toBeNull();
    const calls = readdirSync(join(r.dir, ".claude/tmp/runs", run.id, "calls"));
    expect(calls).toEqual(["1-implement.json"]);
    expect(r.logged()[0]?.env.AGENT_STACK_RUN).toBe(run.id);
    expect(text(r)).toContain("━━ Accept:");
    expect(text(r)).toMatch(/-> implement:Q1 · implement · sonnet · call 1\/40 \.\.\./);
    expect(text(r)).toMatch(/ {3}ok in \d+s/);
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

  it("v04 AC-67: the review call gets the project's code-reviewer rules; without the agent the run exits 1 at review", async () => {
    const r = repo({ run: { quickReviewLines: 3 } });
    r.script([impl({ writes: { "notes.txt": lines(5) } }), review()]);
    expect(await startRun({ ...r.opts({ gate: ["a"] }), mode: "quick", description: DESC })).toBe(0);
    expect(r.logged()[1]?.prompt).toContain("You are a code reviewer. For each file:");
    expect(r.logged()[0]?.prompt).toContain("You implement one task.");

    const r2 = repo({ run: { quickReviewLines: 3 } });
    rmSync(join(r2.dir, ".claude/agents/code-reviewer.md"));
    git(r2.dir, "commit", "-q", "-am", "chore: no reviewer");
    r2.script([impl({ writes: { "notes.txt": lines(5) } })]);
    expect(await startRun({ ...r2.opts(), mode: "quick", description: DESC })).toBe(1);
    expect(r2.run().next).toBe("review:Q1");
    expect(text(r2)).toMatch(/agent not found: .*code-reviewer\.md \(run agent-stack update\)/);
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
  it("v04 AC-20: an empty diff still goes through review when the mode asks, then records commit \"empty\" (AC-46)", async () => {
    const r = repo();
    r.script([{ stdout: "not json", exit: 1 }, impl({}), review()]);
    expect(await startRun({ ...r.opts(), mode: "quick", description: DESC })).toBe(1);
    const seen: number[] = [];
    const mode: ModeSteps = { ...quickMode, needsReview: (_ctx, _task, diffLines) => (seen.push(diffLines), true) };
    const env = r.opts({ gate: ["a"] }).env ?? {};
    const prompter = selectPrompter(env, false);
    const signal = new AbortController().signal;
    const ctx: Ctx = { projectDir: r.dir, cfg: loadRunConfig(r.dir), run: r.run(), mode, prompter, answering: false, out: (l) => r.out.push(l), env, signal };
    const code = await runLoop(ctx).finally(() => prompter.close());
    expect(code, text(r)).toBe(0);
    expect(seen).toEqual([0]);
    expect(r.logged().length).toBe(3);
    expect(r.run().tasks[0]?.commit).toBe("empty");
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

  it("v04 AC-64: TEST_CONFLICT goes to gate:limit (test-conflict); r with an answer retries on the same model, no attempt counted", async () => {
    const r = repo();
    const conflict = { test: "tests/readme.test.ts:has the line", criterion: "the README says fixed", reason: "the test wants broken" };
    r.script([
      impl({ status: "TEST_CONFLICT", conflict, writes: { "README.md": "# demo\nhalf\n" } }),
      impl({ writes: { "README.md": "# demo\nfixed\n" } }),
    ]);
    expect(await startRun({ ...r.opts(), mode: "quick", description: DESC })).toBe(3);
    let run = r.run();
    expect(run.limitReason).toBe("test-conflict");
    expect(run.next).toBe("gate:limit");
    expect(run.tasks[0]?.attempts).toBe(1);
    const out = text(r);
    expect(out).toContain("reason: test-conflict");
    expect(out).toContain("tests/readme.test.ts:has the line");
    expect(out).toContain("the test wants broken");
    expect(out).toMatch(/r <text> — retry with your answer for the implementer/);
    // The attempt's edits are kept for the retry.
    expect(readFileSync(join(r.dir, "README.md"), "utf8")).toBe("# demo\nhalf\n");

    const code = await resumeRun({ ...r.opts({ gate: ["r the test is right, follow it", "a"] }) });
    expect(code, text(r)).toBe(0);
    run = r.run();
    expect(run.status).toBe("finished");
    expect(run.tasks[0]?.attempts).toBe(1);
    const g = run.gates.find((x) => x.gate === "gate:limit");
    expect(g).toMatchObject({ decision: "retry", comment: "the test is right, follow it", reason: "test-conflict" });
    // The answer is the implementer's: a spec or plan role never reads it as FROM THE HUMAN (AC-57).
    expect(g && humanFeedback({ ...run, gates: [g] })).toBeNull();
    const prompt = r.logged()[1]?.prompt ?? "";
    expect(prompt).toContain("FROM THE HUMAN: the test is right, follow it");
    expect(prompt).toContain("the test wants broken");
  });

  it("v04 AC-64: TEST_CONFLICT without its conflict is a schema mismatch, not a gate", async () => {
    const r = repo();
    r.script([impl({ status: "TEST_CONFLICT" }), impl({ status: "TEST_CONFLICT" })]);
    expect(await startRun({ ...r.opts(), mode: "quick", description: DESC })).toBe(1);
    expect(r.run().limitReason).toBeNull();
    expect(r.run().next).toBe("implement:Q1");
  });

  it("v04 AC-66: a deleted frozen test stops at gate:limit (tests-changed); a allows it, and gate:accept lists it", async () => {
    const r = repo();
    write(r.dir, "tests/readme.test.ts", 'it("a", () => {\n  expect(1).toBe(1);\n});\n');
    git(r.dir, "add", "-A");
    git(r.dir, "commit", "-q", "-m", "test: readme");
    r.script([impl({ writes: { "README.md": "# demo\nfixed\n" }, deletes: ["tests/readme.test.ts"] })]);
    expect(await startRun({ ...r.opts(), mode: "quick", description: DESC })).toBe(3);
    let run = r.run();
    expect(run.limitReason).toBe("tests-changed");
    expect(run.returnTo).toBe("checks:Q1");
    expect(text(r)).toContain("deleted test file tests/readme.test.ts");
    expect(text(r)).toMatch(/a — allow exactly these/);

    const code = await resumeRun({ ...r.opts({ gate: ["a", "a"] }) });
    expect(code, text(r)).toBe(0);
    run = r.run();
    expect(run.status).toBe("finished");
    expect(run.tasks[0]?.attempts).toBe(1);
    expect(run.tasks[0]?.allowedChanges).toEqual(["deleted test file tests/readme.test.ts"]);
    expect(run.gates.map((g) => `${g.gate} ${g.decision}`)).toEqual(["gate:limit allow", "gate:accept accept"]);
    expect(text(r)).toContain("test change allowed: deleted test file tests/readme.test.ts");
  });

  it("v04 AC-66: a allows only the changes listed; one made while the gate waited stops again", async () => {
    const r = repo();
    write(r.dir, "tests/a.test.ts", 'it("a", () => {\n  expect(1).toBe(1);\n});\n');
    write(r.dir, "tests/b.test.ts", 'it("b", () => {\n  expect(1).toBe(1);\n});\n');
    git(r.dir, "add", "-A");
    git(r.dir, "commit", "-q", "-m", "test: two");
    r.script([impl({ writes: { "README.md": "# demo\nfixed\n" }, deletes: ["tests/a.test.ts"] })]);
    expect(await startRun({ ...r.opts(), mode: "quick", description: DESC })).toBe(3);
    expect(r.run().tasks[0]?.pendingChanges).toEqual(["deleted test file tests/a.test.ts"]);
    rmSync(join(r.dir, "tests/b.test.ts"));
    expect(await resumeRun({ ...r.opts({ gate: ["a"] }) })).toBe(3);
    const run = r.run();
    expect(run.tasks[0]?.allowedChanges).toEqual(["deleted test file tests/a.test.ts"]);
    expect(run.limitReason).toBe("tests-changed");
    expect(run.tasks[0]?.pendingChanges).toEqual(["deleted test file tests/b.test.ts"]);
  });

  it("v04 AC-66: r at gate:limit (tests-changed) is a new attempt on Opus with the list and the comment", async () => {
    const r = repo();
    write(r.dir, "tests/readme.test.ts", 'it("a", () => {\n  expect(1).toBe(1);\n  expect(2).toBe(2);\n});\n');
    git(r.dir, "add", "-A");
    git(r.dir, "commit", "-q", "-m", "test: readme");
    r.script([
      impl({ writes: { "README.md": "# demo\nfixed\n", "tests/readme.test.ts": 'it("a", () => {\n  expect(1).toBe(1);\n});\n' } }),
      impl({ model: "opus", writes: { "tests/readme.test.ts": 'it("a", () => {\n  expect(1).toBe(1);\n  expect(2).toBe(2);\n});\n' } }),
    ]);
    expect(await startRun({ ...r.opts(), mode: "quick", description: DESC })).toBe(3);
    expect(text(r)).toContain("tests/readme.test.ts: assertions 2 → 1");
    const code = await resumeRun({ ...r.opts({ gate: ["r keep both assertions", "a"] }) });
    expect(code, text(r)).toBe(0);
    const run = r.run();
    expect(run.tasks[0]?.attempts).toBe(2);
    expect(run.tasks[0]?.allowedChanges).toEqual([]);
    const g = run.gates.find((x) => x.gate === "gate:limit");
    expect(g).toMatchObject({ decision: "retry", comment: "keep both assertions", reason: "tests-changed" });
    expect(g && humanFeedback({ ...run, gates: [g] })).toBeNull();
    const prompt = r.logged()[1]?.prompt ?? "";
    expect(prompt).toContain("tests/readme.test.ts: assertions 2 → 1");
    expect(prompt).toContain("FROM THE HUMAN: keep both assertions");
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
  it("v04 AC-43: implement committing on the run's branch, then switching to main, is soft-reset on the run's branch", async () => {
    const r = repo();
    const main = sh(r.dir, "rev-parse", "main");
    r.script([
      impl({ writes: { "README.md": "# demo\nfixed\n" }, exec: "git add README.md && git commit -q -m sneaky && git checkout -q main" }),
      impl({ model: "opus" }),
    ]);
    const code = await startRun({ ...r.opts({ gate: ["a"] }), mode: "quick", description: DESC });
    expect(code, text(r)).toBe(0);
    const task = r.run().tasks[0];
    expect(task?.attempts).toBe(2);
    expect(task?.lastFeedback).toContain("commit");
    expect(sh(r.dir, "branch", "--show-current")).toBe(BRANCH);
    expect(sh(r.dir, "log", "--format=%s", `main..${BRANCH}`)).toBe("fix: fix the README line");
    expect(sh(r.dir, "rev-parse", "main")).toBe(main);
    expect(readFileSync(join(r.dir, "README.md"), "utf8")).toBe("# demo\nfixed\n");
  });

  it("v04 AC-43: implement committing, then running checkout -b stray, is soft-reset and returned, edits kept", async () => {
    const r = repo();
    r.script([
      impl({ writes: { "README.md": "# demo\nfixed\n" }, exec: "git add README.md && git commit -q -m sneaky && git checkout -q -b stray" }),
      impl({ model: "opus" }),
    ]);
    const code = await startRun({ ...r.opts({ gate: ["a"] }), mode: "quick", description: DESC });
    expect(code, text(r)).toBe(0);
    const task = r.run().tasks[0];
    expect(task?.attempts).toBe(2);
    expect(task?.lastFeedback).toContain("commit");
    expect(task?.lastFeedback).toContain("stray");
    expect(sh(r.dir, "branch", "--show-current")).toBe(BRANCH);
    expect(sh(r.dir, "log", "--format=%s", `main..${BRANCH}`)).toBe("fix: fix the README line");
    expect(readFileSync(join(r.dir, "README.md"), "utf8")).toBe("# demo\nfixed\n");
  });

  it("v04 AC-35: a call ended by error_max_budget_usd goes to gate:limit (fuse); implement continues from git status", async () => {
    const r = repo({ run: { fuse: { usd: 1 } } });
    const budget = { type: "result", subtype: "error_max_budget_usd", is_error: true, num_turns: 9, total_cost_usd: 0.5 };
    r.script([{ expectRole: "implement", expectModel: "sonnet", writes: { "README.md": "# demo\nhalf\n" }, stdout: budget, exit: 1 }]);
    expect(await startRun({ ...r.opts(), mode: "quick", description: DESC })).toBe(3);
    const run = r.run();
    expect(run.limitReason).toBe("fuse");
    expect(run.returnTo).toBe("implement:Q1");
    expect(run.tasks[0]?.attempts).toBe(1);
    expect(run.tasks[0]?.lastFeedback).toContain("continue from `git status`");
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

  it("v04 AC-62: a killed call counts as unknown cost, not $0, and the gate says so", async () => {
    const r = repo({ run: { stepTimeoutMin: 0.005 } }); // 300 ms per call
    r.script([{ ...impl({ writes: { "late.txt": "x\n" } }), sleepMs: 5000 }, impl({ model: "opus", writes: { "notes.txt": "n\n" } })]);
    expect(await startRun({ ...r.opts({ gate: ["a"] }), mode: "quick", description: DESC }), text(r)).toBe(0);
    const run = r.run();
    expect(run.costUnknownCalls).toBe(1);
    expect(run.costUsd).toBeCloseTo(0.01);
    expect(text(r)).toMatch(/over 2 calls, 1 with unknown cost/);
    expect(text(r)).not.toContain("may count too little");
  });

  it("v04 AC-62: with a dollar fuse, unknown-cost calls are flagged as a fuse that may count too little", async () => {
    const r = repo({ run: { stepTimeoutMin: 0.005, fuse: { usd: 5 } } });
    r.script([{ ...impl({ writes: { "late.txt": "x\n" } }), sleepMs: 5000 }, impl({ model: "opus", writes: { "notes.txt": "n\n" } })]);
    expect(await startRun({ ...r.opts({ gate: ["a"] }), mode: "quick", description: DESC }), text(r)).toBe(0);
    expect(text(r)).toContain("the dollar fuse may count too little");
  });

  // The test command hangs while .git/slow exists (outside the task diff); the limit is 0.003 min = 180 ms.
  const SLOW = "if [ -f .git/slow ]; then sleep 5; fi";
  const FAST_LIMIT = { checkTimeoutMin: 0.003 };

  it("v04 AC-60: a check that times out exits 1 naming the command and the limit, and counts no attempt", async () => {
    const r = repo({ test: SLOW, run: FAST_LIMIT });
    r.script([impl({ writes: { "notes.txt": "n\n", ".git/slow": "" } }), impl({ writes: { "never.txt": "x\n" } })]);
    expect(await startRun({ ...r.opts(), mode: "quick", description: DESC })).toBe(1);
    const run = r.run();
    expect(run.next).toBe("checks:Q1");
    expect(run.tasks[0]?.attempts).toBe(1);
    expect(r.logged().length).toBe(1);
    const t = text(r);
    expect(t).toContain(SLOW);
    expect(t).toMatch(/timed out after .*checkTimeoutMin/);
    expect(t).not.toMatch(/Check failed/);
  });

  it("v04 AC-60: --resume after a check timeout runs the same checks again, with no new implement call", async () => {
    const r = repo({ test: SLOW, run: FAST_LIMIT });
    r.script([impl({ writes: { "notes.txt": "n\n", ".git/slow": "" } })]);
    expect(await startRun({ ...r.opts(), mode: "quick", description: DESC })).toBe(1);
    rmSync(join(r.dir, ".git/slow"), { force: true }); // the human fixes the environment
    expect(await resumeRun({ ...r.opts({ gate: ["a"] }) }), text(r)).toBe(0);
    expect(r.logged().length).toBe(1);
    expect(r.run().tasks[0]?.attempts).toBe(1);
  });

  it("v04 AC-60: a base-check test that times out exits 1 with the limit, not as a red base", async () => {
    const r = repo({ test: "sleep 5", run: FAST_LIMIT });
    r.script([]);
    expect(await startRun({ ...r.opts(), mode: "quick", description: DESC })).toBe(1);
    expect(r.run().next).toBe("base-check");
    const t = text(r);
    expect(t).toMatch(/timed out after .*checkTimeoutMin/);
    expect(t).not.toContain("the base is red");
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
