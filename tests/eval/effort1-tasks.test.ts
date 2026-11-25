/** effort1 AC-25: the rename-many and auth-boundary eval tasks, their fixtures, and their fake scripts. */
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { makeFakeExecutable } from "../run/engine-fixture.js";
import { REPO_ROOT, runEval, tempDir } from "./helpers.js";

beforeAll(makeFakeExecutable);

const TASKS_DIR = join(REPO_ROOT, "evals", "tasks");
const SCRIPTS = join(REPO_ROOT, "tests", "eval", "scripts");
const CLI = join(REPO_ROOT, "bin", "cli.mjs");

const TABLE: Record<string, { cell: string; model: string; effort: string }> = {
  "rename-many": { cell: "L·low", model: "sonnet", effort: "medium" },
  "auth-boundary": { cell: "S·high", model: "opus", effort: "high" },
};

/** The environment without GIT_* variables, so git never acts on this repo. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith("GIT_")) env[k] = v;
  return env;
}

function sh(cmd: string, args: string[], cwd: string) {
  return spawnSync(cmd, args, { cwd, env: cleanEnv(), encoding: "utf8" });
}

/** Every file under `dir`, as relative paths; symlinks get a trailing "@". */
function listFiles(dir: string, base = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(dir, base), { withFileTypes: true })) {
    const rel = base === "" ? e.name : `${base}/${e.name}`;
    if (e.isDirectory()) out.push(...listFiles(dir, rel));
    else out.push(lstatSync(join(dir, rel)).isSymbolicLink() ? `${rel}@` : rel);
  }
  return out;
}

interface Try {
  pass: boolean;
}

/** One eval run of one task with one fake script; returns the single try. */
function evalRun(id: string, kind: "pass" | "break"): Try[] {
  const r = runEval(["--task", id, "--yes", "--k", "1"], { fakeScript: join(SCRIPTS, `${id}.${kind}.json`) });
  expect(r.code, r.stdout + r.stderr).toBe(0);
  const files = readdirSync(r.outDir).filter((f) => f.endsWith(".json"));
  expect(files.length).toBe(1);
  const res = JSON.parse(readFileSync(join(r.outDir, files[0] ?? ""), "utf8")) as { tasks: Array<{ id: string; tries: Try[] }> };
  expect(res.tasks.map((t) => t.id)).toEqual([id]);
  return res.tasks[0]?.tries ?? [];
}

describe("effort1 AC-25: the rename-many and auth-boundary eval tasks", () => {
  for (const [id, row] of Object.entries(TABLE)) {
    const taskDir = join(TASKS_DIR, id);

    it(`effort1 AC-25: ${id} task.json is valid: quick, cell ${row.cell}, expect finished, answers ["a"]`, () => {
      const r = runEval(["--tasks-dir", TASKS_DIR, "--task", id]);
      // A valid task reaches the start question; with no terminal the runner then says "not started".
      expect(r.stderr).toBe("not started\n");
      expect(r.code).toBe(1);
      const task = JSON.parse(readFileSync(join(taskDir, "task.json"), "utf8"));
      expect(task.mode).toBe("quick");
      expect(task.cell).toBe(row.cell);
      expect(task.expect).toBe("finished");
      expect(task.answers).toEqual(["a"]);
      expect(task.check).toContain(`'${row.model}'`);
      expect(task.check).toContain(`'${row.effort}'`);
    });

    it(`effort1 AC-25: ${id} has a tiny fixture: at most 5 files, no dependencies, no symlinks, tests in test/`, () => {
      const files = listFiles(join(taskDir, "fixture"));
      expect(files.length).toBeGreaterThan(0);
      expect(files.length).toBeLessThanOrEqual(5);
      expect(files.filter((f) => f.endsWith("@"))).toEqual([]);
      expect(files.some((f) => f.startsWith("test/"))).toBe(true);
      const pkgPath = join(taskDir, "fixture", "package.json");
      if (existsSync(pkgPath)) {
        const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
        for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
          expect(Object.keys(pkg[key] ?? {})).toEqual([]);
        }
      }
    });

    it(`effort1 AC-25: ${id}: generate writes a non-empty commands.test that exits 0 at main`, () => {
      const dir = tempDir();
      cpSync(join(taskDir, "fixture"), dir, { recursive: true });
      expect(sh("git", ["init", "-q", "-b", "main"], dir).status).toBe(0);
      const gen = sh(process.execPath, [CLI, "generate"], dir);
      expect(gen.status, gen.stderr).toBe(0);
      const gates = JSON.parse(readFileSync(join(dir, ".claude", "gates.json"), "utf8"));
      const cmd: unknown = gates.commands?.test;
      expect(typeof cmd).toBe("string");
      expect((cmd as string).trim()).not.toBe("");
      const t = sh("/bin/sh", ["-c", cmd as string], dir);
      expect(t.status, `${t.stdout}\n${t.stderr}`).toBe(0);
    });

    it(`effort1 AC-25: ${id}.pass.json makes the try pass`, () => {
      const tries = evalRun(id, "pass");
      expect(tries.length).toBe(1);
      expect(tries[0]?.pass, JSON.stringify(tries)).toBe(true);
    }, 60_000);

    it(`effort1 AC-25: ${id}.break.json makes the try fail`, () => {
      const tries = evalRun(id, "break");
      expect(tries.length).toBe(1);
      expect(tries[0]?.pass, JSON.stringify(tries)).toBe(false);
    }, 60_000);
  }

  it("effort1 AC-25: rename-many: the fixture's tests do not name the function", () => {
    const testDir = join(TASKS_DIR, "rename-many", "fixture", "test");
    for (const f of readdirSync(testDir)) expect(readFileSync(join(testDir, f), "utf8")).not.toContain("totalPrice");
  });

  it("effort1 AC-25: auth-boundary: the check fails at main and with a second file changed under src/", () => {
    const taskDir = join(TASKS_DIR, "auth-boundary");
    const dir = tempDir();
    cpSync(join(taskDir, "fixture"), dir, { recursive: true });
    const git = ["-c", "user.name=eval", "-c", "user.email=eval@example.invalid", "-c", "commit.gpgsign=false"];
    expect(sh("git", ["init", "-q", "-b", "main"], dir).status).toBe(0);
    expect(sh("git", ["add", "-A"], dir).status).toBe(0);
    expect(sh("git", [...git, "commit", "-q", "--no-verify", "-m", "fixture"], dir).status).toBe(0);
    const task = JSON.parse(readFileSync(join(taskDir, "task.json"), "utf8"));
    expect(sh("/bin/sh", ["-c", task.check as string], dir).status).not.toBe(0);
    // The scope part alone: a new file under src/ fails it; a new file under test/ does not.
    const scope = (task.check as string).split(" && ").find((p) => p.includes("src/access.js"));
    expect(scope).toBeDefined();
    writeFileSync(join(dir, "test", "extra.test.js"), "");
    expect(sh("/bin/sh", ["-c", scope ?? ""], dir).status).toBe(0);
    writeFileSync(join(dir, "src", "extra.js"), "");
    expect(sh("/bin/sh", ["-c", scope ?? ""], dir).status).not.toBe(0);
  });
});
