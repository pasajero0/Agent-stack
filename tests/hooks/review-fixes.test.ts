// Regression tests for the code-review findings on the MVP gates (each `it` names the finding).
import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { bash, cleanupProjects, deployHarness, edit, git, runHook, setMode, write } from "./fixture.js";

afterAll(cleanupProjects);

function repo(): string {
  const dir = deployHarness();
  git(dir, "init", "-q", "-b", "main");
  write(dir, "README.md", "# demo\n");
  git(dir, "add", "README.md");
  git(dir, "commit", "-q", "-m", "init");
  return dir;
}

describe("review fixes", () => {
  it("symlinked project dir: a /private/... file_path still hits the gates", () => {
    // A project reached through a symlink (macOS: /var → /private/var) must not read as "outside".
    const real = repo();
    const link = join(mkdtempSync(join(tmpdir(), "agent-stack-link-")), "proj");
    symlinkSync(real, link);
    const viaReal = edit(join(realpathSync(real), "src/app.ts"));
    expect(runHook(link, "spec-gate.sh", viaReal, { CLAUDE_PROJECT_DIR: link }).code).toBe(2);
    const plan = join(realpathSync(real), ".claude/tmp/A0/tasks.json");
    write(real, ".claude/tmp/A0/tasks.json", '{"tasks":[]}');
    expect(runHook(link, "guard-file.sh", edit(plan), { CLAUDE_PROJECT_DIR: link }).code).toBe(2);
  });

  it("missing jq: PreToolUse guards block instead of silently passing", () => {
    const dir = deployHarness();
    const bin = mkdtempSync(join(tmpdir(), "agent-stack-nojq-"));
    for (const tool of ["bash", "dirname", "basename", "cat", "head", "tr", "grep", "paste", "git"]) {
      const which = spawnSync("bash", ["-c", `command -v ${tool}`], { encoding: "utf-8" }).stdout.trim();
      symlinkSync(which, join(bin, tool));
    }
    const env = { PATH: bin };
    for (const hook of ["guard-bash.sh", "guard-file.sh", "spec-gate.sh", "cheat-guard.sh"]) {
      const r = runHook(dir, hook, bash("ls"), env);
      expect(r.code, hook).toBe(2);
      expect(r.stderr, hook).toContain("jq is not on PATH");
    }
  });

  it("installs with flags before the package are caught", () => {
    const dir = deployHarness();
    for (const cmd of ["pnpm add -D vitest", "npm i --save-dev x", "yarn add -D y"]) {
      const r = runHook(dir, "guard-bash.sh", bash(cmd));
      // npm/yarn are forbidden outright in a pnpm repo; pnpm add asks.
      expect(r.code === 2 || JSON.parse(r.stdout).hookSpecificOutput.permissionDecision === "ask", cmd).toBe(true);
    }
    setMode(dir, "autonomous");
    expect(runHook(dir, "guard-bash.sh", bash("pnpm add -D vitest")).code).toBe(2);
  });

  it("the agent cannot merge a PR — merging is the human's approval", () => {
    const dir = deployHarness();
    for (const cmd of ["gh pr merge 12 --squash", "glab mr merge 3", "gh api -X PUT repos/o/r/pulls/12/merge"]) {
      expect(runHook(dir, "guard-bash.sh", bash(cmd)).code, cmd).toBe(2);
    }
    expect(runHook(dir, "guard-bash.sh", bash("gh pr view 12")).code).toBe(0);
    const allow = JSON.parse(readFileSync(join(dir, ".claude/settings.json"), "utf-8")).permissions.allow;
    expect(allow.some((r: string) => r.includes("api"))).toBe(false);
  });

  it("git push behind shell keywords and braces is caught", () => {
    const dir = deployHarness();
    for (const cmd of ["if true; then git push; fi", "for i in 1; do git push; done", "{ git push; }", "! git push"]) {
      expect(runHook(dir, "guard-bash.sh", bash(cmd)).code, cmd).toBe(2);
    }
  });

  it("evidence-gate reads report fields at line start, not words in prose", () => {
    const dir = repo();
    git(dir, "checkout", "-q", "-b", "A0-work");
    write(dir, ".claude/tmp/A0/tasks.json", JSON.stringify({ tasks: [{ id: "T1", verify: "true", passes: true }] }));
    const stop = (msg: string) =>
      runHook(dir, "evidence-gate.sh", { stop_hook_active: false, last_assistant_message: msg });
    expect(JSON.parse(stop("STATUS: DONE\nThere is no EVIDENCE yet.").stdout).decision).toBe("block");
    expect(stop("**STATUS:** DONE\n**EVIDENCE:** verify → 1/1").stdout).toBe("");

    write(dir, ".claude/tmp/A0/tasks.json", JSON.stringify({ tasks: [{ id: "T1", verify: "false", passes: false }] }));
    setMode(dir, "autonomous");
    expect(JSON.parse(stop("STATUS: IN PROGRESS — nothing is blocked").stdout).decision).toBe("block");
  });

  it("spec-gate defaults to strict when gates.json lacks the key", () => {
    const dir = repo();
    const file = join(dir, ".claude/gates.json");
    const g = JSON.parse(readFileSync(file, "utf-8"));
    delete g.specGate;
    writeFileSync(file, JSON.stringify(g));
    expect(runHook(dir, "spec-gate.sh", edit(join(dir, "src/app.ts"))).code).toBe(2);
  });

  it("cheat-guard: no lookalike false positives, Playwright forms caught", () => {
    const dir = deployHarness();
    const f = join(dir, "src/a.ts");
    for (const code of ["limit.skip(2)", "submit.only = true", "commit.skip()"]) {
      expect(runHook(dir, "cheat-guard.sh", edit(f, code, "")).code, code).toBe(0);
    }
    for (const code of ["test.describe.only('x', f)", "test.skip('x', f)"]) {
      expect(runHook(dir, "cheat-guard.sh", edit(f, code, "")).code, code).toBe(2);
    }
  });

  it("verify: a command reading stdin does not swallow the next tasks", () => {
    const dir = repo();
    git(dir, "checkout", "-q", "-b", "A0-work");
    write(
      dir,
      ".claude/tmp/A0/tasks.json",
      JSON.stringify({ tasks: [{ id: "T1", verify: "cat", passes: false }, { id: "T2", verify: "true", passes: false }] })
    );
    const r = spawnSync(join(dir, ".claude/bin/verify"), [], { cwd: dir, encoding: "utf-8" });
    expect(r.stdout).toContain("PASS T1");
    expect(r.stdout).toContain("PASS T2");
    expect(r.stdout).toContain("2/2 tasks passing");
  });

  it("verify: parallel runs do not lose each other's results", () => {
    const dir = repo();
    git(dir, "checkout", "-q", "-b", "A0-work");
    const tasks = Array.from({ length: 4 }, (_, i) => ({ id: `T${i}`, verify: "sleep 0.2", passes: false }));
    write(dir, ".claude/tmp/A0/tasks.json", JSON.stringify({ tasks }));
    const script = tasks.map((t) => `${join(dir, ".claude/bin/verify")} ${t.id} >/dev/null &`).join("\n") + "\nwait";
    spawnSync("bash", ["-c", script], { cwd: dir });
    const after = JSON.parse(readFileSync(join(dir, ".claude/tmp/A0/tasks.json"), "utf-8")).tasks;
    expect(after.every((t: { passes: boolean }) => t.passes)).toBe(true);
  });
});
