/** Try timeout (AC-14) and signals (AC-16): the eval runner stops the running child and leaves no orphan process. */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { makeFakeExecutable } from "../run/engine-fixture.js";
import { copyEvalScript, EVAL_SCRIPT, FAKE, tempDir } from "./helpers.js";

beforeAll(makeFakeExecutable);

type Json = Record<string, unknown>;

interface Try {
  n: number;
  outcome: string;
  check: number | null;
  pass: boolean;
  runId: string | null;
  costUsd: number;
  costUnknownCalls: number;
  durationSec: number;
  error: string | null;
}

interface Ran {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
  outDir: string;
  ms: number;
}

function tasksDir(check: string, expectOutcome = "gate:accept"): string {
  const dir = tempDir();
  const fixture = join(dir, "t1", "fixture");
  mkdirSync(fixture, { recursive: true });
  writeFileSync(join(fixture, "a.txt"), "a\n");
  writeFileSync(
    join(dir, "t1", "task.json"),
    JSON.stringify({ mode: "quick", description: "Change the a file", fixture: "fixture", check, expect: expectOutcome }),
  );
  return dir;
}

/** A sleeping implement response of the fake claude. */
const sleeping = (): Json => ({
  expectRole: "implement",
  expectModel: "sonnet",
  sleepMs: 120_000,
  writes: { "a.txt": "b\n" },
  output: { status: "DONE", report: "changed a", commit: { type: "fix", subject: "Change the a file." }, needsHumanDecision: [] },
});

/** A claude wrapper that logs "<pid> <cwd>" and then becomes the fake (exec keeps the pid). */
function claudeWrapper(pidLog: string): string {
  const file = join(tempDir(), "claude");
  writeFileSync(file, `#!/bin/sh\necho "$$ $PWD" >> '${pidLog}'\nexec '${process.execPath}' '${FAKE}' "$@"\n`, { mode: 0o755 });
  return file;
}

/** A copy of the eval script in a fake repo root whose bin/cli.mjs is a stub (STUB_MODE picks its behaviour). */
function stubRoot(): string {
  const root = tempDir();
  for (const d of ["bin", "dist"]) mkdirSync(join(root, d));
  copyEvalScript(root);
  writeFileSync(join(root, "dist", "index.js"), "");
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "0.0.0" }));
  writeFileSync(
    join(root, "bin", "cli.mjs"),
    `import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
const a = process.argv.slice(2);
const mode = process.env.STUB_MODE;
if (process.env.STUB_LOG) appendFileSync(process.env.STUB_LOG, JSON.stringify(a) + "\\n");
/** A grandchild in this process group; its pid goes to STUB_PIDS. */
const hang = () => {
  const c = spawn("sleep", ["120"], { stdio: "ignore" });
  appendFileSync(process.env.STUB_PIDS, c.pid + "\\n");
  setInterval(() => {}, 1000);
};
if (a[0] === "generate") {
  if (mode === "hang-generate") hang();
  else process.exit(0);
} else {
  mkdirSync(".claude/tmp/runs/r-20260101-000000", { recursive: true });
  const run = { status: "waiting", next: "gate:accept", costUsd: 0.25, costUnknownCalls: 1 };
  writeFileSync(".claude/tmp/runs/r-20260101-000000/run.json", JSON.stringify(run));
  if (mode === "deaf-driver") {
    process.on("SIGTERM", () => {});
    hang();
  } else process.exit(3);
}
`,
  );
  return join(root, "scripts", "eval.mjs");
}

function fakeScript(responses: Json[]): string {
  const file = join(tempDir(), "script.json");
  writeFileSync(file, JSON.stringify(responses));
  return file;
}

/** Starts the eval runner; `onStart` may send it a signal. */
function startEval(args: string[], env: Record<string, string>, script = EVAL_SCRIPT) {
  const outDir = join(tempDir(), "out");
  mkdirSync(outDir, { recursive: true });
  const started = Date.now();
  const child = spawn(process.execPath, [script, ...args, "--out", outDir], {
    env: { ...process.env, AGENT_STACK_CLAUDE: FAKE, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d: Buffer) => (stdout += String(d)));
  child.stderr.on("data", (d: Buffer) => (stderr += String(d)));
  const done = new Promise<Ran>((resolve) => {
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr, outDir, ms: Date.now() - started }));
  });
  return { child, done };
}

