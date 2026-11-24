import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runEval, tempDir } from "./helpers.js";

/** A tasks dir with `count` valid tasks. */
function tasksDir(count: number): string {
  const dir = tempDir();
  for (let i = 1; i <= count; i++) {
    const t = join(dir, `ok-${i}`);
    mkdirSync(join(t, "fixture"), { recursive: true });
    writeFileSync(join(t, "fixture", "a.txt"), "a");
    writeFileSync(
      join(t, "task.json"),
      JSON.stringify({ mode: "quick", description: "A valid task", fixture: "fixture", check: "true", expect: "finished" }),
    );
  }
  return dir;
}

const TTY = { AGENT_STACK_EVAL_TTY: "1" };

describe("eval runner estimate and start question", () => {
  it("evals1 AC-2: prints the singular estimate and starts with --yes without asking", () => {
    const r = runEval(["--tasks-dir", tasksDir(1), "--k", "1", "--yes"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("1 task × 1 try = 1 try, about $0.10 with the real claude.");
    expect(r.stdout).not.toContain("Start?");
    expect(r.stdout).not.toContain("not started");
  });

  it("evals1 AC-2: prints the plural estimate with the cost of n·k tries", () => {
    const r = runEval(["--tasks-dir", tasksDir(2), "--k", "3", "--yes"]);
    expect(r.stdout).toContain("2 tasks × 3 tries = 6 tries, about $0.60 with the real claude.");
  });

  it("evals1 AC-2: asks Start? [y/N] and starts on the answer Y through the terminal seam", () => {
    const r = runEval(["--tasks-dir", tasksDir(1), "--k", "1"], { env: TTY, input: "Y\n" });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("1 task × 1 try = 1 try, about $0.10 with the real claude. Start? [y/N]");
    expect(r.stdout).not.toContain("not started");
  });

  it("evals1 AC-2: starts on the answer yes in any case", () => {
    const r = runEval(["--tasks-dir", tasksDir(1), "--k", "1"], { env: TTY, input: "YeS\n" });
    expect(r.code).toBe(0);
  });

  it("evals1 AC-11: the answer n prints not started, exits 1 and writes no results file", () => {
    const r = runEval(["--tasks-dir", tasksDir(1), "--k", "1"], { env: TTY, input: "n\n" });
    expect(r.code).toBe(1);
    expect(r.stdout + r.stderr).toContain("not started");
    expect(readdirSync(r.outDir)).toEqual([]);
  });

  it("evals1 AC-11: an empty answer does not start", () => {
    const r = runEval(["--tasks-dir", tasksDir(1), "--k", "1"], { env: TTY, input: "\n" });
    expect(r.code).toBe(1);
    expect(r.stdout + r.stderr).toContain("not started");
  });

  it("evals1 AC-11: without a terminal and without --yes it prints not started and exits 1", () => {
    const r = runEval(["--tasks-dir", tasksDir(1), "--k", "1"], { env: { AGENT_STACK_EVAL_TTY: "" }, input: "y\n" });
    expect(r.code).toBe(1);
    expect(r.stdout + r.stderr).toContain("not started");
    expect(readdirSync(r.outDir)).toEqual([]);
  });
});
