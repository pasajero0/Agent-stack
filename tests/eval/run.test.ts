import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { makeFakeExecutable } from "../run/engine-fixture.js";
import { runEval, tempDir } from "./helpers.js";

beforeAll(makeFakeExecutable);

type Json = Record<string, unknown>;

interface TaskDef {
  id: string;
  expect?: string;
  check?: string;
  description?: string;
  /** Extra fixture files, path → content. */
  files?: Record<string, string>;
}

/** A tasks dir with tiny tasks: a fixture with a.txt and the given extra files. */
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
      }),
    );
  }
  return dir;
}

/** One implement response: writes a.txt, DONE. Quick mode then commits and stops at gate:accept (exit 3). */
const implResponse = (): Json => ({
  expectRole: "implement",
  expectModel: "sonnet",
  writes: { "a.txt": "b\n" },
  output: { status: "DONE", report: "changed a", commit: { type: "fix", subject: "Change the a file." }, needsHumanDecision: [] },
});

/** A fake script file with `n` implement responses. */
function fakeScript(n: number): string {
  const file = join(tempDir(), "script.json");
  writeFileSync(file, JSON.stringify(Array.from({ length: n }, implResponse)));
  return file;
}

function results(outDir: string): Json {
  const files = readdirSync(outDir).filter((f) => f.endsWith(".json"));
  expect(files.length).toBe(1);
  return JSON.parse(readFileSync(join(outDir, files[0] ?? ""), "utf8")) as Json;
}

interface Try {
  n: number;
  outcome: string;
  check: number | null;
  pass: boolean;
  runId: string | null;
  costUsd: number;
  costUnknownCalls: number;
  durationSec: number;
  unusedAnswers: number;
  error: string | null;
}
interface TaskResult {
  id: string;
  expect: string;
  tries: Try[];
  passed: number;
  pass1: number;
  passK: number;
}
const tasksOf = (r: Json): TaskResult[] => r.tasks as TaskResult[];

const TRY_KEYS = ["n", "outcome", "check", "pass", "runId", "costUsd", "costUnknownCalls", "durationSec", "unusedAnswers", "error"];

