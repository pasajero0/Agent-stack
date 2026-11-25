/**
 * effort1: `run quick --cell <tier>·<complexity>` picks the routing cell of Q1, and the run file keeps it as `cell`.
 * Spec: docs/specs/effort1/SPEC.md (AC-28, AC-30, AC-31), Contract "run quick --cell" and "Run file field cell".
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { runCommand, type RunOptions } from "../../src/commands/run.js";
import { resumeRun, startRun } from "../../src/run/engine/index.js";
import type { Routing } from "../../src/run/routing.js";
import { runDir } from "../../src/run/store.js";
import { cleanupProjects, write } from "../hooks/fixture.js";
import { DEAD_PID, DESC, impl, makeFakeExecutable, repo, sh, text, type Json, type Repo } from "./engine-fixture.js";
import { toSpecMerge } from "./engine-task-fixture.js";

beforeAll(makeFakeExecutable);
afterEach(() => cleanupProjects());

/** Every cell, retry and risky differ, so a test can tell them apart. */
const ROUTING: Routing = {
  S: { low: "sonnet·low", medium: "sonnet·medium", high: "sonnet·high" },
  M: { low: "haiku·low", medium: "haiku·medium", high: "haiku·high" },
  L: { low: "sonnet·xhigh", medium: "opus·medium", high: "opus·low" },
  retry: "opus·xhigh",
  risky: "opus·max",
};

const call = (model: string, effort: string, o: Parameters<typeof impl>[0] = {}): Json => ({ ...impl(o), expectModel: model, expectEffort: effort });

const FIXED = { "README.md": "# demo\nfixed\n" };

const runJson = (r: Repo): string => join(runDir(r.dir, r.run().id), "run.json");

/** A quick run whose base-check fails, so it stops before Q1's first attempt; `.git/base-ok` lets it pass later. */
const stopsAtBaseCheck = (extra: Json = {}): Repo => repo({ test: "test -f .git/base-ok", extra });

describe("effort1 AC-28: --cell picks the cell of Q1", () => {
  it("effort1 AC-28: with the default routing --cell S·high runs Q1 on opus · high and writes the cell", async () => {
    const r = repo();
    r.script([call("opus", "high", { writes: FIXED })]);
    const code = await startRun({ ...r.opts({ gate: ["a"] }), mode: "quick", description: DESC, cell: "S·high" });
    expect(code, text(r)).toBe(0);
    expect(text(r)).toContain("-> implement:Q1 · implement · opus · high · call ");
    expect(JSON.parse(readFileSync(runJson(r), "utf8")).cell).toBe("S·high");
  });

  it("effort1 AC-28: run quick --cell L·low writes the cell, and --resume keeps it: Q1 runs on sonnet · medium", async () => {
    const r = stopsAtBaseCheck();
    const out: string[] = [];
    expect(await runCommand("quick", DESC, { cell: "L·low" }, { projectDir: r.dir, out: (l) => out.push(l) }), out.join("\n")).toBe(1);
    expect(JSON.parse(readFileSync(runJson(r), "utf8")).cell).toBe("L·low");
    // runCommand locked the run with this test's own pid, which is alive; a dead pid makes it interrupted.
    writeFileSync(join(r.dir, ".claude", "tmp", "runs", "lock"), JSON.stringify({ id: r.run().id, pid: DEAD_PID }));
    write(r.dir, ".git/base-ok", "1");
    r.script([call("sonnet", "medium", { writes: FIXED })]);
    const code = await resumeRun({ ...r.opts({ gate: ["a"] }) });
    expect(code, text(r)).toBe(0);
    expect(text(r)).toContain("-> implement:Q1 · implement · sonnet · medium · call ");
    expect(r.run().cell).toBe("L·low");
  });

  it("effort1 AC-28: a run without --cell writes cell null, quick and task", async () => {
    const q = stopsAtBaseCheck();
    expect(await startRun({ ...q.opts(), mode: "quick", description: DESC })).toBe(1);
    expect(JSON.parse(readFileSync(runJson(q), "utf8"))).toHaveProperty("cell", null);
    const t = repo();
    await toSpecMerge(t);
    expect(JSON.parse(readFileSync(runJson(t), "utf8"))).toHaveProperty("cell", null);
  });

  it("effort1 AC-28: a retry of Q1 and a fix task use the retry route, not the cell", async () => {
    // The first attempt writes bad.txt, so the test check is red and Q1 gets a second attempt.
    const r = repo({ test: "test ! -f bad.txt", extra: { routing: ROUTING } });
    r.script([
      call("sonnet", "xhigh", { writes: { "bad.txt": "x\n" } }),
      call("opus", "xhigh", { writes: FIXED, deletes: ["bad.txt"] }),
      call("opus", "xhigh", { writes: { "README.md": "# demo\nfixed twice\n" } }),
    ]);
    const code = await startRun({ ...r.opts({ gate: ["r say it twice", "a"] }), mode: "quick", description: DESC, cell: "L·low" });
    expect(code, text(r)).toBe(0);
    expect(r.run().tasks[0]?.attempts).toBe(2);
    expect(text(r)).toContain("-> implement:Q1 · implement · sonnet · xhigh · call ");
    expect(text(r)).toContain("-> implement:Q1 · implement · opus · xhigh · call ");
    expect(text(r)).toContain("-> implement:F1 · implement · opus · xhigh · call ");
  });
});

