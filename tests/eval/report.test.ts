import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { makeFakeExecutable } from "../run/engine-fixture.js";
import { REPO_ROOT, runEval, tempDir } from "./helpers.js";

beforeAll(makeFakeExecutable);

type Json = Record<string, unknown>;

/** A tasks dir with tiny tasks: a fixture with a.txt. */
function tasksDir(ids: string[], check = "true"): string {
  const dir = tempDir();
  for (const id of ids) {
    const fixture = join(dir, id, "fixture");
    mkdirSync(fixture, { recursive: true });
    writeFileSync(join(fixture, "a.txt"), "a\n");
    writeFileSync(
      join(dir, id, "task.json"),
      JSON.stringify({ mode: "quick", description: "Change the a file", fixture: "fixture", check, expect: "gate:accept" }),
    );
  }
  return dir;
}

const output = { status: "DONE", report: "changed a", commit: { type: "fix", subject: "Change the a file." }, needsHumanDecision: [] };

/** A fake script file with `n` implement responses; `stdout` replaces the claude result line. */
function fakeScript(n: number, stdout?: Json): string {
  const response: Json = { expectRole: "implement", expectModel: "sonnet", writes: { "a.txt": "b\n" }, output };
  if (stdout !== undefined) response.stdout = stdout;
  const file = join(tempDir(), "script.json");
  writeFileSync(file, JSON.stringify(Array.from({ length: n }, () => response)));
  return file;
}

function results(outDir: string): Json {
  const files = readdirSync(outDir).filter((f) => f.endsWith(".json"));
  expect(files.length).toBe(1);
  return JSON.parse(readFileSync(join(outDir, files[0] ?? ""), "utf8")) as Json;
}

const git = (...args: string[]): string => spawnSync("git", args, { cwd: REPO_ROOT, encoding: "utf8" }).stdout;

/** Every file under `dir` with its sha256, sorted; "missing" when the folder does not exist. */
function listing(dir: string): string {
  if (!existsSync(dir)) return "missing";
  const lines: string[] = [];
  const walk = (d: string): void => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) {
        lines.push(`${p}/`);
        walk(p);
      } else lines.push(`${p} ${createHash("sha256").update(readFileSync(p)).digest("hex")}`);
    }
  };
  walk(dir);
  return lines.sort().join("\n");
}

describe("eval runner report edge cases", () => {
  it("evals1 AC-15: an --out that is a file still prints the header, task and totals lines, then cannot write, exit 1", () => {
    const file = join(tempDir(), "out-file");
    writeFileSync(file, "x");
    const r = runEval(["--tasks-dir", tasksDir(["t1"]), "--k", "1", "--yes", "--out", file], { fakeScript: fakeScript(1) });
    expect(r.code, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toContain("1 task × 1 try = 1 try");
    expect(r.stdout).toContain("t1 1/1: gate:accept");
    expect(r.stdout).toMatch(/^task +expect +tries +passed/m);
    expect(r.stdout).toMatch(/^total: 1 task · 1 try · /m);
    expect(`${r.stdout}${r.stderr}`).toMatch(/cannot write \S+\.json/);
    expect(r.stdout).not.toContain("results:");
    expect(readFileSync(file, "utf8")).toBe("x");
  }, 60_000);

  it("evals1 AC-15: an out dir with no write access gives the same", () => {
    const out = join(tempDir(), "ro");
    mkdirSync(out);
    chmodSync(out, 0o555);
    try {
      const r = runEval(["--tasks-dir", tasksDir(["t1"]), "--k", "1", "--yes", "--out", out], { fakeScript: fakeScript(1) });
      if (process.getuid?.() === 0) return; // root can write anywhere
      expect(r.code, r.stdout + r.stderr).toBe(1);
      expect(r.stdout).toMatch(/^total: /m);
      expect(`${r.stdout}${r.stderr}`).toContain(`cannot write ${out}`);
    } finally {
      chmodSync(out, 0o755);
    }
  }, 60_000);

  it("evals1 AC-17: an eval run changes nothing in the repo except the results file in the out dir", () => {
    const tasks = tasksDir(["t1"]);
    const runsDir = join(REPO_ROOT, ".claude", "tmp", "runs");
    const snap = () => ({
      status: git("--no-optional-locks", "status", "--porcelain"),
      head: git("rev-parse", "HEAD"),
      tasks: listing(tasks),
      runs: listing(runsDir),
    });
    const before = snap();
    const r = runEval(["--tasks-dir", tasks, "--k", "1", "--yes"], { fakeScript: fakeScript(1) });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(snap()).toEqual(before);
    expect(readdirSync(r.outDir).filter((f) => f.endsWith(".json")).length).toBe(1);
  }, 60_000);

  it("evals1 AC-19: --keep keeps each temp copy, names it in the try line, and the results file never holds the path", () => {
    const r = runEval(["--tasks-dir", tasksDir(["t1"]), "--k", "2", "--yes", "--keep"], { fakeScript: fakeScript(2) });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const kept = [...r.stdout.matchAll(/^t1 \d\/2: .* · kept (\S+)$/gm)].map((m) => m[1] ?? "");
    try {
      expect(kept.length).toBe(2);
      expect(new Set(kept).size).toBe(2);
      for (const p of kept) {
        expect(statSync(p).isDirectory()).toBe(true);
        expect(existsSync(join(p, ".git"))).toBe(true);
      }
      const text = readFileSync(join(r.outDir, readdirSync(r.outDir)[0] ?? ""), "utf8");
      expect(text).not.toContain("kept");
      for (const p of kept) expect(text).not.toContain(p);
    } finally {
      for (const p of kept) rmSync(p, { recursive: true, force: true });
    }
  }, 60_000);

  it("evals1 AC-19: without --keep no try line says kept", () => {
    const r = runEval(["--tasks-dir", tasksDir(["t1"]), "--k", "1", "--yes"], { fakeScript: fakeScript(1) });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).not.toContain("kept");
  }, 60_000);

  it("evals1 AC-23: an unknown cost is named in the try line and the totals line and counted in the results file", () => {
    const noCost = { type: "result", subtype: "success", is_error: false, num_turns: 3, permission_denials: [], structured_output: output };
    const r = runEval(["--tasks-dir", tasksDir(["t1"]), "--k", "2", "--yes"], { fakeScript: fakeScript(2, noCost) });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const tries = r.stdout.split("\n").filter((l) => /^t1 \d\/2: /.test(l));
    expect(tries.length).toBe(2);
    for (const l of tries) expect(l).toMatch(/ · \d+:\d\d · \d+ calls? with unknown cost/);
    const total = r.stdout.split("\n").find((l) => l.startsWith("total: ")) ?? "";
    expect(total).toMatch(/ · \d+ calls with unknown cost · k 2 · /);
    const totals = results(r.outDir).totals as Json;
    expect(totals.triesWithUnknownCost).toBe(2);
    expect(totals.costUnknownCalls).toBeGreaterThanOrEqual(2);
    expect(total).toContain(`${String(totals.costUnknownCalls)} calls with unknown cost`);
  }, 60_000);

  it("evals1 AC-23: a known cost adds no unknown-cost suffix", () => {
    const r = runEval(["--tasks-dir", tasksDir(["t1"]), "--k", "1", "--yes"], { fakeScript: fakeScript(1) });
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).not.toContain("unknown cost");
    expect((results(r.outDir).totals as Json).triesWithUnknownCost).toBe(0);
  }, 60_000);
});
