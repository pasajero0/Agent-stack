import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupProjects } from "../hooks/fixture.js";
import { parsePlan } from "../../src/run/engine/plan-file.js";
import { roleSchemas } from "../../src/run/schemas.js";
import { makeFakeExecutable, repo, text } from "./engine-fixture.js";
import { plan, TASKS_PATH, toPlanApprove, toSpecMerge, mergeSpec } from "./engine-task-fixture.js";
import { resumeRun } from "../../src/run/engine/index.js";

beforeAll(makeFakeExecutable);
afterEach(() => cleanupProjects());

const SPEC = "- **AC-1:** x\n";
const task = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "T1",
  ac: ["AC-1"],
  tier: "S",
  complexity: "low",
  desc: "d",
  verify: "test -f a",
  passes: false,
  ...over,
});
const planOf = (t: Record<string, unknown>): string => JSON.stringify({ stage: "A1", tasks: [t] });

describe("plan role: complexity and splitReason", () => {
  it("effort1 AC-6: the plan schema requires complexity (low, medium, high) and takes an optional string splitReason", () => {
    const items = (roleSchemas.plan.properties["tasks"] as { items: { required: string[]; properties: Record<string, unknown> } }).items;
    expect(items.required).toContain("complexity");
    expect(items.required).not.toContain("splitReason");
    expect(items.properties["complexity"]).toEqual({ enum: ["low", "medium", "high"] });
    expect(items.properties["splitReason"]).toEqual({ type: "string" });
  });

  it("effort1 AC-6: a task with a valid complexity is accepted; splitReason is kept trimmed for L and dropped for S and M", () => {
    const l = parsePlan(planOf(task({ tier: "L", complexity: "high", splitReason: "  one change, no seam  " })), SPEC);
    expect(l).toMatchObject([{ tier: "L", complexity: "high", splitReason: "one change, no seam" }]);
    const s = parsePlan(planOf(task({ splitReason: "not needed" })), SPEC);
    expect(s).toMatchObject([{ complexity: "low" }]);
    expect(Array.isArray(s) && s[0] && "splitReason" in s[0]).toBe(false);
  });

  it("effort1 AC-14: a task without a valid complexity is refused, naming the task", () => {
    const msg = "task T1 needs a complexity of low, medium or high";
    expect(parsePlan(planOf(task({ complexity: undefined })), SPEC)).toBe(msg);
    expect(parsePlan(planOf(task({ complexity: "huge" })), SPEC)).toBe(msg);
  });

  it("effort1 AC-14: an L task without splitReason, or with an empty one, is refused", () => {
    const msg = "task T1 is tier L and needs a splitReason: why it is not split";
    expect(parsePlan(planOf(task({ tier: "L" })), SPEC)).toBe(msg);
    expect(parsePlan(planOf(task({ tier: "L", splitReason: "   " })), SPEC)).toBe(msg);
  });

  it("effort1 AC-14: a splitReason longer than 80 characters after trim is refused; 80 is accepted", () => {
    const msg = "task T1: splitReason must be at most 80 characters";
    expect(parsePlan(planOf(task({ tier: "L", splitReason: "x".repeat(81) })), SPEC)).toBe(msg);
    expect(typeof parsePlan(planOf(task({ tier: "L", splitReason: ` ${"x".repeat(80)} ` })), SPEC)).toBe("object");
  });

  it("effort1 AC-6: through the engine, tasks.json gets complexity for every task and splitReason for L tasks only", async () => {
    const r = repo();
    const tasks = [
      { id: "T1", ac: ["AC-1"], tier: "L" as const, complexity: "high" as const, splitReason: "  one seam  ", verify: "test -f hello.txt" },
      { id: "T2", ac: ["AC-2"], tier: "S" as const, complexity: "low" as const, splitReason: "dropped", verify: "test -f bye.txt" },
    ];
    await toPlanApprove(r, [plan({ tasks })]);
    const file = JSON.parse(readFileSync(join(r.dir, TASKS_PATH), "utf8")) as { tasks: Record<string, unknown>[] };
    expect(file.tasks[0]).toMatchObject({ id: "T1", complexity: "high", splitReason: "one seam" });
    expect(file.tasks[1]).toMatchObject({ id: "T2", complexity: "low" });
    expect(file.tasks[1]).not.toHaveProperty("splitReason");
  });

  it("effort1 AC-14: through the engine, an output without complexity is undone and plan runs once more", async () => {
    const r = repo();
    const bad = [
      { id: "T1", ac: ["AC-1"], tier: "S", desc: "a", verify: "test -f hello.txt", passes: false },
      { id: "T2", ac: ["AC-2"], tier: "S", complexity: "low", desc: "b", verify: "test -f bye.txt", passes: false },
    ];
    await toSpecMerge(r, [plan({ raw: bad }), plan()]);
    mergeSpec(r);
    expect(await resumeRun({ ...r.opts() }), text(r)).toBe(3);
    expect(r.run().next).toBe("gate:plan-approve");
    expect(r.logged().length).toBe(5);
    expect(r.logged()[4]?.prompt).toContain("task T1 needs a complexity of low, medium or high");
  });
});
