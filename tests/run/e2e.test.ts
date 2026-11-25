/** v04 end to end: the task and quick paths through the CLI entry `runCommand`, with the fake claude. */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cleanupProjects, git } from "../hooks/fixture.js";
import { runCommand } from "../../src/commands/run.js";
import { listRuns, readLock } from "../../src/run/store.js";
import { impl, makeFakeExecutable, repo, sh, type Repo } from "./engine-fixture.js";
import {
  clarify,
  scout,
  mergeSpec,
  plan,
  spec,
  SPEC_BRANCH,
  TASK_DESC,
  twoTasksDone,
  WORK_BRANCH,
} from "./engine-task-fixture.js";

const QUICK_DESC = "Tidy the readme wording";
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

beforeAll(makeFakeExecutable);
afterEach(() => cleanupProjects());

/** Runs the CLI entry the way the shell would: env from the process, gate answers from a file. */
async function cli(
  r: Repo,
  gate: string[] | null,
  mode: string | undefined,
  description: string | undefined,
  options: Parameters<typeof runCommand>[2] = {}
): Promise<number> {
  const { env } = r.opts(gate ? { gate } : {});
  const saved: Record<string, string | undefined> = {};
  for (const k of ["AGENT_STACK_GATE_INPUT", ...Object.keys(env)]) saved[k] = process.env[k];
  delete process.env["AGENT_STACK_GATE_INPUT"];
  Object.assign(process.env, env);
  try {
    return await runCommand(mode, description, options, { projectDir: r.dir, out: (l) => r.out.push(l) });
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

/** Execution throws on a non-zero exit, so a rejected header fails the test. */
function commitlintAccepts(subjects: string[]): void {
  const config = join(repoRoot, "tests/run/commitlint.conventional.mjs");
  for (const s of subjects) execFileSync("pnpm", ["exec", "commitlint", "--config", config], { cwd: repoRoot, input: `${s}\n`, stdio: "pipe" });
}

function addBareRemote(r: Repo): string {
  const origin = join(r.dir, ".git", "origin.git");
  git(r.dir, "init", "-q", "--bare", origin);
  git(r.dir, "remote", "add", "origin", origin);
  return origin;
}

/** Every calls/ file of every run: argv present, the prompt text absent. */
function checkCalls(r: Repo, secret: string, expected: number): void {
  const ids = listRuns(r.dir);
  expect(ids.length).toBe(1);
  const dir = join(r.dir, ".claude/tmp/runs", ids[0] ?? "", "calls");
  const files = readdirSync(dir);
  expect(files.length).toBe(expected);
  for (const f of files) {
    const raw = readFileSync(join(dir, f), "utf8");
    expect(raw).toContain("--json-schema");
    expect(raw).not.toContain(secret);
  }
  // The prompt did reach the fake on stdin.
  expect(r.logged().some((c) => c.prompt.includes(secret))).toBe(true);
}

describe("v04 end to end", () => {
  it("v04 AC-1: run task goes clarify, answers, spec, merge stop, resume, plan, approve, two tasks, accept, finished", async () => {
    const r = repo();
    const origin = addBareRemote(r);
    const main = sh(r.dir, "rev-parse", "main");
    r.script([scout(), clarify(), spec(), plan(), ...twoTasksDone()]);
    const started = Date.now();

    expect(await cli(r, ["", "", ""], "task", TASK_DESC), r.out.join("\n")).toBe(3);
    expect(r.run().next).toBe("gate:spec-merge");
    expect(sh(r.dir, "log", "-1", "--format=%s", SPEC_BRANCH)).toBe("docs(b1): spec — Add a greeting");
    expect(readLock(r.dir)).not.toBeNull();

    // A second run is refused while this one waits.
    expect(await cli(r, null, "task", "another")).toBe(1);

    mergeSpec(r);
    expect(await cli(r, ["a", "a"], undefined, undefined, { resume: true }), r.out.join("\n")).toBe(0);
    const elapsedMs = Date.now() - started;

    const run = r.run();
    expect(run.status).toBe("finished");
    expect(run.tasks.map((t) => t.id)).toEqual(["T1", "T2"]);
    expect(run.gates.map((g) => `${g.gate} ${g.decision}`)).toEqual([
      "gate:answers confirm",
      "gate:spec-merge merged",
      "gate:plan-approve approve",
      "gate:accept accept",
    ]);
    expect(readLock(r.dir)).toBeNull();
    expect(sh(r.dir, "branch", "--show-current")).toBe(WORK_BRANCH);

    const headers = sh(r.dir, "log", "--format=%s", `${main}..${WORK_BRANCH}`).split("\n");
    expect(headers).toEqual([
      "fix(b1): add the bye file",
      "fix(b1): add the hello file",
      "merge spec",
      "docs(b1): spec — Add a greeting",
    ]);
    commitlintAccepts(headers.filter((h) => h !== "merge spec"));

    expect(sh(origin, "for-each-ref")).toBe("");
    // scout1: the scout call comes first, so 8 call files.
    checkCalls(r, TASK_DESC, 8);
    expect(elapsedMs).toBeLessThan(10_000);
    console.log(`task path wall time: ${elapsedMs} ms`);
  }, 120_000);

  it("v04 AC-2: --status changes nothing and every calls/ file holds the argv, not the prompt", async () => {
    const r = repo();
    r.script([scout(), clarify(), spec()]);
    expect(await cli(r, ["", "", ""], "task", TASK_DESC)).toBe(3);
    const before = readFileSync(join(r.dir, ".claude/tmp/runs", r.run().id, "run.json"), "utf8");
    expect(await cli(r, null, undefined, undefined, { status: true })).toBe(0);
    expect(readFileSync(join(r.dir, ".claude/tmp/runs", r.run().id, "run.json"), "utf8")).toBe(before);
    checkCalls(r, TASK_DESC, 3);
    expect(await cli(r, null, undefined, undefined, { cancel: true })).toBe(0);
    expect(r.run().status).toBe("cancelled");
    expect(readLock(r.dir)).toBeNull();
  }, 120_000);

  it("v04 AC-22: the accept gate with no terminal input waits with exit 3, and a later resume finishes the run", async () => {
    const r = repo();
    r.script([scout(), clarify(), spec(), plan(), ...twoTasksDone()]);
    expect(await cli(r, ["", "", ""], "task", TASK_DESC)).toBe(3);
    mergeSpec(r);
    expect(await cli(r, ["a"], undefined, undefined, { resume: true })).toBe(3);
    expect(r.run().next).toBe("gate:accept");
    expect(r.run().status).toBe("waiting");
    expect(await cli(r, ["a"], undefined, undefined, { resume: true })).toBe(0);
    expect(r.run().status).toBe("finished");
  }, 120_000);

  it("v04 AC-25: run quick makes one fix, commits it with a quick header and finishes at accept; nothing is pushed", async () => {
    const r = repo();
    const origin = addBareRemote(r);
    const main = sh(r.dir, "rev-parse", "main");
    r.script([impl({ writes: { "README.md": "# demo\nfixed\n" } })]);
    const started = Date.now();
    expect(await cli(r, ["a"], "quick", QUICK_DESC), r.out.join("\n")).toBe(0);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(r.run().status).toBe("finished");
    const headers = sh(r.dir, "log", "--format=%s", `${main}..HEAD`).split("\n");
    expect(headers).toEqual(["fix(quick): fix the README line"]);
    commitlintAccepts(headers);
    expect(sh(origin, "for-each-ref")).toBe("");
    checkCalls(r, QUICK_DESC, 1);
  }, 120_000);
});
