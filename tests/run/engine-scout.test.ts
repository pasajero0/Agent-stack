/**
 * scout1: the scout step on its happy path — a task run starts at scout, one call on routing.scout, the scout map
 * written by rename, and the resumes that make no scout call. Spec: docs/specs/scout1/SPEC.md (AC-1, AC-2, AC-3,
 * AC-4, AC-6, AC-19, AC-20).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanupProjects, write } from "../hooks/fixture.js";
import { resumeRun, startRun } from "../../src/run/engine/index.js";
import { roleSchemas } from "../../src/run/schemas.js";
import { runDir } from "../../src/run/store.js";
import { impl, makeFakeExecutable, repo, sh, text, type Json, type LoggedCall, type Repo } from "./engine-fixture.js";
import { clarify, patchRun, scout, TASK_DESC } from "./engine-task-fixture.js";

beforeAll(makeFakeExecutable);
afterEach(() => cleanupProjects());

const roleOf = (c: LoggedCall): string => (c.prompt.split("\n").find((l) => l.trim() !== "") ?? "").replace("# Role: ", "");
const roles = (r: Repo): string[] => r.logged().map(roleOf);
const valueAfter = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const scoutFile = (r: Repo): string => join(runDir(r.dir, r.run().id), "scout.md");

/** Starts a task run that stops at gate:answers (no gate input): scout, then clarify. */
async function toAnswers(r: Repo, first: Json = scout()): Promise<void> {
  r.script([first, clarify(), clarify()]);
  expect(await startRun({ ...r.opts(), mode: "task", description: TASK_DESC }), text(r)).toBe(3);
}

describe("the scout step starts a task run (scout1 AC-1)", () => {
  it("scout1 AC-1: run task makes scout its first step and call, before clarify", async () => {
    const r = repo();
    await toAnswers(r);
    expect(roles(r)).toEqual(["scout", "clarify"]);
    const run = r.run();
    expect(run.steps.map((s) => s.step).slice(0, 2)).toEqual(["scout", "clarify"]);
    expect(run.next).toBe("gate:answers");
  });

  it("scout1 AC-1: run quick makes no scout step and no scout call", async () => {
    const r = repo();
    r.script([impl({ writes: { "README.md": "# demo\nfixed\n" } })]);
    expect(await startRun({ ...r.opts({ gate: ["a"] }), mode: "quick", description: "Fix the README line" }), text(r)).toBe(0);
    expect(r.logged()).toHaveLength(1);
    expect(roles(r)).not.toContain("scout");
    const run = r.run();
    expect(run.steps.map((s) => s.step)).not.toContain("scout");
    expect(existsSync(join(runDir(r.dir, run.id), "scout.md"))).toBe(false);
    expect(text(r)).not.toContain("scout");
  });
});

describe("the scout call (scout1 AC-2, AC-3)", () => {
  it("scout1 AC-2: the argv has routing.scout's model and effort, read-only tools, default mode and the scout schema", async () => {
    const r = repo();
    await toAnswers(r);
    const argv = r.logged()[0]?.argv ?? [];
    const m = argv.indexOf("--model");
    expect(argv.slice(m, m + 4)).toEqual(["--model", "haiku", "--effort", "low"]);
    expect(valueAfter(argv, "--tools")).toBe("Read,Glob,Grep");
    expect(valueAfter(argv, "--permission-mode")).toBe("default");
    expect(argv).not.toContain("--allowedTools");
    expect(JSON.parse(valueAfter(argv, "--json-schema") ?? "null")).toEqual(roleSchemas.scout);
  });

  it("scout1 AC-2: the head line names the step, the role and the route", async () => {
    const r = repo();
    await toAnswers(r);
    expect(r.out).toContain("-> scout · scout · haiku · low · call 1/40 ...");
  });

  it("scout1 AC-2: the model and the effort follow an edited routing.scout", async () => {
    const r = repo();
    const gates = join(r.dir, ".claude", "gates.json");
    const g = JSON.parse(readFileSync(gates, "utf8")) as { routing: Record<string, unknown> };
    g.routing["scout"] = "sonnet·medium";
    write(r.dir, ".claude/gates.json", `${JSON.stringify(g, null, 2)}\n`);
    sh(r.dir, "add", "-A");
    sh(r.dir, "commit", "-q", "-m", "chore: scout route");
    await toAnswers(r, { ...scout(), expectModel: "sonnet", expectEffort: "medium" });
    expect(r.out).toContain("-> scout · scout · sonnet · medium · call 1/40 ...");
  });

  it("scout1 AC-3: the scout gets the Contract's prompt with the run's description", async () => {
    const r = repo();
    await toAnswers(r);
    const want = [
      "# Role: scout",
      "",
      "The driver has started a task run. You only read the repository: you must not edit files, run commands, or do the task.",
      "",
      "Task description:",
      TASK_DESC,
      "",
      "- List the places that the next roles (clarify, then spec, then plan) should read first for this task: specs, the code the task changes, its tests, and the docs that define its words.",
      "- At most 30 entries, the most important first. Each entry has one line of why.",
      '- `path` is relative to the repository root. Give `lines` as "<first>-<last>" (or one number) when only part of a file matters; leave it out for a whole file or a folder.',
    ].join("\n");
    expect(r.logged()[0]?.prompt).toBe(want);
  });
});

