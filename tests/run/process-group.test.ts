import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runCheck } from "../../src/run/checks.js";
import { callClaude, type CallIo } from "../../src/run/claude.js";
import { killGroup } from "../../src/run/process-group.js";

// Defect 49: what a check or a role call started must not outlive it.

const FAKE = fileURLToPath(new URL("./fake-claude.mjs", import.meta.url));
const SCHEMA = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };

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