function tries(outDir: string): Try[] {
  const files = readdirSync(outDir).filter((f) => f.endsWith(".json"));
  expect(files.length).toBe(1);
  const res = JSON.parse(readFileSync(join(outDir, files[0] ?? ""), "utf8")) as { tasks: { tries: Try[] }[] };
  return res.tasks.flatMap((t) => t.tries);
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const pids = (file: string): number[] =>
  existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter((l) => l !== "").map((l) => Number(l.split(" ")[0])) : [];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(test: () => boolean, ms = 40_000): Promise<void> {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) throw new Error("waited too long");
    await sleep(100);
  }
}

/** Orphans may need a moment to be reaped after SIGKILL. */
async function expectDead(list: number[]): Promise<void> {
  expect(list.length).toBeGreaterThan(0);
  await waitFor(() => list.every((p) => !alive(p)), 3000).catch(() => undefined);
  for (const p of list) expect(alive(p), `pid ${p} is still alive`).toBe(false);
}

describe("eval runner try timeout", () => {
  it("evals1 AC-14: a timeout in the driver sends SIGTERM, records error timeout with no check, takes the cost from the run file and goes on", async () => {
    const probe = tempDir();
    const pidLog = join(probe, "pids");
    const dir = tasksDir(`echo x >> ${probe}/checked`);
    const { done } = startEval(["--tasks-dir", dir, "--k", "2", "--yes", "--keep", "--timeout-min", "0.15"], {
      AGENT_STACK_CLAUDE: claudeWrapper(pidLog),
      FAKE_CLAUDE_SCRIPT: fakeScript([sleeping(), sleeping()]),
    });
    const r = await done;
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const t = tries(r.outDir);
    expect(t.length).toBe(2);
    const kept = [...r.stdout.matchAll(/ · kept (\S+)/g)].map((m) => m[1] ?? "");
    expect(kept.length).toBe(2);
    t.forEach((x, i) => {
      expect(x).toMatchObject({ outcome: "error", error: "timeout", check: null, pass: false });
      expect(x.runId).toEqual(expect.any(String));
      const run = JSON.parse(readFileSync(join(kept[i] ?? "", ".claude", "tmp", "runs", x.runId ?? "", "run.json"), "utf8")) as Json;
      expect(x.costUsd).toBe(typeof run.costUsd === "number" ? Math.round(run.costUsd * 100) / 100 : 0);
      expect(x.costUnknownCalls).toBe(typeof run.costUnknownCalls === "number" ? run.costUnknownCalls : 0);
    });
    expect(existsSync(join(probe, "checked"))).toBe(false);
    expect(r.stdout).toContain("t1 1/2: error · check - · fail · ");
    expect(r.stdout).toContain("t1 2/2: error · check - · fail · ");
    await expectDead(pids(pidLog));
  }, 120_000);

  it("evals1 AC-14: a driver that ignores SIGTERM gets SIGKILL to its process group after 10 s", async () => {
    const probe = tempDir();
    const stubPids = join(probe, "pids");
    const dir = tasksDir(`touch ${probe}/checked`);
    const { done } = startEval(
      ["--tasks-dir", dir, "--k", "1", "--yes", "--timeout-min", "0.05"],
      { STUB_MODE: "deaf-driver", STUB_PIDS: stubPids },
      stubRoot(),
    );
    const r = await done;
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.ms).toBeGreaterThanOrEqual(13_000);
    expect(tries(r.outDir)[0]).toMatchObject({
      outcome: "error", error: "timeout", check: null, pass: false, runId: "r-20260101-000000", costUsd: 0.25, costUnknownCalls: 1,
    });
    expect(existsSync(join(probe, "checked"))).toBe(false);
    await expectDead(pids(stubPids));
  }, 60_000);

  it("evals1 AC-14: a timeout in the check sends SIGKILL to its process group and records check null", async () => {
    const probe = tempDir();
    const dir = tasksDir(`sleep 120 & echo $! > ${probe}/pids; wait`);
    const { done } = startEval(["--tasks-dir", dir, "--k", "1", "--yes", "--timeout-min", "0.05"], { STUB_MODE: "gates" }, stubRoot());
    const r = await done;
    expect(r.code, r.stdout + r.stderr).toBe(0);
    expect(r.ms).toBeLessThan(13_000);
    expect(tries(r.outDir)[0]).toMatchObject({
      outcome: "error", error: "timeout", check: null, pass: false, runId: "r-20260101-000000", costUsd: 0.25, costUnknownCalls: 1,
    });
    expect(r.stdout).toContain("t1 1/1: error · check - · fail · ");
    await expectDead(pids(join(probe, "pids")));
  }, 60_000);

  it("evals1 AC-14: a timeout in prepare records timeout and durationSec 0, starts no driver, and goes on", async () => {
    const probe = tempDir();
    const stubPids = join(probe, "pids");
    const log = join(probe, "log");
    const dir = tasksDir(`touch ${probe}/checked`);
    const { done } = startEval(
      ["--tasks-dir", dir, "--k", "2", "--yes", "--timeout-min", "0.03"],
      { STUB_MODE: "hang-generate", STUB_PIDS: stubPids, STUB_LOG: log },
      stubRoot(),
    );
    const r = await done;
    expect(r.code, r.stdout + r.stderr).toBe(0);
    const t = tries(r.outDir);
    expect(t.length).toBe(2);
    for (const x of t) {
      expect(x).toMatchObject({ outcome: "error", error: "timeout", check: null, pass: false, runId: null, durationSec: 0, costUsd: 0 });
    }
    expect(readFileSync(log, "utf8")).not.toContain('"run"');
    expect(existsSync(join(probe, "checked"))).toBe(false);
    await expectDead(pids(stubPids));
  }, 60_000);
});

