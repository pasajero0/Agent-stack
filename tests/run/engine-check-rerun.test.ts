/** Defect 56: a red check runs once more before the driver counts a failed attempt. */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupProjects } from "../hooks/fixture.js";
import { startRun } from "../../src/run/engine/index.js";
import { needsRerun } from "../../src/run/engine/steps-check.js";
import { DESC, impl, makeFakeExecutable, repo, text } from "./engine-fixture.js";

beforeAll(makeFakeExecutable);
afterEach(() => cleanupProjects());

// Each run of the check appends a line to .git/runs (outside the task diff) while .git/on exists.
const COUNT = "if [ -f .git/on ]; then echo x >> .git/runs; fi";
const runs = (dir: string): number =>
  existsSync(join(dir, ".git/runs")) ? readFileSync(join(dir, ".git/runs"), "utf8").trim().split("\n").length : 0;

describe("defect 56: one rerun of a red check", () => {
  it("Q1 rerun: red then green goes on, records the first exit and shows the accept line", async () => {
    // Red (exit 3) on the first run while .git/flaky exists; the run removes it, so the second run is green.
    const cmd = `${COUNT}; if [ -f .git/flaky ]; then rm .git/flaky; echo first; exit 3; fi`;
    const r = repo({ test: cmd });
    r.script([impl({ writes: { "notes.txt": "n\n", ".git/on": "", ".git/flaky": "" } })]);
    const code = await startRun({ ...r.opts({ gate: ["a"] }), mode: "quick", description: DESC });
    expect(code, text(r)).toBe(0);
    const task = r.run().tasks[0];
    expect(task?.attempts).toBe(1);
    expect(task?.commit).not.toBeNull();
    expect(task?.checks.find((c) => c.cmd === cmd)).toEqual({ cmd, exit: 0, skipped: false, firstExit: 3 });
    expect(runs(r.dir)).toBe(2);
    expect(r.logged().length).toBe(1);
    expect(text(r)).toContain(`check passed on a second run: ${cmd} (first exit 3)`);
  });

  it("Q1 rerun: red then red fails the attempt once, with the output of the second run", async () => {
    const cmd = `${COUNT}; if [ -f .git/red ]; then echo "red-run-$(wc -l < .git/runs | tr -d ' ')"; exit 1; fi`;
    const r = repo({ test: cmd });
    r.script([
      impl({ writes: { "notes.txt": "n\n", ".git/on": "", ".git/red": "" } }),
      impl({ model: "opus", deletes: [".git/red"] }),
    ]);
    const code = await startRun({ ...r.opts({ gate: ["a"] }), mode: "quick", description: DESC });
    expect(code, text(r)).toBe(0);
    const task = r.run().tasks[0];
    expect(task?.attempts).toBe(2);
    // Two runs in the red attempt, one green run in the second attempt.
    expect(runs(r.dir)).toBe(3);
    const feedback = r.logged()[1]?.prompt ?? "";
    expect(feedback).toContain("red-run-2");
    expect(feedback).not.toContain("red-run-1");
    expect(task?.checks.find((c) => c.cmd === cmd)?.firstExit).toBeUndefined();
    expect(text(r)).not.toContain("check passed on a second run");
  });

  it("Q1 rerun: a green check runs once", async () => {
    const r = repo({ test: COUNT });
    r.script([impl({ writes: { "notes.txt": "n\n", ".git/on": "" } })]);
    expect(await startRun({ ...r.opts({ gate: ["a"] }), mode: "quick", description: DESC }), text(r)).toBe(0);
    expect(runs(r.dir)).toBe(1);
    expect(r.run().tasks[0]?.checks.every((c) => c.firstExit === undefined)).toBe(true);
    expect(text(r)).not.toContain("check passed on a second run");
  });

  it("Q1 rerun: a timeout is not rerun", async () => {
    // A rerun would be green (the first run removes .git/slow) and the run would go on; it must stop instead.
    const cmd = "if [ -f .git/slow ]; then rm .git/slow; sleep 5; fi";
    const r = repo({ test: cmd, run: { checkTimeoutMin: 0.003 } });
    r.script([impl({ writes: { "notes.txt": "n\n", ".git/slow": "" } })]);
    expect(await startRun({ ...r.opts({ gate: ["a"] }), mode: "quick", description: DESC })).toBe(1);
    expect(r.run().next).toBe("checks:Q1");
    expect(text(r)).toMatch(/timed out after .*checkTimeoutMin/);
  });

  it("Q1 rerun: a skipped (empty) command, a timeout, an abort and a green run are not rerun; a red run is", () => {
    const base = { cmd: "x", tail: "" };
    expect(needsRerun({ ...base, cmd: "", exit: 0, skipped: true })).toBe(false);
    expect(needsRerun({ ...base, exit: 1, skipped: false, timedOut: true })).toBe(false);
    expect(needsRerun({ ...base, exit: 130, skipped: false, aborted: true })).toBe(false);
    expect(needsRerun({ ...base, exit: 0, skipped: false })).toBe(false);
    expect(needsRerun({ ...base, exit: 2, skipped: false })).toBe(true);
  });

  it("Q1 rerun: an empty lint command is recorded as skipped, without a first exit", async () => {
    const r = repo({ test: "true", lint: "" });
    r.script([impl({ writes: { "notes.txt": "n\n" } })]);
    expect(await startRun({ ...r.opts({ gate: ["a"] }), mode: "quick", description: DESC }), text(r)).toBe(0);
    const lint = r.run().tasks[0]?.checks.find((c) => c.skipped);
    expect(lint).toEqual({ cmd: "(empty lint command)", exit: 0, skipped: true });
  });
});
