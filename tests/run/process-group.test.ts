import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runCheck } from "../../src/run/checks.js";
import { callClaude, type CallIo } from "../../src/run/claude.js";
import { killGroup, killLiveGroups, liveGroups } from "../../src/run/process-group.js";

// Defect 49: what a check or a role call started must not outlive it.

const FAKE = fileURLToPath(new URL("./fake-claude.mjs", import.meta.url));
const DRIVER = fileURLToPath(new URL("./driver-hup.mjs", import.meta.url));
const LOADER = fileURLToPath(new URL("./ts-loader.mjs", import.meta.url));
const SCHEMA = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
/** The result line of a successful call, as fake-claude.mjs prints it. */
const RESULT = { type: "result", subtype: "success", is_error: false, num_turns: 3, total_cost_usd: 0.01, permission_denials: [], structured_output: { ok: true } };

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Polls up to 2 s for the pid to disappear. */
async function gone(pid: number, ms = 2_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!alive(pid)) return true;
    await delay(25);
  }
  return !alive(pid);
}

let dir: string;
let pids: number[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-stack-pgroup-"));
  pids = [];
});
afterEach(() => {
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

function readPid(pidFile: string): number {
  const pid = Number(readFileSync(pidFile, "utf8").trim());
  if (pid > 1) pids.push(pid);
  return pid;
}

/** A command that starts `sleep 30` in the background (its output away from the check's pipes) and exits at once. */
const leaveChild = (pidFile: string, exit: number): string => `sleep 30 >/dev/null 2>&1 & echo $! > '${pidFile}'; exit ${exit}`;

describe("runCheck kills what is left of its process group", () => {
  it("Q1: a check that exits 0 leaves no background child alive", async () => {
    const pidFile = join(dir, "child.pid");
    const r = await runCheck(leaveChild(pidFile, 0), dir, 10_000);
    expect(r).toMatchObject({ exit: 0, skipped: false });
    expect(r.aborted).toBeUndefined();
    expect(r.timedOut).toBeUndefined();
    const pid = readPid(pidFile);
    expect(pid).toBeGreaterThan(1);
    expect(await gone(pid)).toBe(true);
  });

  it("Q1: a check that exits 1 leaves no background child alive and is still red", async () => {
    const pidFile = join(dir, "child.pid");
    const r = await runCheck(leaveChild(pidFile, 1), dir, 10_000);
    expect(r).toMatchObject({ exit: 1, skipped: false });
    expect(r.timedOut).toBeUndefined();
    const pid = readPid(pidFile);
    expect(await gone(pid)).toBe(true);
  });

  it("Q1: a check with no leftover child resolves with the same result as before", async () => {
    expect(await runCheck("echo hi", dir, 5_000)).toEqual({ cmd: "echo hi", exit: 0, skipped: false, tail: "hi" });
    expect(await runCheck("echo oops >&2; exit 3", dir, 5_000)).toEqual({ cmd: "echo oops >&2; exit 3", exit: 3, skipped: false, tail: "oops" });
  });

  it("Q1: a check whose background child keeps the output pipe open resolves at once and the child is dead", async () => {
    const pidFile = join(dir, "child.pid");
    const started = Date.now();
    // No redirect: the sleep holds the check's stdout and stderr, so only the kill in the exit handler ends 'close'.
    const r = await runCheck(`sleep 30 & echo $! > '${pidFile}'; exit 0`, dir, 10_000);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(r).toMatchObject({ exit: 0, skipped: false });
    expect(r.timedOut).toBeUndefined();
    const pid = readPid(pidFile);
    expect(await gone(pid)).toBe(true);
  });

  it("Q1: the set of live groups holds a running check and is empty after it has ended", async () => {
    const run = runCheck("sleep 0.2", dir, 5_000);
    expect(liveGroups()).toHaveLength(1);
    expect(await run).toMatchObject({ exit: 0 });
    expect(liveGroups()).toEqual([]);
  });

  it("Q1: killLiveGroups kills a running check's group", async () => {
    const pidFile = join(dir, "child.pid");
    const started = Date.now();
    const run = runCheck(`sleep 30 >/dev/null 2>&1 & echo $! > '${pidFile}'; wait`, dir, 10_000);
    const end = Date.now() + 2_000;
    while (!(existsSync(pidFile) && readFileSync(pidFile, "utf8").trim()) && Date.now() < end) await delay(25);
    const pid = readPid(pidFile);
    killLiveGroups();
    const r = await run;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(r.exit).not.toBe(0);
    expect(await gone(pid)).toBe(true);
    expect(liveGroups()).toEqual([]);
  });
});

describe("callClaude kills what is left of its process group", () => {
  it("Q1: a role call whose child started a background process and exited normally leaves it dead", async () => {
    chmodSync(FAKE, 0o755);
    const script = join(dir, "script.json");
    const pidFile = join(dir, "bg.pid");
    writeFileSync(script, JSON.stringify([{ exec: `sleep 30 >/dev/null 2>&1 & echo $! > '${pidFile}'`, output: { ok: true } }]));
    const io: CallIo = {
      cwd: dir,
      prompt: "# Role: review\n",
      runId: "20261127-120000",
      callsDir: join(dir, "calls"),
      callNo: 1,
      timeoutMs: 10_000,
      env: { AGENT_STACK_CLAUDE: FAKE, FAKE_CLAUDE_SCRIPT: script },
    };
    const out = await callClaude({ role: "review", model: "opus", maxTurns: 10, schema: SCHEMA, budgetUsd: null }, io);
    expect(out.kind).toBe("ok");
    expect(existsSync(pidFile)).toBe(true);
    const pid = readPid(pidFile);
    expect(pid).toBeGreaterThan(1);
    expect(await gone(pid)).toBe(true);
    expect(liveGroups()).toEqual([]);
  });

  it("Q1: a role call whose background process keeps the output pipe open resolves at once and the process is dead", async () => {
    const pidFile = join(dir, "bg.pid");
    // fake-claude.mjs runs `exec` with its output away from the pipes, so a tiny claude in bash holds them instead.
    const bin = join(dir, "claude-bg.sh");
    writeFileSync(bin, `#!/bin/bash\ncat >/dev/null\nsleep 30 &\necho $! > '${pidFile}'\nprintf '%s\\n' '${JSON.stringify(RESULT)}'\nexit 0\n`);
    chmodSync(bin, 0o755);
    const io: CallIo = {
      cwd: dir,
      prompt: "# Role: review\n",
      runId: "20261127-120000",
      callsDir: join(dir, "calls"),
      callNo: 1,
      timeoutMs: 10_000,
      env: { AGENT_STACK_CLAUDE: bin },
    };
    const started = Date.now();
    const out = await callClaude({ role: "review", model: "opus", maxTurns: 10, schema: SCHEMA, budgetUsd: null }, io);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(out.kind).toBe("ok");
    const pid = readPid(pidFile);
    expect(await gone(pid)).toBe(true);
    expect(liveGroups()).toEqual([]);
  });
});

// driver-hup.mjs runs src/*.ts in plain node: it needs module.registerHooks and --experimental-transform-types
// (Node 22.15+; CI runs Node 22).
describe.each(["with-signal", "no-signal"])("SIGHUP to the driver (%s)", (mode) => {
  it("Q1: a driver that gets SIGHUP during a check leaves no process of that check alive", async () => {
    const pidFile = join(dir, "check.pid");
    const cmd = `sleep 30 >/dev/null 2>&1 & echo "$$ $!" > '${pidFile}'; wait`;
    const driver = spawn(process.execPath, ["--experimental-transform-types", "--no-warnings", "--import", LOADER, DRIVER, cmd, dir, mode], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (driver.pid !== undefined) pids.push(driver.pid);
    let err = "";
    driver.stderr.on("data", (c: Buffer) => {
      err += c.toString("utf8");
    });
    const two = (): number[] => {
      const nums = existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim().split(" ").map(Number) : [];
      return nums.length === 2 && nums.every((n) => n > 1) ? nums : [];
    };
    // The driver loads the TypeScript sources first: up to 10 s for the check to start.
    const end = Date.now() + 10_000;
    while (two().length === 0 && Date.now() < end && driver.exitCode === null) await delay(25);
    const [bash, sleep] = two();
    expect(bash, err).toBeDefined();
    if (bash === undefined || sleep === undefined) return;
    pids.push(bash, sleep);
    driver.kill("SIGHUP");
    expect(await gone(sleep)).toBe(true);
    expect(await gone(bash)).toBe(true);
  });
});

describe("killGroup", () => {
  it("Q1: ignores a missing pid, pid 0 and 1, the driver's own pid and a group with no member left", () => {
    let fallback = 0;
    const child = (): void => {
      fallback++;
    };
    expect(() => killGroup(undefined)).not.toThrow();
    expect(() => killGroup(0)).not.toThrow();
    expect(() => killGroup(1)).not.toThrow();
    expect(() => killGroup(process.pid)).not.toThrow();
    // A pid far above any real one: ESRCH, ignored.
    expect(() => killGroup(99_999_999)).not.toThrow();
    killGroup(undefined, child);
    expect(fallback).toBe(1);
    expect(alive(process.pid)).toBe(true);
  });
});
