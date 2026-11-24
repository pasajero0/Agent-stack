import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { makeFakeExecutable } from "../run/engine-fixture.js";
import { EVAL_SCRIPT, runEval, tempDir } from "./helpers.js";

beforeAll(makeFakeExecutable);

type Json = Record<string, unknown>;

interface TaskDef {
  id: string;
  expect?: string;
  check?: string;
  description?: string;
  answers?: string[];
  /** Extra fixture files, path → content. */
  files?: Record<string, string>;
}

function tasksDir(tasks: TaskDef[]): string {
  const dir = tempDir();
  for (const t of tasks) {
    const fixture = join(dir, t.id, "fixture");
    mkdirSync(fixture, { recursive: true });
    writeFileSync(join(fixture, "a.txt"), "a\n");
    for (const [p, content] of Object.entries(t.files ?? {})) {
      mkdirSync(join(fixture, p, ".."), { recursive: true });
      writeFileSync(join(fixture, p), content);
    }
    writeFileSync(
      join(dir, t.id, "task.json"),
      JSON.stringify({
        mode: "quick",
        description: t.description ?? "Change the a file",
        fixture: "fixture",
        check: t.check ?? "true",
        expect: t.expect ?? "gate:accept",
        ...(t.answers ? { answers: t.answers } : {}),
      }),
    );
  }
  return dir;
}

const done = (o: { writes?: Record<string, string>; deletes?: string[]; status?: string; conflict?: Json } = {}): Json => ({
  expectRole: "implement",
  expectModel: "sonnet",
  writes: o.writes ?? { "a.txt": "b\n" },
  ...(o.deletes ? { deletes: o.deletes } : {}),
  output: {
    status: o.status ?? "DONE",
    report: "changed a",
    commit: { type: "fix", subject: "Change the a file." },
    needsHumanDecision: [],
    ...(o.conflict ? { conflict: o.conflict } : {}),
  },
});

function fakeScript(responses: Json[]): string {
  const file = join(tempDir(), "script.json");
  writeFileSync(file, JSON.stringify(responses));
  return file;
}

interface Try {
  outcome: string;
  check: number | null;
  pass: boolean;
  runId: string | null;
  unusedAnswers: number;
  error: string | null;
}
function tries(outDir: string): Try[] {
  const files = readdirSync(outDir).filter((f) => f.endsWith(".json"));
  expect(files.length).toBe(1);
  const res = JSON.parse(readFileSync(join(outDir, files[0] ?? ""), "utf8")) as { tasks: { tries: Try[] }[] };
  return res.tasks.flatMap((t) => t.tries);
}

/** A copy of the eval script in a fake repo root whose bin/cli.mjs is a stub driver (STUB_MODE picks its behaviour). */
function stubRoot(): string {
  const root = tempDir();
  mkdirSync(join(root, "scripts"));
  mkdirSync(join(root, "bin"));
  mkdirSync(join(root, "dist"));
  copyFileSync(EVAL_SCRIPT, join(root, "scripts", "eval.mjs"));
  writeFileSync(join(root, "dist", "index.js"), "");
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "0.0.0" }));
  writeFileSync(
    join(root, "bin", "cli.mjs"),
    `import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
const a = process.argv.slice(2);
if (process.env.STUB_LOG) appendFileSync(process.env.STUB_LOG, JSON.stringify(a) + "\\n");
if (a[0] === "generate") process.exit(0);
const mode = process.env.STUB_MODE;
const folder = (id, run = { status: "waiting", next: "gate:accept", costUsd: 0 }) => {
  mkdirSync(".claude/tmp/runs/" + id, { recursive: true });
  writeFileSync(".claude/tmp/runs/" + id + "/run.json", JSON.stringify(run));
};
if (mode === "none") process.exit(0);
if (mode === "two") { folder("r-20260101-000000"); folder("r-20260101-000001"); process.exit(3); }
if (mode === "gates") { folder("r-20260101-000000"); process.exit(3); }
if (mode === "limit") {
  folder("r-20260101-000000", { status: "waiting", next: "gate:limit", limitReason: "tests-changed", costUsd: 0 });
  process.exit(3);
}
if (mode === "odd") { folder("r-20260101-000000"); process.exit(0); }
if (mode === "crash-stderr") {
  folder("r-20260101-000000");
  process.stdout.write("stdout line\\n");
  process.stderr.write("early line\\nboom line\\n\\n  \\nNode.js v22.0.0\\n\\n");
  process.exit(7);
}
if (mode === "crash-stdout") {
  process.stdout.write("first\\ndriver said no\\n\\n");
  process.stderr.write("Node.js v22.1.0\\n");
  process.exit(2);
}
if (mode === "crash-silent") process.exit(5);
if (a.includes("--resume")) { console.log("Extra answers: refused"); process.exit(1); }
folder("r-20260101-000000");
process.exit(3);
`,
  );
  return join(root, "scripts", "eval.mjs");
}

