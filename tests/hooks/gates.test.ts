import { afterAll, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "node:fs";
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
  patchGates(dir, { codeBy: "anyone" });
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

/** /plan's output for a stage: code waits for it once the spec is merged. */
const planStage = (dir: string, stage: string) =>
  write(dir, `.claude/tmp/${stage}/tasks.json`, JSON.stringify({ stage, tasks: [] }));

/** Start work on a planned stage: the stage comes from the branch name. */
const setStage = (dir: string, stage: string) => {
  git(dir, "checkout", "-q", "-b", `${stage}-work`);
  planStage(dir, stage);
};
const codeEdit = (dir: string) => edit(join(dir, "src/app.ts"));

describe("spec-gate", () => {
  it("stays open in a repository with no commits, and closes after the first one", () => {
    const dir = deployHarness();
    patchGates(dir, { codeBy: "anyone" });
    git(dir, "init", "-q", "-b", "main");
    expect(runHook(dir, "spec-gate.sh", codeEdit(dir)).code).toBe(0);
    write(dir, "package.json", "{}\n");
    git(dir, "add", "package.json");
    git(dir, "commit", "-q", "-m", "scaffold");
    expect(runHook(dir, "spec-gate.sh", codeEdit(dir)).code).toBe(2);
  });

  it("does not open on an orphan branch in a repository with history", () => {
    const dir = repo();
    git(dir, "checkout", "-q", "--orphan", "sneaky");
    expect(runHook(dir, "spec-gate.sh", codeEdit(dir)).code).toBe(2);
    const start = runHook(dir, "session-start-context.sh", { session_id: "t", cwd: dir, source: "startup" });
    expect(start.stdout).not.toContain("No commits yet");
  });

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
    // A form commitlint accepts: `spec:` is no Conventional Commits type (hotfix 0.4.4).
    expect(r.stderr).toContain("docs(<stage>): spec — …");

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
    planStage(jira, "PAY-12");
    patchGates(jira, { stagePattern: "^([A-Z]+-[0-9]+)" });
    expect(runHook(jira, "spec-gate.sh", codeEdit(jira)).code).toBe(0);

    const loose = repo();
    patchGates(loose, { specGate: "stage" });
    expect(runHook(loose, "spec-gate.sh", codeEdit(loose)).code).toBe(0);
    patchGates(loose, { specGate: "off" });
    setStage(loose, "A0");
    expect(runHook(loose, "spec-gate.sh", codeEdit(loose)).code).toBe(0);
  });

  describe("plan check", () => {
    it("A0 plan: merged spec, stage branch, no tasks.json → code waits for /plan; docs and tasks.json stay open", () => {
      const dir = repo();
      mergeSpec(dir);
      git(dir, "checkout", "-q", "-b", "A0-work");
      const r = runHook(dir, "spec-gate.sh", codeEdit(dir));
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("Run /plan A0 first");
      expect(r.stderr).toContain(".claude/tmp/A0/tasks.json");
      for (const open of [".claude/tmp/A0/tasks.json", "README.md", "docs/adr/0001-x.md"]) {
        expect(runHook(dir, "spec-gate.sh", edit(join(dir, open))).code).toBe(0);
      }
      planStage(dir, "A0");
      expect(runHook(dir, "spec-gate.sh", codeEdit(dir)).code).toBe(0);
    });

    it("A0 plan: specGate off ignores the missing tasks.json", () => {
      const dir = repo();
      mergeSpec(dir);
      git(dir, "checkout", "-q", "-b", "A0-work");
      patchGates(dir, { specGate: "off" });
      expect(runHook(dir, "spec-gate.sh", codeEdit(dir)).code).toBe(0);
    });

    it("A0 plan: the plan file stays writable when openPaths leave .claude/ closed", () => {
      const dir = repo();
      mergeSpec(dir);
      git(dir, "checkout", "-q", "-b", "A0-work");
      patchGates(dir, { openPaths: ["docs/*", "*.md"] });
      expect(runHook(dir, "spec-gate.sh", writeTool(join(dir, ".claude/tmp/A0/tasks.json"))).code).toBe(0);
      expect(runHook(dir, "spec-gate.sh", writeTool(join(dir, ".claude/tmp/B1/tasks.json"))).code).toBe(2);
      expect(runHook(dir, "spec-gate.sh", codeEdit(dir)).code).toBe(2);
    });

    it("A0 plan: the spec checks come before the plan check", () => {
      const dir = repo();
      git(dir, "checkout", "-q", "-b", "A0-work");
      const r = runHook(dir, "spec-gate.sh", codeEdit(dir));
      expect(r.code).toBe(2);
      expect(r.stderr).toContain("not merged");
      expect(r.stderr).not.toContain("/plan");
    });
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

  it("--dry runs and guards like verify but records nothing: no passes, no fails, no log", () => {
    const dir = stageWithTasks([
      { id: "T1", verify: "true", passes: false },
      { id: "T2", verify: "pnpm add left-pad", passes: false },
    ]);
    const before = readFileSync(join(dir, ".claude/tmp/A0/tasks.json"), "utf-8");
    let r = verify(dir, "--dry", "T1");
    expect(r.code).toBe(0);
    expect(r.out).toContain("PASS T1");
    expect(r.out).toContain("dry run: nothing recorded");
    r = verify(dir, "--dry", "T2");
    expect(r.code).toBe(1);
    expect(r.out).toContain("FAIL T2 — verify command refused by guard-bash");
    expect(readFileSync(join(dir, ".claude/tmp/A0/tasks.json"), "utf-8")).toBe(before);
    expect(existsSync(join(dir, ".claude/tmp/A0/verify.log"))).toBe(false);
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
    // An empty plan would open spec-gate with nothing to verify.
    expect(runHook(dir, "guard-file.sh", writeTool(path, JSON.stringify({ tasks: [] }))).code).toBe(2);
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
    expect(r.stdout).not.toContain("⚠️ Hook");
    expect(r.stdout).not.toContain("No commits yet");
  });

  it("names the unborn branch and says spec-gate is open before the first commit", () => {
    const dir = deployHarness();
    git(dir, "init", "-q", "-b", "main");
    const r = runHook(dir, "session-start-context.sh", { session_id: "t", cwd: dir, source: "startup" });
    expect(r.stdout).toContain("- Branch: `main`");
    expect(r.stdout).toContain("- Last commit: none yet");
    expect(r.stdout).toContain("No commits yet: spec-gate stays open");
  });

  it("A0 hints: a stage branch without tasks.json names the next step, /spec or /plan", () => {
    const dir = repo();
    git(dir, "checkout", "-q", "-b", "A0-work");
    const startup = () =>
      runHook(dir, "session-start-context.sh", { session_id: "t", cwd: dir, source: "startup" });
    let r = startup();
    expect(r.stdout).toContain("no merged spec yet. Next: /spec");
    expect(r.stdout).not.toContain("Next: /plan");

    git(dir, "checkout", "-q", "main");
    mergeSpec(dir);
    git(dir, "checkout", "-q", "A0-work");
    git(dir, "merge", "-q", "main");
    r = startup();
    expect(r.stdout).toContain("spec merged, no tasks.json yet. Next: /plan");
    expect(r.stdout).not.toContain("Next: /spec");
  });

  it("warns about a hook file that is not registered or not executable", () => {
    const dir = repo();
    write(dir, ".claude/hooks/docs-guard.sh", "#!/usr/bin/env bash\nexit 0\n");
    chmodSync(join(dir, ".claude/hooks/cheat-guard.sh"), 0o644);
    const r = start(dir);
    expect(r.stdout).toContain("Hook docs-guard.sh is in .claude/hooks/ but not registered");
    expect(r.stdout).toContain("Hook cheat-guard.sh is registered but not executable");
    expect(r.stdout).not.toContain("gates-lib.sh");
  });

  it("says once that the guards block everything when jq is missing", () => {
    const dir = repo();
    const bin = join(dir, "fakebin");
    mkdirSync(bin);
    for (const tool of ["bash", "cat"]) {
      symlinkSync(spawnSync("bash", ["-c", `command -v ${tool}`], { encoding: "utf-8" }).stdout.trim(), join(bin, tool));
    }
    const r = runHook(dir, "session-start-context.sh", { session_id: "t", cwd: dir }, { PATH: bin });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("jq is not on PATH");
  });
});

