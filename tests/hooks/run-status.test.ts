import { afterAll, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { cleanupProjects, deployHarness, write } from "./fixture.js";

afterAll(cleanupProjects);

const ID = "r-20261120-150000";
const LIVE = process.pid;
const DEAD = 2 ** 22 + 12345;

function status(dir: string): { code: number | null; out: string } {
  const r = spawnSync(join(dir, ".claude/bin/run-status"), [], { cwd: dir, encoding: "utf-8", input: '{"session_id":"x"}' });
  return { code: r.status, out: r.stdout };
}

function project(o: { status?: string; pid?: number; now?: string | null; lock?: boolean } = {}): string {
  const dir = deployHarness();
  if (o.lock !== false) write(dir, ".claude/tmp/runs/lock", JSON.stringify({ id: ID, pid: o.pid ?? LIVE }));
  write(dir, `.claude/tmp/runs/${ID}/run.json`, JSON.stringify({ id: ID, status: o.status ?? "running", next: "implement:T1", costUsd: 0.4567 }));
  const since = new Date(Date.now() - 95_000).toISOString();
  const now = o.now === undefined ? JSON.stringify({ step: "implement:T1", since, last: "   · Edit src/a.ts" }) : o.now;
  if (now !== null) write(dir, `.claude/tmp/runs/${ID}/now.json`, now);
  return dir;
}

describe("run-status (AC-80)", () => {
  it("v04 AC-80: a live run prints its step, the time in the step, the cost and the last line", () => {
    const r = status(project());
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^run r-20261120-150000 · implement:T1 · 1:3[4-9] · \$0\.46 · Edit src\/a\.ts\n$/);
  });

  it("v04 AC-80: a waiting run prints the gate it waits at", () => {
    expect(status(project({ status: "waiting" })).out).toBe("run r-20261120-150000 · waiting at implement:T1\n");
  });

  it.each([
    ["no lock", { lock: false }],
    ["a dead driver", { pid: DEAD }],
    ["no now.json", { now: null }],
    ["now.json not JSON", { now: "{ not json" }],
    ["a finished run", { status: "finished" }],
  ])("v04 AC-80: prints nothing and exits 0 with %s", (_name, o) => {
    const r = status(project(o));
    expect(r.code).toBe(0);
    expect(r.out).toBe("");
  });
});