describe("eval runner answers and error outcomes", () => {
  it("evals1 AC-5: sends one answer per --resume, in order, and reads the outcome again", () => {
    const conflict = { test: "tests/x.test.ts:t", criterion: "AC-1", reason: "wrong" };
    const dir = tasksDir([{ id: "t1", expect: "finished", answers: ["r follow the test", "a"] }]);
    const script = fakeScript([done({ status: "TEST_CONFLICT", conflict }), done()]);
    const r = runEval(["--tasks-dir", dir, "--k", "1", "--yes"], { fakeScript: script });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(tries(r.outDir)[0]).toMatchObject({ outcome: "finished", check: 0, pass: true, unusedAnswers: 0, error: null });
    expect(r.stdout).toContain("t1 1/1: finished · check 0 · pass · ");
  }, 90_000);

  it("evals1 AC-5: each --resume gets exactly one answer, in the order of answers", () => {
    const probe = tempDir();
    const log = join(probe, "log");
    const dir = tasksDir([{ id: "t1", answers: ["first", "second", "third"] }]);
    const r = runEval(["--tasks-dir", dir, "--k", "1", "--yes"], { script: stubRoot(), env: { STUB_MODE: "gates", STUB_LOG: log } });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(tries(r.outDir)[0]).toMatchObject({ outcome: "gate:accept", check: 0, pass: true, unusedAnswers: 0, error: null });
    const runs = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]).filter((a) => a[0] === "run");
    expect(runs).toEqual([
      ["run", "quick", "Change the a file"],
      ["run", "--resume", "r-20260101-000000", "--answer", "first"],
      ["run", "--resume", "r-20260101-000000", "--answer", "second"],
      ["run", "--resume", "r-20260101-000000", "--answer", "third"],
    ]);
  }, 60_000);

  it("evals1 AC-12: a crash exit takes the last stderr line that is not a Node.js version line", () => {
    const probe = tempDir();
    const dir = tasksDir([{ id: "t1", check: `touch ${probe}/checked` }]);
    const r = runEval(["--tasks-dir", dir, "--k", "1", "--yes"], { script: stubRoot(), env: { STUB_MODE: "crash-stderr" } });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(tries(r.outDir)[0]).toMatchObject({ outcome: "error", check: 0, pass: false, error: "boom line" });
    expect(existsSync(join(probe, "checked"))).toBe(true);
  }, 60_000);

  it("evals1 AC-12: a crash exit with only a Node.js line on stderr takes the last stdout line", () => {
    const dir = tasksDir([{ id: "t1" }]);
    const r = runEval(["--tasks-dir", dir, "--k", "1", "--yes"], { script: stubRoot(), env: { STUB_MODE: "crash-stdout" } });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(tries(r.outDir)[0]).toMatchObject({ outcome: "error", check: 0, pass: false, error: "driver said no" });
  }, 60_000);

  it("evals1 AC-12: a silent crash exit records exit <code>", () => {
    const dir = tasksDir([{ id: "t1" }]);
    const r = runEval(["--tasks-dir", dir, "--k", "1", "--yes"], { script: stubRoot(), env: { STUB_MODE: "crash-silent" } });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(tries(r.outDir)[0]).toMatchObject({ outcome: "error", check: 0, pass: false, error: "exit 5" });
  }, 60_000);

  it("evals1 AC-12: an exit that fits no row records unexpected driver state", () => {
    const dir = tasksDir([{ id: "t1" }]);
    const r = runEval(["--tasks-dir", dir, "--k", "1", "--yes"], { script: stubRoot(), env: { STUB_MODE: "odd" } });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(tries(r.outDir)[0]).toMatchObject({ outcome: "error", check: 0, pass: false, error: "unexpected driver state" });
  }, 60_000);

  it("evals1 AC-12: a crash exit records error with the last stderr or stdout line, still runs check, and goes on", () => {
    const probe = tempDir();
    const dir = tasksDir([{ id: "t1", check: `echo x >> ${probe}/checked` }]);
    const script = fakeScript([{ stdout: "not json", exit: 1 }, { stdout: "not json", exit: 1 }]);
    const r = runEval(["--tasks-dir", dir, "--k", "2", "--yes"], { fakeScript: script });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const t = tries(r.outDir);
    expect(t.length).toBe(2);
    for (const x of t) {
      expect(x).toMatchObject({ outcome: "error", check: 0, pass: false });
      expect(x.error).toEqual(expect.any(String));
      expect(x.error).not.toBe("");
      expect(x.error).not.toBe("no run file");
    }
    expect(readFileSync(join(probe, "checked"), "utf8").trim().split("\n").length).toBe(2);
    expect(r.stdout).toContain("t1 1/2: error · check 0 · fail · ");
  }, 90_000);

  it("evals1 AC-12: no run folder records error no run file, still runs check", () => {
    const probe = tempDir();
    const dir = tasksDir([{ id: "t1", check: `touch ${probe}/checked` }]);
    const r = runEval(["--tasks-dir", dir, "--k", "1", "--yes"], { script: stubRoot(), env: { STUB_MODE: "none" } });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(tries(r.outDir)[0]).toMatchObject({ outcome: "error", check: 0, pass: false, runId: null, error: "no run file" });
    expect(existsSync(join(probe, "checked"))).toBe(true);
  }, 60_000);

  it("evals1 AC-12: two run folders record error more than one run folder", () => {
    const dir = tasksDir([{ id: "t1" }]);
    const r = runEval(["--tasks-dir", dir, "--k", "1", "--yes"], { script: stubRoot(), env: { STUB_MODE: "two" } });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(tries(r.outDir)[0]).toMatchObject({ outcome: "error", check: 0, pass: false, error: "more than one run folder" });
  }, 60_000);

  it("evals1 AC-12: a refused --resume records error with the driver's line and counts the answers after it", () => {
    const probe = tempDir();
    const log = join(probe, "log");
    const dir = tasksDir([{ id: "t1", answers: ["a", "b", "c"], check: `touch ${probe}/checked` }]);
    const r = runEval(["--tasks-dir", dir, "--k", "2", "--yes"], { script: stubRoot(), env: { STUB_MODE: "refuse", STUB_LOG: log } });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const t = tries(r.outDir);
    expect(t.length).toBe(2);
    for (const x of t) expect(x).toMatchObject({ outcome: "error", check: 0, pass: false, unusedAnswers: 2, error: "Extra answers: refused" });
    expect(existsSync(join(probe, "checked"))).toBe(true);
    const resumes = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]).filter((a) => a.includes("--resume"));
    expect(resumes.length).toBe(2);
    expect(resumes[0]).toEqual(["run", "--resume", "r-20260101-000000", "--answer", "a"]);
    expect(r.stdout).toContain("2 answers not used");
  }, 60_000);

  it("evals1 AC-20: answers left at a finished run keep the outcome, add the note and count unusedAnswers", () => {
    const dir = tasksDir([{ id: "t1", expect: "finished", answers: ["a", "a", "a"] }]);
    const r = runEval(["--tasks-dir", dir, "--k", "1", "--yes"], { fakeScript: fakeScript([done()]) });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(tries(r.outDir)[0]).toMatchObject({ outcome: "finished", check: 0, pass: true, unusedAnswers: 2 });
    expect(r.stdout).toContain("t1 1/1: finished · check 0 · pass · ");
    expect(r.stdout).toContain(" · 2 answers not used");
  }, 90_000);

  it("evals1 AC-20: answers left at an error outcome send no --resume and count all answers", () => {
    const probe = tempDir();
    const log = join(probe, "log");
    const dir = tasksDir([{ id: "t1", answers: ["a", "b"] }]);
    const r = runEval(["--tasks-dir", dir, "--k", "1", "--yes"], { script: stubRoot(), env: { STUB_MODE: "crash-silent", STUB_LOG: log } });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(tries(r.outDir)[0]).toMatchObject({ outcome: "error", unusedAnswers: 2, error: "exit 5" });
    expect(readFileSync(log, "utf8")).not.toContain("--resume");
    expect(r.stdout).toContain("t1 1/1: error · check 0 · fail · ");
    expect(r.stdout).toContain(" · 2 answers not used · exit 5");
  }, 60_000);

  it("evals1 AC-25: shell syntax in the description and an answer is one argv entry, unchanged", () => {
    const probe = tempDir();
    const description = `Fix $(touch ${probe}/x); 'it' "now"`;
    const answer = `r $(touch ${probe}/y); "q" 'z'`;
    const check = `cp .claude/tmp/runs/*/run.json ${probe}/run.json`;
    const dir = tasksDir([{ id: "t1", description, answers: [answer], expect: "gate:accept", check }]);
    const conflict = { test: "tests/x.test.ts:t", criterion: "AC-1", reason: "wrong" };
    const script = fakeScript([done({ status: "TEST_CONFLICT", conflict }), done()]);
    const r = runEval(["--tasks-dir", dir, "--k", "1", "--yes"], { fakeScript: script, env: { FAKE_CLAUDE_LOG: join(probe, "claude.log") } });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(existsSync(join(probe, "x"))).toBe(false);
    expect(existsSync(join(probe, "y"))).toBe(false);
    const t = tries(r.outDir)[0];
    expect(t).toMatchObject({ outcome: "gate:accept", pass: true });
    const run = JSON.parse(readFileSync(join(probe, "run.json"), "utf8")) as { description: string };
    expect(run.description).toBe(description);
    const prompts = readFileSync(join(probe, "claude.log"), "utf8");
    expect(prompts).toContain(`touch ${probe}/x`);
    expect(prompts).toContain(`touch ${probe}/y`);
  }, 90_000);

  it("evals1 AC-26: the answer a is sent at gate:limit tests-changed, and the try still fails by its check", () => {
    const frozen = 'it("a", () => {\n  expect(1).toBe(1);\n});\n';
    const dir = tasksDir([
      { id: "t1", answers: ["a"], files: { "tests/readme.test.ts": frozen }, check: "test -f tests/readme.test.ts" },
    ]);
    const script = fakeScript([done({ deletes: ["tests/readme.test.ts"] })]);
    const r = runEval(["--tasks-dir", dir, "--k", "1", "--yes"], { fakeScript: script });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(tries(r.outDir)[0]).toMatchObject({ outcome: "gate:accept", check: 1, pass: false, unusedAnswers: 0 });
  }, 90_000);

  it("evals1 AC-26: at gate:limit tests-changed the answer a goes to --resume as given", () => {
    const probe = tempDir();
    const log = join(probe, "log");
    const dir = tasksDir([{ id: "t1", answers: ["a"], expect: "gate:limit tests-changed", check: "false" }]);
    const r = runEval(["--tasks-dir", dir, "--k", "1", "--yes"], { script: stubRoot(), env: { STUB_MODE: "limit", STUB_LOG: log } });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const runs = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]).filter((a) => a[0] === "run");
    expect(runs).toEqual([
      ["run", "quick", "Change the a file"],
      ["run", "--resume", "r-20260101-000000", "--answer", "a"],
    ]);
    expect(tries(r.outDir)[0]).toMatchObject({ outcome: "gate:limit tests-changed", check: 1, pass: false, unusedAnswers: 0 });
  }, 60_000);
});
