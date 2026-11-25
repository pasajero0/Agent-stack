/**
 * effort1: implement takes its model and effort from the routing in gates.json; the argv and the head line show them.
 * Spec: docs/specs/effort1/SPEC.md (AC-2, AC-3, AC-4, AC-5, AC-7, AC-13, AC-17, AC-18, AC-24).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { newTask, type TaskInfo } from "../../src/run/engine/context.js";
import { resumeRun, startRun } from "../../src/run/engine/index.js";
import { implementRoute } from "../../src/run/engine/steps-implement.js";
import { COMPLEXITIES, TIERS, type Routing } from "../../src/run/routing.js";
import { runDir } from "../../src/run/store.js";
import { cleanupProjects, write } from "../hooks/fixture.js";
import { DESC, FAKE, impl, makeFakeExecutable, repo, review, text, type Json, type Repo } from "./engine-fixture.js";
import { plan, toPlanApprove, type PlanTask } from "./engine-task-fixture.js";

beforeAll(makeFakeExecutable);
afterEach(() => cleanupProjects());

/** A routing with a different route in every cell, and retry and risky unlike any cell, so a test can tell them apart. */
const ROUTING: Routing = {
  S: { low: "sonnet·low", medium: "sonnet·medium", high: "sonnet·high" },
  M: { low: "haiku·low", medium: "haiku·medium", high: "haiku·high" },
  L: { low: "sonnet·xhigh", medium: "opus·medium", high: "opus·low" },
  retry: "opus·xhigh",
  risky: "opus·max",
  scout: "haiku·low",
};

/** An implement response that checks the model and the effort of its call. */
const call = (model: string, effort: string, o: Parameters<typeof impl>[0] = {}): Json => ({
  ...impl(o),
  expectModel: model,
  expectEffort: effort,
});

const newRepo = (o: { test?: string } = {}): Repo => repo({ ...o, extra: { routing: ROUTING } });

/** Task mode up to the plan gate, then approve and run the scripted calls; returns the exit code. */
async function taskRun(r: Repo, tasks: PlanTask[], rest: Json[], gate: string[] = ["a", "a"]): Promise<number> {
  // One script: the fake's call counter runs on across `r.script` calls.
  await toPlanApprove(r, [plan({ tasks }), ...rest]);
  return resumeRun({ ...r.opts({ gate }) });
}

const isImplement = (prompt: string): boolean => prompt.trimStart().startsWith("# Role: implement");

const ONE = (o: Partial<PlanTask>): PlanTask[] => [
  { id: "T1", ac: ["AC-1", "AC-2"], tier: "S", complexity: "low", desc: "create the hello file", verify: "test -f hello.txt", ...o },
];

const info = (o: Partial<TaskInfo>): TaskInfo => ({
  id: "T1",
  desc: "create the hello file",
  criteria: [],
  tier: "S",
  complexity: "low",
  risky: false,
  fix: false,
  verify: "test -f hello.txt",
  ...o,
});

describe("implement route: the order of the rules", () => {
  it("effort1 AC-2: the first attempt of a plan task that is not risky uses routing.<tier>.<complexity>, for all 9 cells", () => {
    for (const tier of TIERS) {
      for (const complexity of COMPLEXITIES) {
        const [model, effort] = ROUTING[tier][complexity].split("·");
        expect(implementRoute(ROUTING, info({ tier, complexity }), { ...newTask("T1"), attempts: 1 }), `${tier}·${complexity}`).toEqual({ model, effort });
      }
    }
  });

  it("effort1 AC-3: an attempt after the first, or a fix task, uses the retry route whatever the tier, complexity or risk", () => {
    for (const tier of TIERS) {
      for (const complexity of COMPLEXITIES) {
        for (const risky of [false, true]) {
          const i = info({ tier, complexity, risky });
          expect(implementRoute(ROUTING, i, { ...newTask("T1"), attempts: 2 })).toEqual({ model: "opus", effort: "xhigh" });
          expect(implementRoute(ROUTING, { ...i, id: "F1", fix: true }, { ...newTask("F1"), attempts: 1 })).toEqual({ model: "opus", effort: "xhigh" });
        }
      }
    }
  });

  it("effort1 AC-4: the first attempt of a risky task of any tier uses the risky route", () => {
    for (const tier of TIERS) {
      for (const complexity of COMPLEXITIES) {
        expect(implementRoute(ROUTING, info({ tier, complexity, risky: true }), { ...newTask("T1"), attempts: 1 })).toEqual({ model: "opus", effort: "max" });
      }
    }
  });

  it("effort1 AC-18: a risky task on an attempt after the first uses the retry route, not the risky route", () => {
    expect(implementRoute(ROUTING, info({ tier: "L", risky: true }), { ...newTask("T1"), attempts: 2 })).toEqual({ model: "opus", effort: "xhigh" });
  });
});