describe("the worked case (scout1 AC-4)", () => {
  it("scout1 AC-4: the worked case gives exactly the scout map, by rename, and the progress line; the run goes to clarify", async () => {
    const r = repo();
    write(r.dir, "src/run/engine/call.ts", "export {};\n");
    mkdirSync(join(r.dir, "docs/specs/effort1"), { recursive: true });
    write(r.dir, "docs/specs/effort1/SPEC.md", "# effort1\n");
    sh(r.dir, "add", "-A");
    sh(r.dir, "commit", "-q", "-m", "chore: worked case");
    expect(existsSync(join(r.dir, "src/run/engine/steps-scout.ts"))).toBe(false);
    r.script([
      scout([
        { path: "src/run/engine/call.ts", lines: "59-133", why: "roleCall: one call,\nthe schema re-run, infra" },
        { path: "./docs/specs/effort1/", why: "the routing block and its check messages" },
        { path: "src/run/engine/steps-scout.ts", why: "where the new step goes" },
      ]),
      clarify(),
    ]);
    const code = await startRun({ ...r.opts(), now: new Date(2026, 10, 25, 10, 15, 0), mode: "task", description: TASK_DESC });
    expect(code, text(r)).toBe(3);
    const run = r.run();
    expect(run.id).toBe("r-20261125-101500");
    const dir = runDir(r.dir, run.id);
    expect(readFileSync(join(dir, "scout.md"), "utf8")).toBe(
      [
        "# Scout map",
        "",
        "Run r-20261125-101500 · haiku · low · 2 places",
        "",
        "- `src/run/engine/call.ts:59-133` — roleCall: one call, the schema re-run, infra",
        "- `docs/specs/effort1` — the routing block and its check messages",
        "",
      ].join("\n")
    );
    // By rename: no temp file is left in the run folder.
    expect(readdirSync(dir).filter((f) => f.includes("scout") && f !== "scout.md")).toEqual([]);
    const line = "scout: map of 2 places written to scout.md (1 dropped)";
    expect(r.out).toContain(line);
    expect(readFileSync(join(dir, "progress.log"), "utf8")).toContain(line);
    expect(roles(r)).toEqual(["scout", "clarify"]);
    expect(run.next).toBe("gate:answers");
  });

  it("scout1 AC-4: with nothing dropped the progress line has no count, and one entry is `1 place`", async () => {
    const r = repo();
    await toAnswers(r, scout([{ path: "README.md", why: "the readme" }]));
    expect(r.out).toContain("scout: map of 1 place written to scout.md");
    expect(text(r)).not.toContain("dropped");
    expect(readFileSync(scoutFile(r), "utf8")).toContain("· 1 place\n");
  });
});

describe("the scout call is counted like any call (scout1 AC-6)", () => {
  it("scout1 AC-6: calls and costUsd count the scout call; its call file is calls/1-scout.json; steps holds scout", async () => {
    const r = repo();
    await toAnswers(r);
    const run = r.run();
    expect(run.calls).toBe(2);
    expect(run.costUsd).toBeCloseTo(0.02, 10);
    expect(run.costUnknownCalls).toBe(0);
    const calls = readdirSync(join(runDir(r.dir, run.id), "calls")).sort();
    expect(calls).toEqual(["1-scout.json", "2-clarify.json"]);
    const entry = run.steps.find((s) => s.step === "scout");
    expect(entry?.end).not.toBeNull();
  });

  it("scout1 AC-6: a scout call with an unknown cost adds to costUnknownCalls, not to costUsd", async () => {
    const r = repo();
    const output = { entries: [{ path: "README.md", why: "the readme" }] };
    await toAnswers(r, {
      expectRole: "scout",
      stdout: { type: "result", subtype: "success", is_error: false, num_turns: 2, permission_denials: [], structured_output: output },
    });
    const run = r.run();
    expect(run.calls).toBe(2);
    expect(run.costUnknownCalls).toBe(1);
    expect(run.costUsd).toBeCloseTo(0.01, 10);
  });
});

describe("resumes that make no scout call (scout1 AC-19, AC-20)", () => {
  it("scout1 AC-19: a run that resumes at scout with its scout map makes no call, says so and goes to clarify", async () => {
    const r = repo();
    await toAnswers(r);
    const map = readFileSync(scoutFile(r), "utf8");
    patchRun(r, { next: "scout", status: "running", proposal: null });
    r.out.length = 0;
    expect(await resumeRun({ ...r.opts() }), text(r)).toBe(3);
    expect(roles(r)).toEqual(["scout", "clarify", "clarify"]);
    expect(r.out).toContain("scout: scout.md is already there; no new call");
    expect(text(r)).not.toContain("-> scout");
    const run = r.run();
    expect(run.calls).toBe(3);
    expect(run.next).toBe("gate:answers");
    expect(readFileSync(scoutFile(r), "utf8")).toBe(map);
  });

  it("scout1 AC-20: a run at clarify with no scout map (started before this stage) runs clarify with no scout call", async () => {
    const r = repo();
    await toAnswers(r);
    rmSync(scoutFile(r));
    patchRun(r, { next: "clarify", status: "running", proposal: null });
    r.out.length = 0;
    expect(await resumeRun({ ...r.opts() }), text(r)).toBe(3);
    expect(roles(r)).toEqual(["scout", "clarify", "clarify"]);
    expect(text(r)).not.toContain("scout");
    const run = r.run();
    expect(run.calls).toBe(3);
    expect(run.next).toBe("gate:answers");
    expect(existsSync(scoutFile(r))).toBe(false);
  });
});