describe("eval runner try loop", () => {
  it("evals1 AC-3: prepares a temp copy with git, the deployed harness and one commit on main, then removes it", () => {
    const probe = tempDir();
    const check = [
      `pwd -P > ${probe}/pwd`,
      `git rev-list --count main > ${probe}/count`,
      `git config --local user.name > ${probe}/name`,
      `git config --local user.email > ${probe}/email`,
      `git config --local commit.gpgsign > ${probe}/gpg`,
      `git ls-tree -r --name-only main > ${probe}/files`,
      `git log main -1 --format=%P > ${probe}/parents`,
    ].join("; ");
    const r = runEval(["--tasks-dir", tasksDir([{ id: "t1", check }]), "--k", "1", "--yes"], { fakeScript: fakeScript(1) });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const dir = readFileSync(join(probe, "pwd"), "utf8").trim();
    expect(basename(dir)).toMatch(/^agent-stack-eval-/);
    expect(dir.startsWith(realpathSync(tmpdir()))).toBe(true);
    expect(existsSync(dir)).toBe(false);
    expect(readFileSync(join(probe, "count"), "utf8").trim()).toBe("1");
    expect(readFileSync(join(probe, "name"), "utf8").trim()).not.toBe("");
    expect(readFileSync(join(probe, "email"), "utf8").trim()).not.toBe("");
    expect(readFileSync(join(probe, "gpg"), "utf8").trim()).toBe("false");
    expect(readFileSync(join(probe, "parents"), "utf8").trim()).toBe("");
    const files = readFileSync(join(probe, "files"), "utf8").split("\n");
    expect(files).toContain("a.txt");
    expect(files).toContain(".claude/gates.json");
  }, 60_000);

  it("evals1 AC-4: runs run quick with the description and reads the outcome and the run id from the one run folder", () => {
    const probe = tempDir();
    const check = `ls .claude/tmp/runs > ${probe}/runs; git log -1 --format=%s > ${probe}/subject`;
    const r = runEval(["--tasks-dir", tasksDir([{ id: "t1", check }]), "--k", "1", "--yes"], { fakeScript: fakeScript(1) });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const t = tasksOf(results(r.outDir))[0]?.tries[0];
    expect(t?.outcome).toBe("gate:accept");
    expect(t?.runId).toMatch(/^r-[0-9]{8}-[0-9]{6}$/);
    expect(readFileSync(join(probe, "runs"), "utf8").split("\n")).toContain(t?.runId);
    expect(readFileSync(join(probe, "subject"), "utf8").trim()).toBe("fix(quick): change the a file");
    expect(r.stdout).toContain("t1 1/1: gate:accept · check 0 · pass · $0.01 · ");
  }, 60_000);

  it("evals1 AC-6: scores pass only when the outcome equals expect and the check exits 0, and records every try field", () => {
    const dir = tasksDir([
      { id: "a-ok", check: "true" },
      { id: "b-check-fails", check: "exit 4" },
      { id: "c-wrong-outcome", check: "true", expect: "finished" },
    ]);
    const r = runEval(["--tasks-dir", dir, "--k", "1", "--yes"], { fakeScript: fakeScript(3) });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const [a, b, c] = tasksOf(results(r.outDir)).map((t) => t.tries[0]);
    for (const t of [a, b, c]) {
      expect(Object.keys(t ?? {}).sort()).toEqual([...TRY_KEYS].sort());
      expect(t?.costUsd).toBe(0.01);
      expect(t?.costUnknownCalls).toBe(0);
      expect(t?.unusedAnswers).toBe(0);
      expect(t?.error).toBeNull();
      expect(Number.isInteger(t?.durationSec)).toBe(true);
      expect(t?.runId).toMatch(/^r-/);
    }
    expect(a).toMatchObject({ n: 1, outcome: "gate:accept", check: 0, pass: true });
    expect(b).toMatchObject({ n: 1, outcome: "gate:accept", check: 4, pass: false });
    expect(c).toMatchObject({ n: 1, outcome: "gate:accept", check: 0, pass: false });
    expect(r.stdout).toContain("b-check-fails 1/1: gate:accept · check 4 · fail · $0.01 · ");
    expect(r.stdout).toContain("c-wrong-outcome 1/1: gate:accept · check 0 · fail · $0.01 · ");
  }, 60_000);

  it("evals1 AC-7: prints the header, task and totals lines with exact pass@1 and pass^k, writes the results file and exits 0", () => {
    const flags = tempDir();
    // b-half fails its first try only: the check passes once the flag file exists.
    const half = `test -f ${flags}/flag && exit 0; touch ${flags}/flag; exit 1`;
    const dir = tasksDir([{ id: "a-all" }, { id: "b-half", check: half }]);
    const startDay = new Date();
    const r = runEval(["--tasks-dir", dir, "--k", "2", "--yes"], { fakeScript: fakeScript(4) });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const lines = r.stdout.trim().split("\n");
    const pad = (n: number): string => String(n).padStart(2, "0");
    const day = `${startDay.getFullYear()}-${pad(startDay.getMonth() + 1)}-${pad(startDay.getDate())}`;

    expect(lines[0]).toBe("2 tasks × 2 tries = 4 tries, about $0.40 with the real claude.");
    expect(lines.slice(1, 5).map((l) => l.split(":")[0])).toEqual(["a-all 1/2", "a-all 2/2", "b-half 1/2", "b-half 2/2"]);
    expect(lines[5]?.split(/\s+/)).toEqual(["task", "expect", "tries", "passed", "pass@1", "pass^2", "cost", "time"]);
    expect(lines[6]?.split(/\s+/).slice(0, 7)).toEqual(["a-all", "gate:accept", "2", "2", "1.00", "1", "$0.02"]);
    expect(lines[7]?.split(/\s+/).slice(0, 7)).toEqual(["b-half", "gate:accept", "2", "1", "0.50", "0", "$0.02"]);
    expect(lines[6]).toMatch(/ [0-9]+:[0-5][0-9]$/);
    expect(lines[8]).toMatch(
      new RegExp(`^total: 2 tasks · 4 tries · 3 passed · pass@1 0\\.75 · pass\\^2 0\\.50 · \\$0\\.04 · [0-9]+:[0-5][0-9] · k 2 · ${day}$`),
    );
    const file = readdirSync(r.outDir)[0] ?? "";
    expect(file).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{6}\.json$/);
    expect(lines[9]).toBe(`results: ${join(r.outDir, file)}`);
    expect(lines.length).toBe(10);

    const res = results(r.outDir);
    expect(Object.keys(res)).toEqual(["version", "startedAt", "finishedAt", "k", "agentStack", "commit", "dirty", "claude", "tasks", "totals"]);
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8")) as { version: string };
    expect(res).toMatchObject({ version: 1, k: 2, agentStack: pkg.version, claude: "fake-claude.mjs" });
    const stamp = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[+-][0-9]{2}:[0-9]{2}$/;
    expect(res.startedAt).toMatch(stamp);
    expect(res.finishedAt).toMatch(stamp);
    expect(file.slice(0, 10)).toBe(String(res.startedAt).slice(0, 10));
    expect(file.slice(11, 17)).toBe(String(res.startedAt).slice(11, 19).replaceAll(":", ""));
    expect(res.commit === null || /^[0-9a-f]{40}$/.test(String(res.commit))).toBe(true);
    expect(res.dirty === null || typeof res.dirty === "boolean").toBe(true);
    const [a, b] = tasksOf(res);
    expect(Object.keys(a ?? {})).toEqual(["id", "expect", "tries", "passed", "pass1", "passK"]);
    expect(a).toMatchObject({ id: "a-all", expect: "gate:accept", passed: 2, pass1: 1, passK: 1 });
    expect(b).toMatchObject({ id: "b-half", expect: "gate:accept", passed: 1, pass1: 0.5, passK: 0 });
    expect(b?.tries.map((t) => [t.n, t.pass])).toEqual([[1, false], [2, true]]);
    const totals = res.totals as Json;
    expect(Object.keys(totals)).toEqual(["tasks", "tries", "passed", "pass1", "passK", "costUsd", "costUnknownCalls", "triesWithUnknownCost", "durationSec"]);
    expect(totals).toMatchObject({ tasks: 2, tries: 4, passed: 3, pass1: 0.75, passK: 0.5, costUsd: 0.04, costUnknownCalls: 0, triesWithUnknownCost: 0 });
    const sum = [...(a?.tries ?? []), ...(b?.tries ?? [])].reduce((s, t) => s + t.durationSec, 0);
    expect(totals.durationSec).toBe(sum);
  }, 120_000);

  it("evals1 AC-7: pass@1 rounds a third to 0.33 and the claude field is the base name of AGENT_STACK_CLAUDE", () => {
    const flags = tempDir();
    const once = `test -f ${flags}/flag && exit 1; touch ${flags}/flag; exit 0`;
    const r = runEval(["--tasks-dir", tasksDir([{ id: "t1", check: once }]), "--k", "3", "--yes"], { fakeScript: fakeScript(3) });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const res = results(r.outDir);
    expect(res.claude).toBe("fake-claude.mjs");
    expect(tasksOf(res)[0]).toMatchObject({ passed: 1, pass1: 0.33, passK: 0 });
    expect(res.totals).toMatchObject({ pass1: 0.33, passK: 0, costUsd: 0.03 });
    expect(r.stdout).toMatch(/total: 1 task · 3 tries · 1 passed · pass@1 0\.33 · pass\^3 0\.00 · \$0\.03 · /);
  }, 120_000);

  it("evals1 AC-13: a failing generate or commit records prepare: <part> failed, starts no driver, runs no check, goes on", () => {
    const probe = tempDir();
    const dir = tasksDir([
      // generate refuses a repo that already has .claude/.
      { id: "a-generate", files: { ".claude/x.txt": "x" }, check: `touch ${probe}/a-checked` },
      // `*` in .gitignore leaves nothing to commit.
      { id: "b-commit", files: { ".gitignore": "*\n" }, check: `touch ${probe}/b-checked` },
    ]);
    const script = fakeScript(1);
    const r = runEval(["--tasks-dir", dir, "--k", "2", "--yes"], { fakeScript: script });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(existsSync(`${r.scriptCopy ?? ""}.idx`)).toBe(false);
    expect(existsSync(join(probe, "a-checked"))).toBe(false);
    expect(existsSync(join(probe, "b-checked"))).toBe(false);
    const [a, b] = tasksOf(results(r.outDir));
    for (const [t, part] of [[a, "generate"], [b, "commit"]] as const) {
      expect(t?.tries.length).toBe(2);
      for (const x of t?.tries ?? []) {
        expect(x).toMatchObject({ outcome: "error", check: null, pass: false, durationSec: 0, runId: null, costUsd: 0, error: `prepare: ${part} failed` });
      }
    }
    expect(r.stdout).toContain("a-generate 1/2: error · check - · fail · $0.00 · 0:00 · prepare: generate failed");
    expect(r.stdout).toContain("b-commit 2/2: error · check - · fail · $0.00 · 0:00 · prepare: commit failed");
    expect(r.stdout).toContain("total: 2 tasks · 4 tries · 0 passed · pass@1 0.00 · pass^2 0.00 · $0.00 · 0:00 · k 2 · ");
  }, 120_000);

  it("evals1 AC-21: a results file of the same name gets -2, -3, … and no file is overwritten", () => {
    const out = join(tempDir(), "out");
    mkdirSync(out);
    const pad = (n: number): string => String(n).padStart(2, "0");
    const now = Date.now();
    const taken = new Map<string, string>();
    // Every name the eval run may pick in the next 30 s, base and -2, so it must reach -3.
    for (let s = -1; s < 30; s++) {
      const d = new Date(now + s * 1000);
      const name = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
      for (const f of [`${name}.json`, `${name}-2.json`]) {
        writeFileSync(join(out, f), `sentinel ${f}`);
        taken.set(f, `sentinel ${f}`);
      }
    }
    const dir = tasksDir([{ id: "a-generate", files: { ".claude/x.txt": "x" } }]);
    const r = runEval(["--tasks-dir", dir, "--k", "1", "--yes", "--out", out]);
    expect(r.code, r.stdout + r.stderr).toBe(0);
    for (const [f, content] of taken) expect(readFileSync(join(out, f), "utf8")).toBe(content);
    const added = readdirSync(out).filter((f) => !taken.has(f));
    expect(added.length).toBe(1);
    expect(added[0]).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}-[0-9]{6}-3\.json$/);
    expect(r.stdout).toContain(`results: ${join(out, added[0] ?? "")}`);
  }, 60_000);
});
