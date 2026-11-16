import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  bash,
  cleanupProjects,
  deployHarness,
  edit,
  patchGates,
  PY_PARAMS,
  runHook,
  setMode,
  writeTool,
} from "./fixture.js";

let dir: string;
beforeAll(() => {
  dir = deployHarness();
});
afterAll(cleanupProjects);

describe("guard-bash", () => {
  it.each([
    "git push origin main",
    "git -C . push",
    "git --no-pager push",
    "git -c core.sshCommand=ssh push origin HEAD",
    "env FOO=1 git push",
    "FOO=1 git push",
    "command git push",
    "bash -c 'git push'",
    'sh -c "git push --force"',
    "echo $(git push)",
    "cd repo && git push",
    "git status; git push",
  ])("blocks git push: %s", (cmd) => {
    expect(runHook(dir, "guard-bash.sh", bash(cmd)).code).toBe(2);
  });

  it.each([
    "git status",
    "git stash push -m wip",
    'git commit -m "fix the push button"',
    "git log --grep push",
    "pnpm test",
  ])("allows: %s", (cmd) => {
    expect(runHook(dir, "guard-bash.sh", bash(cmd)).code).toBe(0);
  });

  it("blocks a forbidden package manager", () => {
    expect(runHook(dir, "guard-bash.sh", bash("npm install")).code).toBe(2);
    expect(runHook(dir, "guard-bash.sh", bash("cd x && yarn")).code).toBe(2);
  });

  it("asks before installing in interactive mode", () => {
    for (const cmd of ["pnpm add lodash", "pip install requests", "brew install jq"]) {
      const r = runHook(dir, "guard-bash.sh", bash(cmd));
      expect(r.code).toBe(0);
      expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("ask");
    }
    expect(runHook(dir, "guard-bash.sh", bash("pnpm install --frozen-lockfile")).stdout).toBe("");
  });

  it.each(["pnpm install && pnpm test", "pnpm i; pnpm test", "pnpm install | tee log", "(pnpm install)"])(
    "does not read a shell operator as a package name: %s",
    (cmd) => {
      const r = runHook(dir, "guard-bash.sh", bash(cmd));
      expect(r.code).toBe(0);
      expect(r.stdout).toBe("");
    }
  );

  it("still asks when a real package precedes the operator", () => {
    const r = runHook(dir, "guard-bash.sh", bash("pnpm add lodash && pnpm test"));
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("ask");
  });

  it("denies installing in autonomous mode", () => {
    const auto = deployHarness();
    setMode(auto, "autonomous");
    const r = runHook(auto, "guard-bash.sh", bash("pnpm add lodash"));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain("NEEDS HUMAN DECISION");
  });

  it("does not police JS package managers in a non-JS repo", () => {
    const py = deployHarness(PY_PARAMS);
    expect(runHook(py, "guard-bash.sh", bash("npm run build")).code).toBe(0);
    expect(runHook(py, "guard-bash.sh", bash("git push")).code).toBe(2);
  });
});

describe("guard-file", () => {
  it.each([
    ".claude/settings.json",
    ".claude/settings.local.json",
    ".claude/gates.json",
    ".claude/hooks/guard-bash.sh",
    ".claude/bin/verify",
  ])("protects the harness itself: %s", (rel) => {
    expect(runHook(dir, "guard-file.sh", edit(join(dir, rel))).code).toBe(2);
    expect(runHook(dir, "guard-file.sh", writeTool(rel)).code).toBe(2);
  });

  it("blocks generated files and the lockfile", () => {
    expect(runHook(dir, "guard-file.sh", edit(join(dir, "dist/index.js"))).code).toBe(2);
    expect(runHook(dir, "guard-file.sh", edit(join(dir, "pnpm-lock.yaml"))).code).toBe(2);
  });

  it("asks before touching an env file", () => {
    const r = runHook(dir, "guard-file.sh", edit(join(dir, ".env")));
    expect(r.code).toBe(0);
    expect(JSON.parse(r.stdout).hookSpecificOutput.permissionDecision).toBe("ask");
  });

  it("lets ordinary source and harness-scratch files through", () => {
    expect(runHook(dir, "guard-file.sh", edit(join(dir, "src/app.ts"))).code).toBe(0);
    expect(runHook(dir, "guard-file.sh", edit(join(dir, ".claude/tmp/x-plan.md"))).code).toBe(0);
  });

  it("uses the stack's own protected globs", () => {
    const py = deployHarness(PY_PARAMS);
    expect(runHook(py, "guard-file.sh", edit(join(py, "uv.lock"))).code).toBe(2);
    expect(runHook(py, "guard-file.sh", edit(join(py, "pkg/__pycache__/m.pyc"))).code).toBe(2);
    expect(runHook(py, "guard-file.sh", edit(join(py, "dist/index.js"))).code).toBe(0);
  });
});

describe("post-edit-lint", () => {
  it("surfaces linter failures and warnings from the configured command", () => {
    const repo = deployHarness();
    patchGates(repo, {
      commands: { test: "", lint: "echo 'warning: unused var in {file}'" },
      lintMatch: ["*.ts"],
    });
    const r = runHook(repo, "post-edit-lint.sh", edit(join(repo, "src/my file.ts")));
    const ctx = JSON.parse(r.stdout).hookSpecificOutput.additionalContext as string;
    expect(ctx).toContain("warning: unused var in");
    expect(ctx).toContain("src/my file.ts");
  });

  it("stays silent on a clean run, an unmatched file, or no linter", () => {
    const repo = deployHarness();
    patchGates(repo, { commands: { test: "", lint: "true {file}" }, lintMatch: ["*.ts"] });
    expect(runHook(repo, "post-edit-lint.sh", edit(join(repo, "src/a.ts"))).stdout).toBe("");
    patchGates(repo, { commands: { test: "", lint: "false {file}" }, lintMatch: ["*.ts"] });
    expect(runHook(repo, "post-edit-lint.sh", edit(join(repo, "README.md"))).stdout).toBe("");
    expect(runHook(dir, "post-edit-lint.sh", edit(join(dir, "src/a.ts"))).stdout).toBe("");
  });
});