describe("eval runner signals", () => {
  const SIGNALS: [NodeJS.Signals, number][] = [
    ["SIGINT", 130],
    ["SIGTERM", 143],
    ["SIGHUP", 129],
  ];

  it.each(SIGNALS)("evals1 AC-16: %s stops the driver, removes the temp copy, writes no results file and exits %i", async (sig, code) => {
    const probe = tempDir();
    const pidLog = join(probe, "pids");
    const dir = tasksDir(`touch ${probe}/checked`);
    const { child, done } = startEval(["--tasks-dir", dir, "--k", "2", "--yes"], {
      AGENT_STACK_CLAUDE: claudeWrapper(pidLog),
      FAKE_CLAUDE_SCRIPT: fakeScript([sleeping(), sleeping()]),
    });
    await waitFor(() => pids(pidLog).length > 0);
    const cwd = readFileSync(pidLog, "utf8").trim().split(" ").slice(1).join(" ");
    expect(existsSync(cwd)).toBe(true);
    child.kill(sig);
    const r = await done;
    expect(r.code, r.stdout + r.stderr).toBe(code);
    expect(readdirSync(r.outDir)).toEqual([]);
    expect(existsSync(cwd)).toBe(false);
    expect(existsSync(join(probe, "checked"))).toBe(false);
    expect(pids(pidLog).length).toBe(1);
    await expectDead(pids(pidLog));
  }, 60_000);

  it("evals1 AC-16: with --keep a signal keeps the temp copy of the try that runs", async () => {
    const probe = tempDir();
    const pidLog = join(probe, "pids");
    const dir = tasksDir("true");
    const { child, done } = startEval(["--tasks-dir", dir, "--k", "1", "--yes", "--keep"], {
      AGENT_STACK_CLAUDE: claudeWrapper(pidLog),
      FAKE_CLAUDE_SCRIPT: fakeScript([sleeping()]),
    });
    await waitFor(() => pids(pidLog).length > 0);
    const cwd = readFileSync(pidLog, "utf8").trim().split(" ").slice(1).join(" ");
    child.kill("SIGINT");
    const r = await done;
    expect(r.code, r.stdout + r.stderr).toBe(130);
    expect(readdirSync(r.outDir)).toEqual([]);
    expect(existsSync(cwd)).toBe(true);
    await expectDead(pids(pidLog));
  }, 60_000);

  it("evals1 AC-16: a signal during the check sends SIGKILL to its process group and exits 128 + the signal number", async () => {
    const probe = tempDir();
    const pidFile = join(probe, "pids");
    const dir = tasksDir(`sleep 120 & echo $! > ${pidFile}; wait`);
    const { child, done } = startEval(["--tasks-dir", dir, "--k", "1", "--yes"], { STUB_MODE: "gates" }, stubRoot());
    await waitFor(() => pids(pidFile).length > 0);
    child.kill("SIGTERM");
    const r = await done;
    expect(r.code, r.stdout + r.stderr).toBe(143);
    expect(readdirSync(r.outDir)).toEqual([]);
    await expectDead(pids(pidFile));
  }, 60_000);
});
