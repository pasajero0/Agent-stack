import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RunError } from "../../src/run/errors.js";
import { runCheck, verifyTail, verifyFailing, failingLines, lintRuns, globMatch } from "../../src/run/checks.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-stack-checks-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("runCheck", () => {
  it("v04 AC-19: reports exit 0 and output tail of a passing command", async () => {
    const r = await runCheck("echo hi", dir, 5000);
    expect(r).toMatchObject({ cmd: "echo hi", exit: 0, skipped: false });
    expect(r.tail).toContain("hi");
  });

  it("v04 AC-19: decides by exit code and keeps stderr in the tail", async () => {
    const r = await runCheck("echo oops >&2; exit 3", dir, 5000);
    expect(r.exit).toBe(3);
    expect(r.tail).toContain("oops");
  });

  it("v04 AC-19: keeps only the last 50 lines", async () => {
    const r = await runCheck("seq 1 200", dir, 5000);
    const lines = r.tail.split("\n");
    expect(lines).toHaveLength(50);
    expect(lines[0]).toBe("151");
    expect(lines[49]).toBe("200");
  });

  it("v04 AC-33: a timeout kills the command and gives non-zero exit", async () => {
    const r = await runCheck("sleep 5", dir, 200);
    expect(r.exit).not.toBe(0);
    expect(r.tail).toContain("timed out");
  });

  it("v04 AC-33: a timeout kills the whole process group, children included", async () => {
    const pidFile = join(dir, "child.pid");
    const r = await runCheck(`bash -c 'echo $$ > "${pidFile}"; sleep 30' & wait`, dir, 500);
    expect(r.exit).not.toBe(0);
    const pid = Number(readFileSync(pidFile, "utf8").trim());
    expect(pid).toBeGreaterThan(1);
    let alive = true;
    for (let i = 0; i < 20 && alive; i++) {
      try {
        process.kill(pid, 0);
        await new Promise((res) => setTimeout(res, 50));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });

  it("v04 AC-56: an empty command is skipped", async () => {
    expect(await runCheck("", dir, 1000)).toMatchObject({ skipped: true, exit: 0 });
    expect((await runCheck("   ", dir, 1000)).skipped).toBe(true);
  });
});

describe("verifyTail", () => {
  it("v04 AC-19: returns the last 50 lines of verify.log", () => {
    mkdirSync(join(dir, ".claude/tmp/s1"), { recursive: true });
    const text = Array.from({ length: 80 }, (_, i) => `l${i + 1}`).join("\n") + "\n";
    writeFileSync(join(dir, ".claude/tmp/s1/verify.log"), text);
    const lines = verifyTail(dir, "s1").split("\n");
    expect(lines).toHaveLength(50);
    expect(lines[0]).toBe("l31");
    expect(lines[49]).toBe("l80");
  });

  it("v04 AC-19: a missing log gives an empty string", () => {
    expect(verifyTail(dir, "none")).toBe("");
  });
});

