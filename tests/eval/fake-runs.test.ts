import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { makeFakeExecutable } from "../run/engine-fixture.js";
import { REPO_ROOT, runEval, tempDir } from "./helpers.js";

beforeAll(makeFakeExecutable);

const SCRIPTS = join(REPO_ROOT, "tests", "eval", "scripts");
const TASKS = ["plain-fix", "scope", "weaken-test", "dependency-temptation", "test-conflict"];

interface Try {
  pass: boolean;
  outcome: string;
  check: number | null;
}
interface ResultsFile {
  tasks: Array<{ id: string; tries: Try[] }>;
}

/** The script's responses, repeated n times: the fake's counter goes on across tries. */
function repeated(file: string, n: number): { path: string; length: number } {
  const responses = JSON.parse(readFileSync(file, "utf8")) as unknown[];
  const path = join(tempDir(), "repeated.json");
  writeFileSync(path, JSON.stringify(Array.from({ length: n }, () => responses).flat()));
  return { path, length: responses.length };
}

/** One eval run of one task with one script, k tries. */
function evalRun(id: string, kind: "pass" | "break", k: number): { tries: Try[]; idx: number; length: number; ms: number } {
  const script = join(SCRIPTS, `${id}.${kind}.json`);
  const { path, length } = repeated(script, k);
  const started = Date.now();
  const r = runEval(["--task", id, "--yes", "--k", String(k)], { fakeScript: path });
  const ms = Date.now() - started;
  expect(r.code, r.stdout + r.stderr).toBe(0);
  const files = readdirSync(r.outDir).filter((f) => f.endsWith(".json"));
  expect(files.length).toBe(1);
  const res = JSON.parse(readFileSync(join(r.outDir, files[0] ?? ""), "utf8")) as ResultsFile;
  expect(res.tasks.map((t) => t.id)).toEqual([id]);
  const idx = Number(readFileSync(`${r.scriptCopy ?? ""}.idx`, "utf8"));
  return { tries: res.tasks[0]?.tries ?? [], idx, length, ms };
}

describe("eval tasks with fake claude scripts", () => {
  for (const id of TASKS) {
    it(`evals1 AC-18: ${id}.pass.json makes the try pass`, () => {
      const r = evalRun(id, "pass", 1);
      expect(r.tries.length).toBe(1);
      expect(r.tries[0]?.pass, JSON.stringify(r.tries)).toBe(true);
      expect(r.idx).toBe(r.length * 1);
      if (id === "plain-fix") expect(r.ms).toBeLessThan(15_000);
    });

    it(`evals1 AC-18: ${id}.break.json makes the try fail`, () => {
      const r = evalRun(id, "break", 1);
      expect(r.tries.length).toBe(1);
      expect(r.tries[0]?.pass, JSON.stringify(r.tries)).toBe(false);
      expect(r.idx).toBe(r.length * 1);
    });
  }

  it("evals1 AC-18: with --k 2 every try uses its own responses (pass)", () => {
    const r = evalRun("plain-fix", "pass", 2);
    expect(r.tries.map((t) => t.pass)).toEqual([true, true]);
    expect(r.idx).toBe(r.length * 2);
  }, 60_000);

  it("evals1 AC-18: with --k 2 every try uses its own responses (break)", () => {
    const r = evalRun("scope", "break", 2);
    expect(r.tries.map((t) => t.pass)).toEqual([false, false]);
    expect(r.idx).toBe(r.length * 2);
  }, 60_000);
});
