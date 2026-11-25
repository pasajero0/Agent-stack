/** effort1: an eval task.json may name a routing `cell`; each try then runs `run quick --cell <cell> <description>`. */
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { makeFakeExecutable } from "../run/engine-fixture.js";
import { runEval, tempDir } from "./helpers.js";

beforeAll(makeFakeExecutable);

const CELLS = "S·low, S·medium, S·high, M·low, M·medium, M·high, L·low, L·medium, L·high";

/** A tasks dir with one task `t1`; `extra` is merged into task.json. */
function tasksDir(check: string, extra: Record<string, unknown>): string {
  const dir = tempDir();
  const fixture = join(dir, "t1", "fixture");
  mkdirSync(fixture, { recursive: true });
  writeFileSync(join(fixture, "a.txt"), "a\n");
  writeFileSync(
    join(dir, "t1", "task.json"),
    JSON.stringify({ mode: "quick", description: "Change the a file", fixture: "fixture", check, expect: "gate:accept", ...extra }),
  );
  return dir;
}

/** One implement response; `model` and `effort` are what the fake claude must see on the route. */
function fakeScript(model: string | null, effort: string | null): string {
  const file = join(tempDir(), "script.json");
  const response: Record<string, unknown> = {
    expectRole: "implement",
    writes: { "a.txt": "b\n" },
    output: { status: "DONE", report: "changed a", commit: { type: "fix", subject: "Change the a file." }, needsHumanDecision: [] },
  };
  if (model !== null) response.expectModel = model;
  if (effort !== null) response.expectEffort = effort;
  writeFileSync(file, JSON.stringify([response]));
  return file;
}

/** The check copies the run file's `cell` into `<probe>/cell`; returns what the try wrote. */
const probeCheck = (probe: string): string => `cat .claude/tmp/runs/*/run.json > ${probe}/run.json`;

describe("effort1 AC-29: a task.json cell reaches run quick --cell", () => {
  it("effort1 AC-29: with cell S·high the fake claude sees implement on opus · high, and the run file holds the cell", () => {
    const probe = tempDir();
    const dir = tasksDir(probeCheck(probe), { cell: "S·high" });
    const r = runEval(["--tasks-dir", dir, "--k", "1", "--yes"], { fakeScript: fakeScript("opus", "high") });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toContain("t1 1/1: gate:accept · check 0 · pass");
    expect(JSON.parse(readFileSync(join(probe, "run.json"), "utf8")).cell).toBe("S·high");
  }, 60_000);

  it("effort1 AC-29: without cell the argv is as today: the run file has cell null", () => {
    const probe = tempDir();
    const dir = tasksDir(probeCheck(probe), {});
    const r = runEval(["--tasks-dir", dir, "--k", "1", "--yes"], { fakeScript: fakeScript(null, null) });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(probe, "run.json"), "utf8")).cell).toBeNull();
  }, 60_000);
});

describe("effort1 AC-32: a bad cell refuses the set", () => {
  for (const cell of ["S·max", "s·low", "S.low", "", 7, null]) {
    it(`effort1 AC-32: cell ${JSON.stringify(cell)} prints the line, exits 1 and runs no try`, () => {
      const probe = tempDir();
      const dir = tasksDir(`touch ${probe}/ran`, { cell });
      const r = runEval(["--tasks-dir", dir, "--k", "1", "--yes"], { fakeScript: fakeScript(null, null) });
      expect(r.code).toBe(1);
      expect(r.stderr.split("\n").filter((l) => l !== "")).toEqual([`t1/task.json: cell: must be one of ${CELLS}`]);
      expect(readdirSync(probe)).toEqual([]);
    }, 60_000);
  }
});
