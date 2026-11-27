/** Defect 60: the feedback of a red check holds the lines that name failing tests, from the whole output. */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanupProjects } from "../hooks/fixture.js";
import { resumeRun, startRun } from "../../src/run/engine/index.js";
import { DESC, impl, makeFakeExecutable, repo, review, text } from "./engine-fixture.js";
import { plan, toPlanApprove } from "./engine-task-fixture.js";

beforeAll(makeFakeExecutable);
afterEach(() => cleanupProjects());

const TAIL = Array.from({ length: 50 }, (_, i) => String(i + 11)).join("\n");

describe("defect 60: failing lines in the feedback of a red check", () => {
  it("Q1 failing: a FAIL line above the last 50 lines reaches the feedback, once, before the tail", async () => {
    const cmd =
      "if [ -f .git/red ]; then echo ' FAIL  tests/a.test.ts > adds'; printf '\\033[31m×\\033[39m adds\\n'; echo ' FAIL  tests/a.test.ts > adds'; seq 1 60; exit 1; fi";
    const r = repo({ test: cmd, lint: "" });
    r.script([impl({ writes: { "notes.txt": "n\n", ".git/red": "" } }), impl({ model: "opus" })]);
    const code = await startRun({ ...r.opts({ gate: ["c"] }), mode: "quick", description: DESC });
    expect(code, text(r)).toBe(0);
    const expected =
      `Check failed: \`${cmd}\` exited 1.\n` +
      "Failing tests (from the whole output):\n FAIL  tests/a.test.ts > adds\n× adds\n" +
      `Last lines of its output:\n${TAIL}`;
    expect(r.run().tasks[0]?.lastFeedback).toBe(expected);
    expect(r.logged()[1]?.prompt ?? "").toContain("Failing tests (from the whole output):\n FAIL  tests/a.test.ts > adds");
  });

  it("Q1 failing: output with no marker gives the same feedback text as before", async () => {
    const cmd = "if [ -f .git/red ]; then echo boom; exit 1; fi";
    const r = repo({ test: cmd, lint: "" });
    r.script([impl({ writes: { "notes.txt": "n\n", ".git/red": "" } }), impl({ model: "opus" })]);
    expect(await startRun({ ...r.opts({ gate: ["c"] }), mode: "quick", description: DESC }), text(r)).toBe(0);
    expect(r.run().tasks[0]?.lastFeedback).toBe(`Check failed: \`${cmd}\` exited 1. Last lines of its output:\nboom`);
  });

  it("Q1 failing: a green check keeps no failing lines in the run file", async () => {
    const r = repo({ test: "printf 'FA%s\\n' 'IL green-marker'", lint: "" });
    r.script([impl({ writes: { "notes.txt": "n\n" } })]);
    expect(await startRun({ ...r.opts({ gate: ["a"] }), mode: "quick", description: DESC }), text(r)).toBe(0);
    expect(JSON.stringify(r.run())).not.toContain("FAIL green-marker");
  });

  it("Q1 failing: the verify check of a task takes the failing lines from the whole verify.log", async () => {
    const r = repo();
    const verify = "test -f bye.txt || { echo 'FAIL tests/v.test.ts > bye'; seq 1 60; exit 1; }";
    const tasks = [
      { id: "T1", ac: ["AC-1"], tier: "L" as const, verify: "test -f hello.txt" },
      { id: "T2", ac: ["AC-2"], tier: "S" as const, verify },
    ];
    await toPlanApprove(r, [
      plan({ tasks }),
      impl({ model: "opus", writes: { "hello.txt": "hi\n" } }),
      review(),
      impl({ model: "sonnet" }),
      impl({ model: "opus", writes: { "bye.txt": "bye\n" } }),
      review(),
    ]);
    const code = await resumeRun({ ...r.opts({ gate: ["a", "a"] }) });
    expect(code, text(r)).toBe(0);
    const feedback = r.run().tasks[1]?.lastFeedback ?? "";
    expect(feedback).toContain("Failing tests (from the whole output):\nFAIL tests/v.test.ts > bye\nLast lines of its output:");
  });
});
