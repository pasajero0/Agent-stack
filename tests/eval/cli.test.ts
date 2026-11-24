import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { EVAL_SCRIPT, REPO_ROOT, runEval, tempDir } from "./helpers.js";

/** A tasks dir with one valid task `ok-1`, so a refusal can only come from the flag under test. */
function tasksDirWithTask(): string {
  const dir = tempDir();
  mkdirSync(join(dir, "ok-1"));
  writeFileSync(join(dir, "ok-1", "task.json"), "{}");
  return dir;
}

/** Refusal messages the runner prints for a bad flag. */
const REFUSAL = /unknown flag|needs a value|must be|not a valid task id|task\.json/;

describe("eval runner flags", () => {
  const bad: Array<[string, string[], string]> = [
    ["--k zero", ["--k", "0"], "--k"],
    ["--k 21", ["--k", "21"], "--k"],
    ["--k not digits", ["--k", "2.5"], "--k"],
    ["--k negative", ["--k", "-1"], "--k"],
    ["--k with a sign", ["--k", "+3"], "--k"],
    ["--timeout-min zero", ["--timeout-min", "0"], "--timeout-min"],
    ["--timeout-min negative", ["--timeout-min", "-2"], "--timeout-min"],
    ["--timeout-min text", ["--timeout-min", "soon"], "--timeout-min"],
    ["unknown flag", ["--bogus"], "--bogus"],
    ["flag without value", ["--out"], "--out"],
    ["--k without value", ["--k"], "--k"],
    ["--task without value", ["--task"], "--task"],
    ["--tasks-dir without value", ["--tasks-dir"], "--tasks-dir"],
    ["--timeout-min without value", ["--timeout-min"], "--timeout-min"],
    ["--task uppercase", ["--task", "Plain"], "--task"],
    ["--task with a slash", ["--task", "a/b"], "--task"],
  ];
  for (const [name, args, flag] of bad) {
    it(`evals1 AC-9: refuses ${name} with code 1, names ${flag} and tries nothing`, () => {
      const r = runEval(["--tasks-dir", tasksDirWithTask(), "--task", "ok-1", ...args]);
      expect(r.code).toBe(1);
      expect(r.stderr).toContain(flag);
      expect(r.stderr).toMatch(REFUSAL);
      expect(readdirSync(r.outDir)).toEqual([]);
    });
  }

  it("evals1 AC-9: checks --task against the id pattern before it builds a path from it", () => {
    // `../evil/task.json` exists next to the tasks dir, so only the pattern check can refuse it.
    const root = tempDir();
    const tasksDir = join(root, "tasks");
    mkdirSync(tasksDir);
    mkdirSync(join(root, "evil"));
    writeFileSync(join(root, "evil", "task.json"), "{}");
    const r = runEval(["--tasks-dir", tasksDir, "--task", "../evil"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--task");
    expect(r.stderr).toContain("not a valid task id");
    expect(readdirSync(r.outDir)).toEqual([]);
  });

  it("evals1 AC-9: refuses a --task that has no task.json in the tasks dir", () => {
    const tasksDir = tasksDirWithTask();
    mkdirSync(join(tasksDir, "empty"));
    const r = runEval(["--task", "empty", "--tasks-dir", tasksDir]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--task");
    expect(r.stderr).toContain("task.json");
    expect(readdirSync(r.outDir)).toEqual([]);
  });

  it("evals1 AC-9: refuses a --task that names no folder in the tasks dir", () => {
    const r = runEval(["--task", "missing", "--tasks-dir", tasksDirWithTask()]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--task");
    expect(readdirSync(r.outDir)).toEqual([]);
  });

  it("evals1 AC-9: accepts valid flags (and a repeated --task) without a refusal", () => {
    const r = runEval([
      "--k", "20", "--timeout-min", "0.5",
      "--task", "ok-1", "--task", "ok-1",
      "--tasks-dir", tasksDirWithTask(), "--yes", "--keep",
    ]);
    expect(r.stderr).not.toMatch(REFUSAL);
    expect(r.stderr).not.toContain("dist/ is missing");
  });
});

describe("eval runner dist check", () => {
  it("evals1 AC-10: without dist/index.js it prints the message, exits 1, tries nothing and does not build", () => {
    const root = tempDir();
    mkdirSync(join(root, "scripts"));
    const copy = join(root, "scripts", "eval.mjs");
    copyFileSync(EVAL_SCRIPT, copy);
    const r = runEval(["--tasks-dir", tasksDirWithTask(), "--task", "ok-1"], { script: copy });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("dist/ is missing: run pnpm build first");
    expect(existsSync(join(root, "dist"))).toBe(false);
    expect(readdirSync(r.outDir)).toEqual([]);
  });

  it("evals1 AC-10: with the real dist/index.js it does not print the message", () => {
    expect(existsSync(join(REPO_ROOT, "dist", "index.js"))).toBe(true);
    const r = runEval(["--tasks-dir", tasksDirWithTask(), "--task", "ok-1"]);
    expect(r.stderr).not.toContain("dist/ is missing");
  });
});

describe("ci workflow", () => {
  it("evals1 AC-27: ci.yml has a `pnpm build` step before the `pnpm test:slow` step", () => {
    const lines = readFileSync(join(REPO_ROOT, ".github", "workflows", "ci.yml"), "utf8").split("\n");
    const step = (cmd: RegExp): number => lines.findIndex((l) => cmd.test(l));
    const build = step(/^\s*-?\s*run:\s*pnpm build\s*$/);
    const slow = step(/^\s*-?\s*run:\s*pnpm test:slow\b/);
    expect(build).toBeGreaterThan(-1);
    expect(slow).toBeGreaterThan(build);
  });

  it("evals1 AC-27: the eval tests are in the slow project, so they run after the build", () => {
    const config = readFileSync(join(REPO_ROOT, "vitest.config.ts"), "utf8");
    expect(config).toContain('"tests/eval/**/*.test.ts"');
  });
});
