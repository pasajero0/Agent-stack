/**
 * The gate:plan-approve card line and its source. Spec: docs/specs/effort1/SPEC.md (Contract "The plan-approve
 * card line"; AC-8, AC-21).
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupProjects, git, patchGates } from "../hooks/fixture.js";
import { resumeRun, startRun } from "../../src/run/engine/index.js";
import { sha256 } from "../../src/run/engine/card.js";
import { makeFakeExecutable, repo, text, type Json, type Repo } from "./engine-fixture.js";
import { clarify, mergeSpec, plan, spec, TASK_DESC, TASKS_PATH, type PlanTask } from "./engine-task-fixture.js";

beforeAll(makeFakeExecutable);
afterEach(() => cleanupProjects());

const SIX_AC = [
  "---",
  "stage: B1",
  "---",
  "",
  "# Greeting",
  "",
  "## Acceptance criteria",
  "",
  ...[1, 2, 3, 4, 5, 6].map((n) => `- **AC-${n}:** WHEN a thing happens, THE SYSTEM SHALL do thing ${n}.`),
  "",
].join("\n");

const TASKS: PlanTask[] = [
  { id: "T1", ac: ["AC-1", "AC-2", "AC-3"], tier: "M", complexity: "high", desc: "add the cache", verify: "test -f a.txt" },
  { id: "T2", ac: ["AC-4"], tier: "S", complexity: "low", desc: "check the token expiry", verify: "test -f b.txt" },
  { id: "T3", ac: ["AC-5", "AC-6"], tier: "L", complexity: "low", splitReason: "rename used\nby all\t modules\u0001x", desc: "rename getTotal", verify: "test -f c.txt" },
];

/** Start to gate:plan-approve (exit 3) with a six-criteria spec; `after` are the role calls after the spec. */
async function toGate(r: Repo, after: Json[]): Promise<void> {
  r.script([clarify(), spec({ writes: { "docs/specs/B1/SPEC.md": SIX_AC } }), ...after]);
  expect(await startRun({ ...r.opts({ gate: ["", "", ""] }), mode: "task", description: TASK_DESC }), text(r)).toBe(3);
  mergeSpec(r);
  expect(await resumeRun({ ...r.opts() }), text(r)).toBe(3);
}

describe("plan-approve card line", () => {
  it("effort1 AC-8: the card line shows tier, complexity, route, risky and not split, as the Contract's examples", async () => {
    const r = repo();
    await toGate(r, [plan({ tasks: TASKS })]);
    const facts = r.run().card?.facts ?? [];
    expect(facts).toContain("T1  M · high -> opus · high · AC-1,2,3   add the cache");
    expect(facts).toContain("T2  S · low -> opus · high · risky · AC-4   check the token expiry");
    expect(facts).toContain("T3  L · low -> sonnet · medium · not split: rename used by all modules?x · AC-5,6   rename getTotal");
  });
});

describe("plan-approve card source", () => {
  it("effort1 AC-21: a routing edit while the gate waits refuses --answer a and shows the new routes; a reject keeps the tasks.json planSha256", async () => {
    const r = repo();
    await toGate(r, [plan({ tasks: TASKS }), plan({ tasks: TASKS })]);
    const old = r.run().card?.source;
    const tasksText = readFileSync(join(r.dir, TASKS_PATH), "utf8");
    const routes = ["sonnet·low", "sonnet·medium", "opus·high", "sonnet·low", "sonnet·medium", "opus·high", "sonnet·medium", "opus·medium", "opus·high", "opus·high", "opus·high"];
    expect(old).toBe(sha256(`${tasksText}\n${routes.join("\n")}`));

    const gates = JSON.parse(readFileSync(join(r.dir, ".claude/gates.json"), "utf8")) as { routing: Record<string, Record<string, string>> };
    patchGates(r.dir, { routing: { ...gates.routing, M: { ...gates.routing["M"], high: "haiku·low" } } });
    // The resume wants a clean tree.
    git(r.dir, "commit", "-qam", "edit routing");
    expect(await resumeRun({ ...r.opts(), answers: ["a"] })).toBe(1);
    expect(text(r)).toContain("The gate changed since its card was shown");
    const run = r.run();
    expect(run.next).toBe("gate:plan-approve");
    expect(run.card?.source).not.toBe(old);
    expect(run.card?.facts).toContain("T1  M · high -> haiku · low · AC-1,2,3   add the cache");
    expect(run.gates.at(-1)?.decision).not.toBe("approve");

    expect(await resumeRun({ ...r.opts({ gate: ["r", "redo", "c"] }) }), text(r)).toBe(0);
    const reject = r.run().gates.find((g) => g.decision === "reject");
    expect(reject?.planSha256).toBe(sha256(tasksText));
  });
});
