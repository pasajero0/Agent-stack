import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runEval, tempDir } from "./helpers.js";

const VALID = {
  mode: "quick",
  description: "Make sum() return a + b + 1",
  fixture: "fixture",
  check: "true",
  expect: "finished",
};

/** Write <dir>/<id>/task.json (an object is stringified) and a fixture folder with one file. */
function addTask(dir: string, id: string, task: unknown, fixture = true): string {
  const taskDir = join(dir, id);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(join(taskDir, "task.json"), typeof task === "string" ? task : JSON.stringify(task));
  if (fixture) {
    mkdirSync(join(taskDir, "fixture"), { recursive: true });
    writeFileSync(join(taskDir, "fixture", "a.txt"), "a");
  }
  return taskDir;
}

const lines = (s: string): string[] => s.split("\n").filter((l) => l !== "");

describe("eval runner picks and checks tasks", () => {
  it("evals1 AC-1: passes over folders without task.json and plain files with no message", () => {
    const dir = tempDir();
    addTask(dir, "bad-1", { ...VALID, mode: "full" });
    mkdirSync(join(dir, "no-json"));
    writeFileSync(join(dir, "notes.txt"), "x");
    const r = runEval(["--tasks-dir", dir]);
    expect(r.code).toBe(1);
    expect(r.stderr).not.toContain("no-json");
    expect(r.stderr).not.toContain("notes.txt");
    expect(lines(r.stderr)).toEqual(['bad-1/task.json: mode: must be "quick"']);
  });

  it("evals1 AC-1: checks only the --task ids and lists problems in id order", () => {
    const dir = tempDir();
    addTask(dir, "zeta", { ...VALID, check: " " });
    addTask(dir, "alpha", { ...VALID, mode: "x" });
    addTask(dir, "other", "not json");
    const r = runEval(["--tasks-dir", dir, "--task", "zeta", "--task", "alpha"]);
    expect(r.code).toBe(1);
    expect(lines(r.stderr)).toEqual(['alpha/task.json: mode: must be "quick"', "zeta/task.json: check: must be a command"]);
  });

  it("evals1 AC-1: checks the flags before the tasks", () => {
    const dir = tempDir();
    addTask(dir, "bad-1", "nope");
    const r = runEval(["--tasks-dir", dir, "--k", "0"]);
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("--k");
    expect(r.stderr).not.toContain("bad-1");
  });
});

describe("eval runner refuses a bad task.json", () => {
  const run = (id: string, task: unknown, setup?: (taskDir: string) => void): string[] => {
    const dir = tempDir();
    const taskDir = addTask(dir, id, task);
    setup?.(taskDir);
    const r = runEval(["--tasks-dir", dir]);
    expect(r.code).toBe(1);
    return lines(r.stderr);
  };

  it("evals1 AC-8: fixture ../x", () => {
    expect(run("t-1", { ...VALID, fixture: "../x" })).toEqual(["t-1/task.json: fixture: must be a folder inside t-1/ with no symlinks"]);
  });

  it("evals1 AC-8: a fixture root that is a symlink out of the task folder", () => {
    const out = tempDir();
    const got = run("t-2", { ...VALID, fixture: "link" }, (taskDir) => symlinkSync(out, join(taskDir, "link")));
    expect(got).toEqual(["t-2/task.json: fixture: must be a folder inside t-2/ with no symlinks"]);
  });

  it("evals1 AC-8: a symlink inside the fixture", () => {
    const got = run("t-3", VALID, (taskDir) => symlinkSync("a.txt", join(taskDir, "fixture", "ln")));
    expect(got).toEqual(["t-3/task.json: fixture: must be a folder inside t-3/ with no symlinks"]);
  });

  it("evals1 AC-8: a missing field", () => {
    const { check: _check, ...rest } = VALID;
    expect(run("t-4", rest)).toEqual(["t-4/task.json: check: missing"]);
  });

  it("evals1 AC-8: an unknown key with a control character prints it with ?, and no value is quoted", () => {
    const got = run("t-5", `{"mode":"quick","description":"SECRET-VALUE","fixture":"fixture","check":"true","expect":"finished","bad\\u0007key":"SECRET"}`);
    expect(got).toEqual(["t-5/task.json: unknown key bad?key"]);
  });

  it("evals1 AC-8: not JSON", () => {
    expect(run("t-6", "{oops")).toEqual(["t-6/task.json: not JSON"]);
  });

  it("evals1 AC-8: not an object", () => {
    expect(run("t-7", "[1]")).toEqual(["t-7/task.json: not an object"]);
  });

  it("evals1 AC-8: a bad folder id", () => {
    const dir = tempDir();
    addTask(dir, "Bad_Id", VALID);
    const r = runEval(["--tasks-dir", dir]);
    expect(r.code).toBe(1);
    expect(lines(r.stderr)).toEqual([`${dir}/Bad_Id: not a valid eval task id`]);
  });

  it("evals1 AC-8: every problem of every task, one line each, without quoting values", () => {
    const dir = tempDir();
    addTask(dir, "a-1", { ...VALID, description: "-SECRET", expect: "gate:limit nope", answers: [1] });
    addTask(dir, "b-1", { ...VALID, mode: "SECRET" });
    const r = runEval(["--tasks-dir", dir]);
    expect(r.code).toBe(1);
    expect(lines(r.stderr)).toEqual([
      "a-1/task.json: description: must be a text that does not start with -",
      "a-1/task.json: expect: must be finished, cancelled, gate:accept or gate:limit <reason>",
      "a-1/task.json: answers: must be a list of texts",
      'b-1/task.json: mode: must be "quick"',
    ]);
    expect(r.stderr).not.toContain("SECRET");
  });
});

describe("eval runner with no task", () => {
  it("evals1 AC-22: an empty tasks dir, only plain files and folders without task.json", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "no-json"));
    writeFileSync(join(dir, "notes.txt"), "x");
    const r = runEval(["--tasks-dir", dir]);
    expect(r.code).toBe(1);
    expect(lines(r.stderr)).toEqual([`no eval tasks in ${dir}`]);
  });

  it("evals1 AC-22: a tasks dir that does not exist", () => {
    const dir = join(tempDir(), "missing");
    const r = runEval(["--tasks-dir", dir]);
    expect(r.code).toBe(1);
    expect(lines(r.stderr)).toEqual([`no eval tasks in ${dir}`]);
  });
});