describe("effort1 AC-30: a bad --cell is refused before anything is written", () => {
  const CELL_LINE = "--cell must be one of S·low, S·medium, S·high, M·low, M·medium, M·high, L·low, L·medium, L·high; got ";
  const QUICK_ONLY = "--cell applies to run quick only.";

  /** Runs the command; checks exit 1, the one line, and no run folder, branch or lock. */
  async function refused(mode: string | undefined, options: RunOptions, line: string): Promise<void> {
    const r = repo();
    const out: string[] = [];
    const code = await runCommand(mode, mode === undefined ? undefined : DESC, options, { projectDir: r.dir, out: (l) => out.push(l) });
    expect(code).toBe(1);
    expect(out).toEqual([line]);
    expect(existsSync(join(r.dir, ".claude", "tmp", "runs"))).toBe(false);
    expect(sh(r.dir, "branch", "--list")).toBe("* main");
  }

  for (const value of ["L.low", "l·low", "L·LOW", "M·max", "", "L·low "]) {
    it(`effort1 AC-30: run quick --cell ${JSON.stringify(value)} prints the 9 names`, async () => {
      await refused("quick", { cell: value }, `${CELL_LINE}${JSON.stringify(value)}.`);
    });
  }

  it("effort1 AC-30: a control character in the value shows as ?", async () => {
    await refused("quick", { cell: "L·low\u009b2J" }, `${CELL_LINE}"L·low?2J".`);
  });

  it("effort1 AC-30: --cell with run task is refused, also with a bad value", async () => {
    await refused("task", { cell: "L·low" }, QUICK_ONLY);
    await refused("task", { cell: "L.low" }, QUICK_ONLY);
  });

  for (const [flag, options] of [
    ["--resume", { resume: true }],
    ["--resume <id>", { resume: "r-20261118-120000" }],
    ["--status", { status: true }],
    ["--cancel", { cancel: true }],
    ["--watch", { watch: true }],
    ["--stats", { stats: true }],
  ] as const) {
    it(`effort1 AC-30: --cell with ${flag} is refused`, async () => {
      await refused(undefined, { ...options, cell: "L·low" }, QUICK_ONLY);
    });
  }

  it("effort1 AC-30: no mode and an unknown mode keep their own lines", async () => {
    const r = repo();
    const out: string[] = [];
    expect(await runCommand("fast", DESC, { cell: "L·low" }, { projectDir: r.dir, out: (l) => out.push(l) })).toBe(1);
    expect(out).toEqual(['Unknown mode "fast": use quick or task.']);
  });
});

describe("effort1 AC-31: a bad cell in the run file is malformed", () => {
  /** Puts `cell` into the run file, resumes, and checks exit 1, the line and an unchanged run file. */
  async function malformed(r: Repo, cell: unknown): Promise<void> {
    const path = runJson(r);
    const file = JSON.parse(readFileSync(path, "utf8")) as Json;
    file["cell"] = cell;
    const before = JSON.stringify(file, null, 2) + "\n";
    writeFileSync(path, before);
    write(r.dir, ".git/base-ok", "1");
    r.script([call("haiku", "medium", { writes: FIXED })]);
    const code = await resumeRun({ ...r.opts({ gate: ["a"] }) });
    expect(code, text(r)).toBe(1);
    expect(text(r)).toContain("run.json is malformed: cell");
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(text(r)).not.toContain("-> implement:Q1");
  }

  for (const cell of ["L.low", "l·low", "M·max", 7, true, {}]) {
    it(`effort1 AC-31: a quick run file with cell ${JSON.stringify(cell)} is malformed, not M·medium`, async () => {
      const r = stopsAtBaseCheck({ routing: ROUTING });
      expect(await startRun({ ...r.opts(), mode: "quick", description: DESC })).toBe(1);
      await malformed(r, cell);
    });
  }

  it("effort1 AC-31: a task run file with a valid cell is malformed", async () => {
    const r = repo();
    await toSpecMerge(r);
    await malformed(r, "L·low");
  });
});