describe("implement route in a run", () => {
  it("effort1 AC-2: a plan task uses the cell of its tier and complexity (S·low, M·high)", async () => {
    const r = newRepo();
    const tasks: PlanTask[] = [
      { id: "T1", ac: ["AC-1"], tier: "S", complexity: "low", desc: "create the hello file", verify: "test -f hello.txt" },
      { id: "T2", ac: ["AC-2"], tier: "M", complexity: "high", desc: "create the bye file", verify: "test -f bye.txt" },
    ];
    const code = await taskRun(r, tasks, [
      call("sonnet", "low", { writes: { "hello.txt": "hello\n" } }),
      review(),
      call("haiku", "high", { writes: { "bye.txt": "bye\n" } }),
      review(),
    ]);
    expect(code, text(r)).toBe(0);
    expect(text(r)).toContain("-> implement:T1 · implement · sonnet · low · call ");
    expect(text(r)).toContain("-> implement:T2 · implement · haiku · high · call ");
  });

  it("effort1 AC-2: L·low and L·medium use their own cells", async () => {
    for (const [complexity, model, effort] of [
      ["low", "sonnet", "xhigh"],
      ["medium", "opus", "medium"],
    ] as const) {
      const r = newRepo();
      const code = await taskRun(r, ONE({ tier: "L", complexity }), [call(model, effort, { writes: { "hello.txt": "hello\n" } }), review()]);
      expect(code, text(r)).toBe(0);
      expect(text(r)).toContain(`-> implement:T1 · implement · ${model} · ${effort} · call `);
    }
  });

  it("effort1 AC-4: with the default routing a risky L·low task runs on opus · high, not sonnet · medium", async () => {
    const r = repo();
    const code = await taskRun(r, ONE({ tier: "L", complexity: "low", desc: "harden the security of the hello file" }), [
      call("opus", "high", { writes: { "hello.txt": "hello\n" } }),
      review(),
    ]);
    expect(code, text(r)).toBe(0);
    expect(text(r)).toContain("-> implement:T1 · implement · opus · high · call ");
    // The same L·low task without a risk word gets its cell, sonnet · medium.
    const plain = repo();
    const c2 = await taskRun(plain, ONE({ tier: "L", complexity: "low" }), [call("sonnet", "medium", { writes: { "hello.txt": "hello\n" } }), review()]);
    expect(c2, text(plain)).toBe(0);
  });

  it("effort1 AC-4: a risky L·low task uses the risky route, not its cell", async () => {
    const r = newRepo();
    const code = await taskRun(r, ONE({ tier: "L", complexity: "low", desc: "harden the security of the hello file" }), [
      call("opus", "max", { writes: { "hello.txt": "hello\n" } }),
      review(),
    ]);
    expect(code, text(r)).toBe(0);
    expect(text(r)).toContain("-> implement:T1 · implement · opus · max · call ");
  });

  it("effort1 AC-18: a risky task on its second attempt uses the retry route", async () => {
    const r = newRepo();
    const code = await taskRun(r, ONE({ tier: "M", complexity: "medium", desc: "harden the security of the hello file" }), [
      call("opus", "max"),
      call("opus", "xhigh", { writes: { "hello.txt": "hello\n" } }),
      review(),
    ]);
    expect(code, text(r)).toBe(0);
    expect(r.run().tasks[0]?.attempts).toBe(2);
    expect(text(r)).toContain("-> implement:T1 · implement · opus · max · call ");
    expect(text(r)).toContain("-> implement:T1 · implement · opus · xhigh · call ");
  });

  it("effort1 AC-3: every attempt after the first uses the retry route, whatever the cell", async () => {
    const r = newRepo();
    const code = await taskRun(r, ONE({}), [call("sonnet", "low"), call("opus", "xhigh", { writes: { "hello.txt": "hello\n" } }), review()]);
    expect(code, text(r)).toBe(0);
    expect(r.run().tasks[0]?.attempts).toBe(2);
  });

  it("effort1 AC-3: a fix task in task mode uses the retry route", async () => {
    const r = newRepo();
    const code = await taskRun(
      r,
      ONE({}),
      [
        call("sonnet", "low", { writes: { "hello.txt": "hello\n" } }),
        review(),
        call("opus", "xhigh", { writes: { "hello.txt": "hello!\n" } }),
        review(),
      ],
      ["a", "r make it louder", "a"]
    );
    expect(code, text(r)).toBe(0);
    expect(text(r)).toContain("-> implement:F1 · implement · opus · xhigh · call ");
  });

  it("effort1 AC-17: a fix task in quick mode uses the retry route, never a cell or the risky route", async () => {
    const r = newRepo();
    r.script([
      call("haiku", "medium", { writes: { "README.md": "# demo\nfixed\n" } }),
      call("opus", "xhigh", { writes: { "README.md": "# demo\nfixed security\n" } }),
    ]);
    const code = await startRun({ ...r.opts({ gate: ["r fix the security line too", "a"] }), mode: "quick", description: DESC });
    expect(code, text(r)).toBe(0);
    expect(text(r)).toContain("-> implement:F1 · implement · opus · xhigh · call ");
  });

  it("effort1 AC-17: Q1 is never risky, even when its description has a risk word", async () => {
    const r = newRepo();
    r.script([call("haiku", "medium", { writes: { "README.md": "# demo\nfixed\n" } })]);
    const code = await startRun({ ...r.opts({ gate: ["a"] }), mode: "quick", description: "Fix the security line in the README" });
    expect(code, text(r)).toBe(0);
    expect(text(r)).toContain("-> implement:Q1 · implement · haiku · medium · call ");
  });

  for (const [name, edit] of [
    ["cell null", (f: Json): void => void (f["cell"] = null)],
    ["no cell key (a 0.4.7 run file)", (f: Json): void => void delete f["cell"]],
  ] as const) {
    it(`effort1 AC-5: Q1 of a quick run resumed with ${name} uses the cell M·medium`, async () => {
      const r = newRepo({ test: "test -f .git/base-ok" });
      // base-check fails, so the run stops before Q1's first attempt.
      expect(await startRun({ ...r.opts(), mode: "quick", description: DESC })).toBe(1);
      const path = join(runDir(r.dir, r.run().id), "run.json");
      const file = JSON.parse(readFileSync(path, "utf8")) as Json;
      edit(file);
      writeFileSync(path, JSON.stringify(file, null, 2) + "\n");
      write(r.dir, ".git/base-ok", "1");
      r.script([call("haiku", "medium", { writes: { "README.md": "# demo\nfixed\n" } })]);
      const code = await resumeRun({ ...r.opts({ gate: ["a"] }) });
      expect(code, text(r)).toBe(0);
      expect(text(r)).toContain("-> implement:Q1 · implement · haiku · medium · call ");
    });
  }

  it("effort1 AC-7: the argv has --effort right after --model, and the head line shows both on stdout and in progress.log", async () => {
    const r = newRepo();
    r.script([call("haiku", "medium", { writes: { "README.md": "# demo\nfixed\n" } })]);
    const code = await startRun({ ...r.opts({ gate: ["a"] }), mode: "quick", description: DESC });
    expect(code, text(r)).toBe(0);
    const argv = r.logged().find((c) => isImplement(c.prompt))?.argv ?? [];
    const i = argv.indexOf("--model");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(argv.slice(i, i + 4)).toEqual(["--model", "haiku", "--effort", "medium"]);
    const head = /-> implement:Q1 · implement · haiku · medium · call 1\/\d+ \.\.\./;
    expect(text(r)).toMatch(head);
    expect(readFileSync(join(runDir(r.dir, r.run().id), "progress.log"), "utf8")).toMatch(head);
  });

  it("effort1 AC-7: in task mode the argv of implement has --effort right after --model", async () => {
    const r = newRepo();
    const code = await taskRun(r, ONE({ tier: "S", complexity: "high" }), [call("sonnet", "high", { writes: { "hello.txt": "hello\n" } }), review()]);
    expect(code, text(r)).toBe(0);
    const argv = r.logged().find((c) => isImplement(c.prompt))?.argv ?? [];
    const i = argv.indexOf("--model");
    expect(argv.slice(i, i + 4)).toEqual(["--model", "sonnet", "--effort", "high"]);
  });

  it("effort1 AC-13: clarify, spec, plan and review pass no --effort and keep --model opus", async () => {
    const r = newRepo();
    const code = await taskRun(r, ONE({}), [call("sonnet", "low", { writes: { "hello.txt": "hello\n" } }), review()]);
    expect(code, text(r)).toBe(0);
    const others = r.logged().filter((c) => !isImplement(c.prompt));
    const roles = others.map((c) => /# Role: (\w+)/.exec(c.prompt)?.[1]);
    for (const role of ["spec", "plan", "review"]) expect(roles).toContain(role);
    for (const c of others) {
      expect(c.argv).not.toContain("--effort");
      expect(c.argv[c.argv.indexOf("--model") + 1]).toBe("opus");
    }
  });
});

describe("the fake claude checks --effort (effort1 AC-24)", () => {
  /** Runs the fake once with one scripted response; returns its exit code. */
  function fake(response: Json, args: string[], prompt: string): number | null {
    const dir = mkdtempSync(join(tmpdir(), "fake-effort-"));
    const script = join(dir, "script.json");
    writeFileSync(script, JSON.stringify([response]));
    const env = { ...process.env, FAKE_CLAUDE_SCRIPT: script };
    delete env["FAKE_CLAUDE_LOG"];
    return spawnSync(process.execPath, [FAKE, ...args], { cwd: dir, env, input: prompt }).status;
  }
  const IMPL = "# Role: implement\n";
  const REVIEW = "# Role: review\n";

  it("effort1 AC-24: expectEffort exits 9 unless --effort equals it", () => {
    const r = { expectRole: "implement", expectModel: "sonnet", expectEffort: "high", output: {} };
    expect(fake(r, ["--model", "sonnet", "--effort", "high"], IMPL)).toBe(0);
    expect(fake(r, ["--model", "sonnet", "--effort", "medium"], IMPL)).toBe(9);
    expect(fake(r, ["--model", "sonnet"], IMPL)).toBe(9);
  });

  it("effort1 AC-24: a role other than implement exits 9 when --effort is present", () => {
    const r = { expectRole: "review", output: {} };
    expect(fake(r, ["--model", "opus"], REVIEW)).toBe(0);
    expect(fake(r, ["--model", "opus", "--effort", "high"], REVIEW)).toBe(9);
  });

  it("effort1 AC-24: an engine run with a wrong --effort fails", async () => {
    const r = newRepo();
    r.script([call("haiku", "high", { writes: { "README.md": "# demo\nfixed\n" } })]);
    const code = await startRun({ ...r.opts({ gate: ["a"] }), mode: "quick", description: DESC });
    expect(code, text(r)).not.toBe(0);
  });
});