describe("defect 60: failing lines from the whole output", () => {
  it("Q1 failing: a red check keeps a FAIL line that is above the last 50 lines", async () => {
    const r = await runCheck("echo ' FAIL  tests/a.test.ts > adds'; seq 1 80; exit 1", dir, 5000);
    expect(r.tail).not.toContain("FAIL");
    expect(r.failing).toBe(" FAIL  tests/a.test.ts > adds");
  });

  it("Q1 failing: keeps the order, drops exact repeats, knows each marker", () => {
    const out = [
      "  × adds",
      "ok line",
      "✗ subtracts",
      "  × adds",
      "not ok 3 - divides",
      "--- FAIL: TestX (0.00s)",
      "FAILED tests/b.py::test_y",
      "a FAIL in the middle",
    ].join("\n");
    expect(failingLines(out).split("\n")).toEqual([
      "  × adds",
      "✗ subtracts",
      "not ok 3 - divides",
      "--- FAIL: TestX (0.00s)",
      "FAILED tests/b.py::test_y",
    ]);
  });

  it("Q1 failing: more than 40 lines are cut and the count of dropped lines is stated; a long line is cut", () => {
    const out = Array.from({ length: 45 }, (_, i) => `FAIL t${i + 1}`).join("\n") + `\nFAIL ${"x".repeat(400)}`;
    const lines = failingLines(out).split("\n");
    expect(lines).toHaveLength(41);
    expect(lines[0]).toBe("FAIL t1");
    expect(lines[39]).toBe("FAIL t40");
    expect(lines[40]).toBe("(6 more failing lines not shown)");
    expect(failingLines(`FAIL ${"x".repeat(400)}`)).toHaveLength(300);
  });

  it("Q1 failing: ANSI colour codes do not hide a marker", () => {
    expect(failingLines("\x1b[31m\x1b[1m FAIL \x1b[22m\x1b[39m tests/c.test.ts")).toBe(" FAIL  tests/c.test.ts");
    expect(failingLines("   \x1b[31m×\x1b[39m adds")).toBe("   × adds");
  });

  it("Q1 failing: output with no marker gives no lines; a green check keeps none", async () => {
    expect(failingLines("all good\n1 passed")).toBe("");
    const green = await runCheck("echo 'FAIL looks bad'; exit 0", dir, 5000);
    expect(green.failing ?? "").toBe("");
    const red = await runCheck("echo nothing; exit 1", dir, 5000);
    expect(red.failing ?? "").toBe("");
  });

  it("Q1 failing: a timed-out check is unchanged", async () => {
    const r = await runCheck("echo 'FAIL x'; sleep 5", dir, 300);
    expect(r.timedOut).toBe(true);
    expect(r.failing ?? "").toBe("");
  });

  it("Q1 failing: verifyFailing reads the whole verify.log; a missing log gives an empty string", () => {
    mkdirSync(join(dir, ".claude/tmp/s1"), { recursive: true });
    const text = ["FAIL tests/v.test.ts > first", ...Array.from({ length: 80 }, (_, i) => `l${i}`)].join("\n");
    writeFileSync(join(dir, ".claude/tmp/s1/verify.log"), text);
    expect(verifyFailing(dir, "s1")).toBe("FAIL tests/v.test.ts > first");
    expect(verifyFailing(dir, "none")).toBe("");
  });
});

describe("globMatch", () => {
  it("v04 AC-19: * matches / like bash case", () => {
    expect(globMatch("*.ts", "src/a/b.ts")).toBe(true);
    expect(globMatch("*.ts", "src/a/b.js")).toBe(false);
    expect(globMatch("src/*", "src/a/b.ts")).toBe(true);
  });
  it("v04 AC-19: supports ? and bracket classes, escapes dots", () => {
    expect(globMatch("a?.ts", "ab.ts")).toBe(true);
    expect(globMatch("[ab].ts", "c.ts")).toBe(false);
    expect(globMatch("a.ts", "axts")).toBe(false);
  });
});

describe("lintRuns", () => {
  const mkFiles = () => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "src/a.ts"), "");
    writeFileSync(join(dir, "src/it's.ts"), "");
    writeFileSync(join(dir, "src/b.md"), "");
  };

  it("v04 AC-19: one quoted command per existing matching file", () => {
    mkFiles();
    const runs = lintRuns(
      "eslint {file}",
      ["src/a.ts", "src/it's.ts", "src/b.md", "src/gone.ts"],
      ["*.ts"],
      dir,
    );
    expect(runs).toEqual(["eslint './src/a.ts'", "eslint './src/it'\\''s.ts'"]);
  });

  it("v04 AC-19: a name starting with a dash gets ./ so it is not read as an option", () => {
    writeFileSync(join(dir, "--fix.ts"), "");
    expect(lintRuns("eslint {file}", ["--fix.ts"], ["*.ts"], dir)).toEqual(["eslint './--fix.ts'"]);
  });

  it("v04 AC-19: a quoted {file} placeholder is refused with RunError(1)", () => {
    for (const cmd of ["eslint '{file}'", 'eslint "{file}"']) {
      let thrown: unknown = null;
      try {
        lintRuns(cmd, ["a.ts"], ["*.ts"], dir);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(RunError);
      expect(thrown instanceof RunError ? thrown.exitCode : null).toBe(1);
    }
  });

  it("v04 AC-19: without {file} the command runs once", () => {
    expect(lintRuns("pnpm lint", ["a.ts", "b.ts"], ["*.ts"], dir)).toEqual(["pnpm lint"]);
  });

  it("v04 AC-56: an empty command gives no runs", () => {
    expect(lintRuns("", ["a.ts"], ["*.ts"], dir)).toEqual([]);
  });
});
