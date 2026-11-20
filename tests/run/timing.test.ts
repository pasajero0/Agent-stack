import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanupProjects } from "../hooks/fixture.js";
import { startRun } from "../../src/run/engine/index.js";
import { closeStep, estimateText, openStep, timeFacts, times } from "../../src/run/engine/timing.js";
import type { RunFile } from "../../src/run/types.js";
import { impl, makeFakeExecutable, repo, text } from "./engine-fixture.js";
import { plan, toPlanApprove } from "./engine-task-fixture.js";

beforeAll(makeFakeExecutable);
afterEach(() => cleanupProjects());

const at = (s: number): Date => new Date(Date.UTC(2026, 10, 20, 12, 0, s));
const bare = (): RunFile => ({ steps: [], estimateSec: null } as unknown as RunFile);

describe("step times (AC-81)", () => {
  it("v04 AC-81: a gate keeps its open entry across a resume; another step opens a new one", () => {
    const run = bare();
    openStep(run, "implement:T1", at(0));
    closeStep(run, at(90));
    openStep(run, "gate:accept", at(90));
    openStep(run, "gate:accept", at(200)); // the same gate, resumed in a new process
    expect(run.steps.length).toBe(2);
    closeStep(run, at(450));
    expect(times(run, at(500))).toEqual({ workSec: 90, waitSec: 360 });
  });

  it("v04 AC-81: gate:accept shows work, waiting, per step, per task and the estimate against the actual", () => {
    const run = bare();
    openStep(run, "base-check", at(0));
    closeStep(run, at(30));
    openStep(run, "implement:T1", at(30));
    closeStep(run, at(150));
    openStep(run, "checks:T1", at(150));
    closeStep(run, at(210));
    run.estimateSec = 180;
    expect(timeFacts(run, at(300))).toEqual([
      "time: 3:30 work + 0:00 waiting for you",
      "by step: base-check 0:30 · implement 2:00 · checks 1:00",
      "by task: T1 3:00",
      "estimate 3:00 → actual 3:30",
    ]);
    expect(estimateText(null)).toBe("estimate: none yet (no earlier runs)");
    expect(estimateText({ sec: 420, runs: 2 })).toBe("estimate: ≈ 7 min of work (from 2 earlier runs)");
  });
});

describe("step times in a run (AC-81)", () => {
  it("v04 AC-81: a quick run keeps every step's time and shows it at gate:accept; the next run is estimated", async () => {
    const r = repo();
    // The fake counts calls across both runs, so one script holds both.
    r.script([impl({ writes: { "README.md": "# demo\nfixed\n" } }), impl({ writes: { "README.md": "# demo\nfixed again\n" } })]);
    expect(await startRun({ ...r.opts({ gate: ["a"] }), mode: "quick", description: "Fix the README line." })).toBe(0);
    const first = r.run();
    expect(first.estimateSec).toBeNull();
    expect(first.steps.map((s) => s.step)).toEqual(["base-check", "implement:Q1", "checks:Q1", "commit:Q1", "gate:accept"]);
    expect(first.steps.every((s) => s.end !== null)).toBe(true);
    expect(text(r)).toMatch(/time: \d+:\d\d work \+ \d+:\d\d waiting for you/);
    expect(text(r)).toMatch(/by task: Q1 \d+:\d\d/);

    const second = await startRun({ ...r.opts({ gate: ["a"] }), mode: "quick", description: "Fix the README line again." });
    expect(second, text(r).slice(-600)).toBe(0);
    expect(r.run().estimateSec).not.toBeNull();
    expect(text(r)).toMatch(/estimate \d+:\d\d → actual \d+:\d\d/);
  });

  it("v04 AC-81: with no earlier run the plan card says there is no estimate yet", async () => {
    const r = repo();
    await toPlanApprove(r, [plan()]);
    expect(r.run().card?.facts).toContain("estimate: none yet (no earlier runs)");
    expect(r.run().estimateSec).toBeNull();
  });
});
