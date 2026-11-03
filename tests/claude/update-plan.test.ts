import { afterAll, describe, expect, it } from "vitest";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildHarnessFiles, planUpdate } from "../../src/claude/harness.js";
import { cleanupProjects, deployHarness, TS_PARAMS } from "../hooks/fixture.js";

afterAll(cleanupProjects);

describe("planUpdate", () => {
  it("re-running on an untouched harness changes nothing", () => {
    const dir = deployHarness();
    const plan = planUpdate(dir, buildHarnessFiles(TS_PARAMS));
    expect(plan.toWrite).toEqual([]);
    expect(plan.changed).toEqual([]);
  });

  it("keeps the user's seed files and restores emitter-owned ones", () => {
    const dir = deployHarness();
    writeFileSync(join(dir, "CLAUDE.md"), "# my own guide\n");
    writeFileSync(join(dir, ".claude/gates.json"), '{"mode":"autonomous"}\n');
    writeFileSync(join(dir, ".claude/hooks/guard-bash.sh"), "#!/bin/sh\nexit 0\n");

    const plan = planUpdate(dir, buildHarnessFiles(TS_PARAMS));
    expect(plan.kept).toEqual(expect.arrayContaining(["CLAUDE.md", ".claude/gates.json"]));
    expect(plan.changed).toEqual([".claude/hooks/guard-bash.sh"]);
    expect(plan.toWrite.map((f) => f.path)).toEqual([".claude/hooks/guard-bash.sh"]);
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf-8")).toBe("# my own guide\n");
  });
});
