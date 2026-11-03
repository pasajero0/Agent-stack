import { afterAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  cleanupProjects,
  deployHarness,
  edit,
  git,
  patchGates,
  runHook,
  setMode,
  write,
  writeTool,
} from "./fixture.js";

afterAll(cleanupProjects);

const SPEC = "docs/specs/A0/SPEC.md";

/** A git repo with the harness and an initial commit on main. */
function repo(): string {
  const dir = deployHarness();
  git(dir, "init", "-q", "-b", "main");
  write(dir, "README.md", "# demo\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

const SPEC_V1 = "---\nstage: A0\n---\n## Acceptance criteria\n- **AC-1:** THE SYSTEM SHALL exist.\n## Changes\n";

/** The human merges the stage's first spec into main. */
function mergeSpec(dir: string, body = SPEC_V1): void {
  write(dir, SPEC, body);
  git(dir, "add", SPEC);
  git(dir, "commit", "-q", "-m", "spec: A0");
}

/** Start work on a stage: the stage comes from the branch name. */
const setStage = (dir: string, stage: string) => git(dir, "checkout", "-q", "-b", `${stage}-work`);
const codeEdit = (dir: string) => edit(join(dir, "src/app.ts"));

describe("spec-gate", () => {
  it("strict: no code off a stage branch, docs stay open", () => {
    const dir = repo();
    const r = runHook(dir, "spec-gate.sh", codeEdit(dir));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("not on a stage branch");
    for (const open of [SPEC, "README.md", "docs/adr/0001-x.md", ".claude/tmp/A0/tasks.json"]) {
      expect(runHook(dir, "spec-gate.sh", edit(join(dir, open))).code).toBe(0);
    }
  });

  it("blocks code until the stage's first spec is merged into the base branch", () => {
    const dir = repo();
    setStage(dir, "A0");
    write(dir, SPEC, "# draft, not merged\n");
    const r = runHook(dir, "spec-gate.sh", codeEdit(dir));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("not merged into main");
  });

  it("spec changes ride in the stage branch, ahead of the code", () => {
    const dir = repo();
    mergeSpec(dir);
    setStage(dir, "A0");
    expect(runHook(dir, "spec-gate.sh", codeEdit(dir)).code).toBe(0);

    // 1. Spec edited but not committed → code waits.
    const v2 = SPEC_V1.replace("exist.", "exist and count duplicates.");
    write(dir, SPEC, v2);
    let r = runHook(dir, "spec-gate.sh", codeEdit(dir));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("uncommitted changes");

    // 2. Committed without saying what changed → code waits.
    git(dir, "commit", "-q", "-am", "spec: A0 count duplicates");
    r = runHook(dir, "spec-gate.sh", codeEdit(dir));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("## Changes");

    // 3. Committed with a Changes entry → code opens. History reads spec first, then code.
    write(dir, SPEC, v2 + "- 2026-11-02: AC-1 now counts duplicates (ADR-0002).\n");
    git(dir, "commit", "-q", "-am", "spec: A0 log the change");
    expect(runHook(dir, "spec-gate.sh", codeEdit(dir)).code).toBe(0);
  });

  it("a branch cut before the spec merge must catch up first", () => {
    const dir = repo();
    setStage(dir, "A0");
    git(dir, "checkout", "-q", "main");
    mergeSpec(dir);
    git(dir, "checkout", "-q", "A0-work");
    expect(runHook(dir, "spec-gate.sh", codeEdit(dir)).stderr).toContain("does not contain");
  });

  it("prefers origin/<base> over the local branch when a remote exists", () => {
    const dir = repo();
    const before = git(dir, "rev-parse", "HEAD").trim();
    mergeSpec(dir); // merged locally only
    setStage(dir, "A0");
    git(dir, "update-ref", "refs/remotes/origin/main", before);
    expect(runHook(dir, "spec-gate.sh", codeEdit(dir)).stderr).toContain("origin/main");

    git(dir, "update-ref", "refs/remotes/origin/main", git(dir, "rev-parse", "main").trim());
    expect(runHook(dir, "spec-gate.sh", codeEdit(dir)).code).toBe(0);
  });

  it("honours the configured base branch, stage pattern and modes", () => {
    const dir = repo();
    mergeSpec(dir);
    git(dir, "branch", "-m", "main", "develop");
    setStage(dir, "A0");
    expect(runHook(dir, "spec-gate.sh", codeEdit(dir)).stderr).toContain("'main' not found");
    patchGates(dir, { baseBranch: "develop" });
    expect(runHook(dir, "spec-gate.sh", codeEdit(dir)).code).toBe(0);

    const jira = repo();
    write(jira, "docs/specs/PAY-12/SPEC.md", SPEC_V1);
    git(jira, "add", "docs");
    git(jira, "commit", "-q", "-m", "spec: PAY-12");
    git(jira, "checkout", "-q", "-b", "feature/PAY-12-refunds");
    patchGates(jira, { stagePattern: "^([A-Z]+-[0-9]+)" });
    expect(runHook(jira, "spec-gate.sh", codeEdit(jira)).code).toBe(0);

    const loose = repo();
    patchGates(loose, { specGate: "stage" });
    expect(runHook(loose, "spec-gate.sh", codeEdit(loose)).code).toBe(0);
    patchGates(loose, { specGate: "off" });
    setStage(loose, "A0");
    expect(runHook(loose, "spec-gate.sh", codeEdit(loose)).code).toBe(0);
  });

  it("stays open without a gates.json (harness from an older version)", () => {
    const dir = repo();
    rmSync(join(dir, ".claude/gates.json"));
    expect(runHook(dir, "spec-gate.sh", codeEdit(dir)).code).toBe(0);
  });
});

describe("cheat-guard", () => {
  const dir = deployHarness();
  const guard = (input: unknown) => runHook(dir, "cheat-guard.sh", input);
  const file = (rel: string) => join(dir, rel);

  it.each([
    ["it.skip(", 'it.skip("works", () => {})'],
    ["describe.only", 'describe.only("suite", () => {})'],
    ["@ts-ignore", "// @ts-ignore\nconst x = y;"],
    ["eslint-disable", "/* eslint-disable */"],
    ["new any", "function f(x: any) {}"],
    ["as any", "const y = x as any;"],
    ["pytest skip", '@pytest.mark.skip(reason="later")\ndef test_a(): ...'],
    ["type: ignore", "x = f()  # type: ignore"],
    ["go t.Skip", 't.Skip("flaky")'],
  ])("blocks an edit that adds %s", (_name, code) => {
    const r = guard(edit(file("src/a.test.ts"), code, "old"));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("cheat-guard");
  });

  it("allows edits that keep or remove an existing one", () => {
    expect(guard(edit(file("src/a.ts"), "it.skip('x', f) // kept", "it.skip('x', f)")).code).toBe(0);
    expect(guard(edit(file("src/a.ts"), "it('x', f)", "it.skip('x', f)")).code).toBe(0);
  });

  it("does not trip on lookalikes", () => {
    for (const code of ["const anything = 1;", "skipWhitespace()", "company: anyone", "testing.only"]) {
      expect(guard(edit(file("src/a.ts"), code, "")).code).toBe(0);
    }
  });

  it("checks whole new files on Write, and ignores docs", () => {
    expect(guard(writeTool(file("src/b.test.ts"), "test.only('a', f)")).code).toBe(2);
    expect(guard(writeTool(file("docs/guide.md"), "never use it.skip(")).code).toBe(0);
  });

  it("can be switched off by the human", () => {
    const off = deployHarness();
    patchGates(off, { cheatGuard: false });
    expect(runHook(off, "cheat-guard.sh", edit(join(off, "src/a.ts"), "x as any", "")).code).toBe(0);
  });
});

interface Task {
  id: string;
  verify: string;
  passes: boolean;
  fails?: number;
}

function stageWithTasks(tasks: Task[]): string {
  const dir = repo();
  setStage(dir, "A0");
  write(dir, ".claude/tmp/A0/tasks.json", JSON.stringify({ stage: "A0", tasks }, null, 2));
  return dir;
}

function verify(dir: string, ...ids: string[]) {
  const r = spawnSync(join(dir, ".claude/bin/verify"), ids, { cwd: dir, encoding: "utf-8" });
  return { code: r.status, out: r.stdout + r.stderr };
}

const readTasks = (dir: string): Task[] =>
  JSON.parse(readFileSync(join(dir, ".claude/tmp/A0/tasks.json"), "utf-8")).tasks;

describe("verify runner", () => {
  it("records passes from real exit codes and counts failures", () => {
    const dir = stageWithTasks([
      { id: "T1", verify: "true", passes: false },
      { id: "T2", verify: "echo boom; exit 3", passes: false },
    ]);
    let r = verify(dir);
    expect(r.code).toBe(1);
    expect(r.out).toContain("PASS T1");
    expect(r.out).toContain("FAIL T2 (exit 3");
    expect(r.out).toContain("boom");
    expect(r.out).toContain("1/2 tasks passing");

    r = verify(dir, "T2");
    expect(r.out).toContain("escalate");
    const tasks = readTasks(dir);
    expect(tasks.map((t) => [t.id, t.passes, t.fails])).toEqual([
      ["T1", true, 0],
      ["T2", false, 2],
    ]);
    expect(existsSync(join(dir, ".claude/tmp/A0/verify.log"))).toBe(true);
  });

  it("refuses verify commands that guard-bash would block or ask about", () => {
    const dir = stageWithTasks([
      { id: "T1", verify: "pnpm test && git push", passes: false },
      { id: "T2", verify: "pnpm add left-pad", passes: false },
    ]);
    const r = verify(dir);
    expect(r.code).toBe(1);
    expect(r.out).toContain("FAIL T1 — verify command refused by guard-bash");
    expect(r.out).toContain("FAIL T2 — verify command refused by guard-bash");
    expect(readTasks(dir).every((t) => !t.passes)).toBe(true);
  });

  it("is not auto-allowed: its commands come from an agent-written plan", () => {
    const dir = deployHarness();
    const allow = JSON.parse(readFileSync(join(dir, ".claude/settings.json"), "utf-8")).permissions.allow;
    expect(allow.some((rule: string) => rule.includes("verify"))).toBe(false);
  });

  it("refuses to run without an active stage plan", () => {
    const dir = repo();
    const r = verify(dir);
    expect(r.code).toBe(2);
    expect(r.out).toContain("run /plan first");
  });
});

describe("guard-file on tasks.json", () => {
  const plan = (passes: boolean) =>
    JSON.stringify({ stage: "A0", tasks: [{ id: "T1", verify: "true", passes }] });

  it("lets a fresh plan be written only with every task unproven", () => {
    const dir = repo();
    const path = join(dir, ".claude/tmp/A0/tasks.json");
    expect(runHook(dir, "guard-file.sh", writeTool(path, plan(false))).code).toBe(0);
    expect(runHook(dir, "guard-file.sh", writeTool(path, plan(true))).code).toBe(2);
    expect(runHook(dir, "guard-file.sh", writeTool(path, "not json")).code).toBe(2);
  });

  it("blocks editing an existing plan — only verify updates it", () => {
    const dir = stageWithTasks([{ id: "T1", verify: "true", passes: false }]);
    const path = join(dir, ".claude/tmp/A0/tasks.json");
    const r = runHook(dir, "guard-file.sh", edit(path, '"passes": true', '"passes": false'));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain(".claude/bin/verify");
  });
});

describe("session-start-context", () => {
  const start = (dir: string) =>
    runHook(dir, "session-start-context.sh", { session_id: "t", cwd: dir, source: "compact" });

  it("reports the mode and the active stage's progress", () => {
    const dir = stageWithTasks([
      { id: "T1", verify: "true", passes: false },
      { id: "T2", verify: "true", passes: false },
    ]);
    verify(dir, "T1");
    setMode(dir, "autonomous");
    const r = start(dir);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Autonomous mode");
    expect(r.stdout).toContain("Active stage: A0 — 1/2 tasks passing");
  });

  it("stays quiet about gates in a plain interactive repo", () => {
    const r = start(repo());
    expect(r.code).toBe(0);
    expect(r.stdout).not.toContain("Autonomous");
    expect(r.stdout).not.toContain("Active stage");
  });
});

describe("evidence-gate", () => {
  const stop = (msg: string, extra: Record<string, unknown> = {}) => ({
    hook_event_name: "Stop",
    stop_hook_active: false,
    last_assistant_message: msg,
    ...extra,
  });
  const decision = (r: { stdout: string }) => (r.stdout ? JSON.parse(r.stdout).decision : undefined);

  it("does nothing outside an active stage", () => {
    const dir = repo();
    expect(runHook(dir, "evidence-gate.sh", stop("STATUS: DONE")).stdout).toBe("");
  });

  it("blocks a DONE claim while a task is not passing", () => {
    const dir = stageWithTasks([{ id: "T1", verify: "false", passes: false }]);
    const r = runHook(dir, "evidence-gate.sh", stop("**STATUS:** DONE\nEVIDENCE: trust me"));
    expect(decision(r)).toBe("block");
    expect(JSON.parse(r.stdout).reason).toContain("T1");
  });

  it("blocks DONE without an EVIDENCE section, allows it with one", () => {
    const dir = stageWithTasks([{ id: "T1", verify: "true", passes: false }]);
    verify(dir);
    expect(decision(runHook(dir, "evidence-gate.sh", stop("STATUS: DONE, all good")))).toBe("block");
    expect(runHook(dir, "evidence-gate.sh", stop("STATUS: DONE\nEVIDENCE:\n$ verify → 1/1")).stdout).toBe("");
  });

  it("never blocks twice in a row", () => {
    const dir = stageWithTasks([{ id: "T1", verify: "false", passes: false }]);
    expect(runHook(dir, "evidence-gate.sh", stop("STATUS: DONE", { stop_hook_active: true })).stdout).toBe("");
  });

  it("interactive: an honest IN PROGRESS stop is fine", () => {
    const dir = stageWithTasks([{ id: "T1", verify: "false", passes: false }]);
    expect(runHook(dir, "evidence-gate.sh", stop("STATUS: IN PROGRESS — T1 next")).stdout).toBe("");
  });

  it("autonomous: keeps going until tasks pass or the agent reports BLOCKED", () => {
    const dir = stageWithTasks([{ id: "T1", verify: "false", passes: false }]);
    setMode(dir, "autonomous");
    expect(decision(runHook(dir, "evidence-gate.sh", stop("STATUS: IN PROGRESS")))).toBe("block");
    expect(
      runHook(dir, "evidence-gate.sh", stop("STATUS: BLOCKED\nNEEDS HUMAN DECISION: pick a DB")).stdout
    ).toBe("");
  });

  it("falls back to the transcript when last_assistant_message is missing", () => {
    const dir = stageWithTasks([{ id: "T1", verify: "false", passes: false }]);
    const transcript = join(dir, "transcript.jsonl");
    const line = (text: string) =>
      JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });
    writeFileSync(transcript, [line("working"), line("STATUS: DONE\nEVIDENCE: none")].join("\n") + "\n");
    const r = runHook(dir, "evidence-gate.sh", {
      hook_event_name: "Stop",
      stop_hook_active: false,
      transcript_path: transcript,
    });
    expect(decision(r)).toBe("block");
  });
});
