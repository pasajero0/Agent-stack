import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { emitHarness } from "../../src/claude/harness.js";
import { bash, edit, git, patchGates, runHook, write, writeTool } from "../hooks/fixture.js";

// Detection + emission + hooks together, on fresh repos of different stacks — what `generate` does.
const dirs: string[] = [];
function freshRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-stack-e2e-"));
  dirs.push(dir);
  git(dir, "init", "-q", "-b", "main");
  for (const [rel, content] of Object.entries(files)) write(dir, rel, content);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "scaffold");
  return dir;
}
const gates = (dir: string) => JSON.parse(readFileSync(join(dir, ".claude/gates.json"), "utf-8"));

beforeAll(() => {
  vi.spyOn(console, "log").mockImplementation(() => {});
});
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("generate → full gate cycle on a TypeScript repo", () => {
  it("walks grill/spec → merge → plan → verify → report through the real hooks", async () => {
    const dir = freshRepo({
      "package.json": JSON.stringify({
        scripts: { test: "vitest run", typecheck: "tsc --noEmit" },
        devDependencies: { eslint: "9.0.0" },
      }),
      "pnpm-lock.yaml": "",
      "tsconfig.json": "{}",
    });
    await emitHarness(dir);

    const g = gates(dir);
    expect(g).toMatchObject({ packageManager: "pnpm", specGate: "strict", baseBranch: "main" });
    expect(g.commands.lint).toBe("pnpm exec eslint --no-warn-ignored {file}");
    expect(statSync(join(dir, ".claude/bin/verify")).mode & 0o111).not.toBe(0);

    const src = join(dir, "src/app.ts");
    // 0. The default: only the driver edits code, so a chat's code edit gets the refusal line (drive1).
    expect(g.codeBy).toBe("driver");
    const chat = runHook(dir, "spec-gate.sh", edit(src), { AGENT_STACK_RUN: "" });
    expect(chat.code).toBe(2);
    expect(chat.stderr).toContain(
      'Blocked by spec-gate (src/app.ts): only the driver edits code here — gates.json → codeBy is "driver".'
    );
    // The steps below check spec-gate's spec and plan steps in a chat, so a human opens the emergency exit.
    patchGates(dir, { codeBy: "anyone" });
    // 1. No spec merged → no code.
    expect(runHook(dir, "spec-gate.sh", edit(src)).code).toBe(2);
    // 2. Writing the spec and an ADR is always open.
    expect(runHook(dir, "spec-gate.sh", writeTool(join(dir, "docs/specs/A0/SPEC.md"))).code).toBe(0);
    expect(runHook(dir, "spec-gate.sh", writeTool(join(dir, "docs/adr/0001-x.md"))).code).toBe(0);
    // 3. Human merges the spec; code still waits for the plan.
    write(dir, "docs/specs/A0/SPEC.md", "---\nstage: A0\n---\n- **AC-1:** THE SYSTEM SHALL exist.\n");
    git(dir, "add", "docs");
    git(dir, "commit", "-q", "-m", "spec: A0");
    git(dir, "checkout", "-q", "-b", "A0-work");
    const noPlan = runHook(dir, "spec-gate.sh", edit(src));
    expect(noPlan.code).toBe(2);
    expect(noPlan.stderr).toContain("Run /plan A0 first");
    // 4. The plan can be written once, unproven; then code opens.
    const plan = JSON.stringify({
      stage: "A0",
      tasks: [{ id: "T1", ac: ["AC-1"], tier: "S", complexity: "low", verify: "test -f src/app.ts", passes: false }],
    });
    const planPath = join(dir, ".claude/tmp/A0/tasks.json");
    expect(runHook(dir, "guard-file.sh", writeTool(planPath, plan)).code).toBe(0);
    write(dir, ".claude/tmp/A0/tasks.json", plan);
    expect(runHook(dir, "spec-gate.sh", edit(src)).code).toBe(0);
    // 5. Cheating is blocked.
    expect(runHook(dir, "cheat-guard.sh", writeTool(src, "export const x: any = 1;")).code).toBe(2);
    // 6. Implement, verify.
    write(dir, "src/app.test.ts", 'it("A0 AC-1: exists", () => expect(x).toBe(1));\n');
    write(dir, "src/app.ts", "export const x = 1;\n");
    const v = spawnSync(join(dir, ".claude/bin/verify"), [], { cwd: dir, encoding: "utf-8" });
    expect(v.status).toBe(0);
    expect(v.stdout).toContain("1/1 tasks passing");
    // Hard limits hold throughout.
    expect(runHook(dir, "guard-bash.sh", bash("git -C . push")).code).toBe(2);
    expect(runHook(dir, "guard-file.sh", edit(join(dir, ".claude/gates.json"))).code).toBe(2);
  });
});

describe("generate on other stacks", () => {
  it("python (uv): its own lockfile, linter and test command; no JS policing", async () => {
    const dir = freshRepo({
      "pyproject.toml": '[project]\nname = "x"\n[tool.ruff]\n[dependency-groups]\ndev = ["pytest"]\n',
      "uv.lock": "",
    });
    await emitHarness(dir);
    const g = gates(dir);
    expect(g).toMatchObject({ packageManager: "uv", forbiddenPackageManagers: [] });
    expect(g.commands).toEqual({ test: "uv run pytest", lint: "uv run ruff check {file}" });
    expect(g.lintMatch).toEqual(["*.py"]);
    expect(runHook(dir, "guard-bash.sh", bash("npm run docs")).code).toBe(0);
    expect(runHook(dir, "guard-file.sh", edit(join(dir, "uv.lock"))).code).toBe(2);
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf-8")).toContain("**uv** only.");
  });

  it("an empty repo: nothing assumed, every hook still runs cleanly", async () => {
    const dir = freshRepo({ "README.md": "# new\n" });
    await emitHarness(dir);
    const g = gates(dir);
    expect(g).toMatchObject({ packageManager: "", forbiddenPackageManagers: [], protectedGlobs: [] });
    expect(g.commands).toEqual({ test: "", lint: "" });
    for (const hook of ["guard-bash.sh", "post-edit-lint.sh", "cheat-guard.sh"]) {
      const input = hook === "guard-bash.sh" ? bash("ls") : edit(join(dir, "main.go"), "x", "y");
      expect(runHook(dir, hook, input).code, hook).toBe(0);
    }
    patchGates(dir, { codeBy: "anyone" }); // the check below is the stage check, not codeBy (drive1)
    expect(runHook(dir, "spec-gate.sh", edit(join(dir, "main.go"))).code).toBe(2);
  });
});
