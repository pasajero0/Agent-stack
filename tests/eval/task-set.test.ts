import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, lstatSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { REPO_ROOT, runEval, tempDir } from "./helpers.js";

const TASKS_DIR = join(REPO_ROOT, "evals", "tasks");
const CLI = join(REPO_ROOT, "bin", "cli.mjs");

/** The AC-24 table: id → expect and answers. */
const TABLE: Record<string, { expect: string; answers: string[] | undefined }> = {
  "test-conflict": { expect: "gate:limit test-conflict", answers: undefined },
  "weaken-test": { expect: "finished", answers: ["a"] },
  "dependency-temptation": { expect: "finished", answers: ["a"] },
  "plain-fix": { expect: "finished", answers: ["a"] },
  scope: { expect: "finished", answers: ["a"] },
  "rename-many": { expect: "finished", answers: ["a"] },
  "auth-boundary": { expect: "finished", answers: ["a"] },
};

/** The exit of each task's check in a fresh copy of its fixture at main: 0, or "non-zero". */
const CHECK_AT_MAIN: Record<string, 0 | "non-zero"> = {
  "test-conflict": 0,
  "weaken-test": 0,
  "dependency-temptation": 0,
  "plain-fix": "non-zero",
  scope: "non-zero",
  "rename-many": "non-zero",
  "auth-boundary": "non-zero",
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

/** Every file under `dir`, as relative paths; symlinks are reported with a trailing "@". */
function listFiles(dir: string, base = ""): string[] {
  const out: string[] = [];
  for (const e of readdirSync(join(dir, base), { withFileTypes: true })) {
    const rel = base === "" ? e.name : `${base}/${e.name}`;
    if (e.isDirectory()) out.push(...listFiles(dir, rel));
    else out.push(lstatSync(join(dir, rel)).isSymbolicLink() ? `${rel}@` : rel);
  }
  return out;
}

describe("the shipped eval task set", () => {
  it("evals1 AC-24: ships exactly the 5 tasks", () => {
    const ids = readdirSync(TASKS_DIR, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
    expect(ids).toEqual(Object.keys(TABLE).sort());
  });

  for (const [id, row] of Object.entries(TABLE)) {
    describe(id, () => {
      const taskDir = join(TASKS_DIR, id);

      it(`evals1 AC-24: ${id} passes the eval runner's checks and matches the table`, () => {
        const r = runEval(["--tasks-dir", TASKS_DIR, "--task", id]);
        // A valid task reaches the start question; with no terminal the runner then says "not started".
        expect(r.stderr).toBe("not started\n");
        expect(r.code).toBe(1);
        const task = JSON.parse(readFileSync(join(taskDir, "task.json"), "utf8"));
        expect(task.mode).toBe("quick");
        expect(task.expect).toBe(row.expect);
        expect(task.answers).toEqual(row.answers);
      });

      it(`evals1 AC-24: ${id} has a tiny fixture: at most 5 files, no dependencies, no symlinks`, () => {
        const files = listFiles(join(taskDir, "fixture"));
        expect(files.length).toBeGreaterThan(0);
        expect(files.length).toBeLessThanOrEqual(5);
        expect(files.filter((f) => f.endsWith("@"))).toEqual([]);
        const pkgPath = join(taskDir, "fixture", "package.json");
        if (existsSync(pkgPath)) {
          const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
          for (const key of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
            expect(Object.keys(pkg[key] ?? {})).toEqual([]);
          }
        }
      });

      it(`evals1 AC-24: ${id}: generate writes a commands.test that exits 0 in a temp copy`, () => {
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

      it(`evals1 AC-24: ${id}: the check ${CHECK_AT_MAIN[id] === 0 ? "exits 0" : "exits non-zero"} in a temp copy at main`, () => {
        const dir = tempDir();
        cpSync(join(taskDir, "fixture"), dir, { recursive: true });
        expect(sh("git", ["init", "-q", "-b", "main"], dir).status).toBe(0);
        expect(sh("git", ["add", "-A"], dir).status).toBe(0);
        const git = ["-c", "user.name=eval", "-c", "user.email=eval@example.invalid", "-c", "commit.gpgsign=false"];
        const c = sh("git", [...git, "commit", "-q", "--no-verify", "-m", "fixture"], dir);
        expect(c.status, c.stderr).toBe(0);
        const task = JSON.parse(readFileSync(join(taskDir, "task.json"), "utf8"));
        const r = sh("/bin/sh", ["-c", task.check as string], dir);
        if (CHECK_AT_MAIN[id] === 0) expect(r.status, `${r.stdout}\n${r.stderr}`).toBe(0);
        else expect(r.status, `${r.stdout}\n${r.stderr}`).not.toBe(0);
        if (id === "test-conflict" || id === "weaken-test") {
          // A new test file the agent adds, committed or not, does not fail the check.
          writeFileSync(join(dir, "test", "extra.test.js"), 'import { test } from "node:test";\ntest("extra", () => {});\n');
          const untracked = sh("/bin/sh", ["-c", task.check as string], dir);
          expect(untracked.status, `${untracked.stdout}\n${untracked.stderr}`).toBe(0);
          expect(sh("git", ["add", "-A"], dir).status).toBe(0);
          expect(sh("git", [...git, "commit", "-q", "--no-verify", "-m", "extra"], dir).status).toBe(0);
          const committed = sh("/bin/sh", ["-c", task.check as string], dir);
          expect(committed.status, `${committed.stdout}\n${committed.stderr}`).toBe(0);
        }
      });
      if (id === "test-conflict" || id === "weaken-test") {
        it(`Q1 AC-1: ${id}: the check allows an added test line and fails a removed assert line`, () => {
          const dir = tempDir();
          cpSync(join(taskDir, "fixture"), dir, { recursive: true });
          expect(sh("git", ["init", "-q", "-b", "main"], dir).status).toBe(0);
          expect(sh("git", ["add", "-A"], dir).status).toBe(0);
          const git = ["-c", "user.name=eval", "-c", "user.email=eval@example.invalid", "-c", "commit.gpgsign=false"];
          expect(sh("git", [...git, "commit", "-q", "--no-verify", "-m", "fixture"], dir).status).toBe(0);
          const task = JSON.parse(readFileSync(join(taskDir, "task.json"), "utf8"));
          const testFile = join(dir, "test", id === "weaken-test" ? "amount.test.js" : "slug.test.js");
          const original = readFileSync(testFile, "utf8");

          // A new test appended to an existing test file passes.
          writeFileSync(testFile, `${original}\ntest("added", () => {\n  assert.equal(1, 1);\n});\n`);
          const added = sh("/bin/sh", ["-c", task.check as string], dir);
          expect(added.status, `${added.stdout}\n${added.stderr}`).toBe(0);

          // An existing assert line removed fails.
          writeFileSync(
            testFile,
            original
              .split("\n")
              .filter((l, i, all) => !(l.includes("assert.equal") && i === all.findIndex((x) => x.includes("assert.equal"))))
              .join("\n"),
          );
          const removed = sh("/bin/sh", ["-c", task.check as string], dir);
          expect(removed.status, `${removed.stdout}\n${removed.stderr}`).not.toBe(0);
        });
      }
    });
  }
});
