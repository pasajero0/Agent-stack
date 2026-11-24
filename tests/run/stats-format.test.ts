import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { statsRun } from "../../src/run/engine/index.js";
import type { RunFile } from "../../src/run/types.js";

const NOW = new Date("2026-01-01T00:10:00Z");

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "stats-format-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const runs = (): string => join(dir, ".claude", "tmp", "runs");

function run(id: string, over: Partial<RunFile> = {}): RunFile {
  return {
    id, description: "d", mode: "task", specFlow: "merge", specApproved: null, status: "finished",
    next: "gate:accept", returnTo: null, limitReason: null, proposal: null, stage: null, stagePrefill: null,
    size: null, branch: "b", baseCommit: null, tasks: [], createdBranches: [], gates: [], answers: [],
    humanDecisions: [], costUsd: 0, costUnknownCalls: 0, calls: 0, fuse: "off", card: null, steps: [],
    estimateSec: null, ...over,
  } as RunFile;
}

function putRun(folder: string, body: unknown): void {
  const d = join(runs(), folder);
  mkdirSync(d, { recursive: true });
  writeFileSync(join(d, "run.json"), typeof body === "string" ? body : JSON.stringify(body));
}

async function text(): Promise<string[]> {
  const lines: string[] = [];
  const code = await statsRun({ projectDir: dir, out: (l) => lines.push(l), now: NOW });
  expect(code).toBe(0);
  return lines;
}

async function json(): Promise<Record<string, any>> {
  const lines: string[] = [];
  const code = await statsRun({ projectDir: dir, out: (l) => lines.push(l), json: true, now: NOW });
  expect(code).toBe(0);
  expect(lines).toHaveLength(1);
  return JSON.parse(lines[0] ?? "");
}

const A = "r-20261120-101500";
const B = "r-20261121-083000";

const task = (id: string, attempts: number, commit: string | null): RunFile["tasks"][number] => ({
  id, taskBase: null, attempts, blockingCount: null, lastFeedback: null, checks: [], notes: [],
  allowedChanges: [], pendingChanges: [], commit,
});

function seed(): void {
  putRun(A, run(A, {
    stage: "v04", costUsd: 1.234, costUnknownCalls: 1,
    tasks: [task("T1", 1, "abc"), task("T2", 1, "def"), task("T3", 2, "ghi")],
    gates: [{ gate: "gate:plan-approve", at: "2026-11-20T10:20:00.000Z", decision: "reject", comment: null }],
    steps: [
      { step: "implement:T1", start: "2026-11-20T10:15:00.000Z", end: "2026-11-20T10:29:05.000Z" },
      { step: "gate:accept", start: "2026-11-20T10:29:05.000Z", end: "2026-11-20T10:32:15.000Z" },
    ],
  }));
  putRun(B, run(B, { mode: "quick", status: "cancelled", steps: [] }));
}

describe("run stats format", () => {
  it("stats1 AC-1: header, one line per run oldest first, and the totals block", async () => {
    seed();
    const l = await text();
    expect(l[0]).toMatch(/^run +date +mode +stage +status +1st pass +iter +rejected s\/p\/a +limits +calls +work +wait +cost$/);
    expect(l[1]?.split(/ {2,}/)).toEqual([A, "2026-11-20", "task", "v04", "finished", "2/3", "1.33", "0/1/0", "0", "0", "14:05", "3:10", "$1.23 · 1 unknown"]);
    expect(l[2]?.split(/ {2,}/)).toEqual([B, "2026-11-21", "quick", "—", "cancelled", "0/0", "—", "0/0/0", "0", "0", "—", "—", "$0.00"]);
    expect(l.slice(3)).toEqual([
      "total: 2 runs · finished 1 · cancelled 1 · waiting 0 · interrupted 0 · running 0",
      "  first pass 2/3 (67%) · iterations per task 1.33",
      "  rejected: spec 0 · plan 1 · accept 0",
      "  limit stops: attempts 0 · blocked 0 · review-loop 0 · fuse 0 · decision 0 · test-conflict 0 · tests-changed 0 · unknown 0",
      "  calls: clarify 0 · spec 0 · plan 0 · implement 0 · review 0 · missing 0",
      "  permission denials: 0",
      "  time: 14:05 work + 3:10 waiting (1 run without times)",
      "  cost: $1.23 · 1 call with unknown cost",
    ]);
  });

  it("stats1 AC-1: one run is '1 run'; no run with steps gives 'time: —'; no started task has no percent", async () => {
    putRun(B, run(B, { steps: [] }));
    const l = await text();
    expect(l).toContain("total: 1 run · finished 1 · cancelled 0 · waiting 0 · interrupted 0 · running 0");
    expect(l).toContain("  first pass 0/0 · iterations per task —");
    expect(l).toContain("  time: — (1 run without times)");
    expect(l).toContain("  cost: $0.00");
  });

  it("stats1 AC-1: calls show only outcomes above 0; skipped and warning lines come last", async () => {
    putRun(A, run(A, { calls: 2 }));
    const d = join(runs(), A, "calls");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "1-implement.json"), "{nope");
    mkdirSync(join(runs(), "junk"), { recursive: true });
    const l = await text();
    expect(l).toContain("  calls: clarify 0 · spec 0 · plan 0 · implement 1 (unreadable 1) · review 0 · missing 1");
    expect(l.slice(-3)).toEqual([
      "skipped: junk — not a run id",
      `warning: ${A}: calls/1-implement.json is unreadable: not JSON`,
      `warning: ${A}: calls/2-*.json is missing`,
    ]);
  });

  it("stats1 AC-11: no runs folder prints 'no runs in this repo'", async () => {
    expect(await text()).toEqual(["no runs in this repo"]);
  });

  it("stats1 AC-11: every folder skipped prints 'no runs counted' and the skipped lines", async () => {
    putRun(A, "{oops");
    expect(await text()).toEqual(["no runs counted", `skipped: ${A} — run.json is malformed: not JSON`]);
  });

  it("stats1 AC-11: --json with nothing counted gives the empty shape", async () => {
    putRun(A, "{oops");
    const j = await json();
    expect(j["version"]).toBe(1);
    expect(j["runs"]).toEqual([]);
    expect(j["skipped"]).toEqual([{ id: A, reason: "run.json is malformed: not JSON" }]);
    expect(j["warnings"]).toEqual([]);
    const t = j["totals"];
    expect(t).toMatchObject({ runs: 0, tasks: 0, firstPass: 0, firstPassShare: null, iterationsPerTask: null, workSec: null, waitSec: null, runsWithoutTimes: 0, costUsd: 0, costUnknownCalls: 0 });
    expect(t["byStatus"]).toEqual({ finished: 0, cancelled: 0, waiting: 0, interrupted: 0, running: 0 });
    expect(Object.keys(t["limitStops"])).toHaveLength(8);
    expect(Object.keys(t["calls"]["byRole"])).toEqual(["clarify", "spec", "plan", "implement", "review"]);
  });

  it("stats1 AC-7: --json holds the Contract's shape and the same numbers as the text", async () => {
    seed();
    const j = await json();
    expect(j["version"]).toBe(1);
    expect(j["runs"]).toHaveLength(2);
    const r = j["runs"][0];
    expect(r).toMatchObject({
      id: A, date: "2026-11-20", mode: "task", stage: "v04", status: "finished", tasks: 3, firstPass: 2,
      firstPassShare: 0.67, iterationsPerTask: 1.33, rejected: { spec: 0, plan: 1, accept: 0 },
      workSec: 845, waitSec: 190, costUsd: 1.234, costUnknownCalls: 1,
    });
    expect(r["calls"]).toMatchObject({ total: 0, missing: 0 });
    expect(Object.keys(r["calls"]["byRole"]["implement"])).toEqual(["ok", "schema", "max-turns", "exec-error", "budget", "infra", "killed", "unreadable", "denials"]);
    expect(j["runs"][1]).toMatchObject({ stage: null, firstPassShare: null, iterationsPerTask: null, workSec: null, waitSec: null });
    expect(j["totals"]).toMatchObject({
      runs: 2, byStatus: { finished: 1, cancelled: 1, waiting: 0, interrupted: 0, running: 0 }, tasks: 3, firstPass: 2,
      firstPassShare: 0.67, iterationsPerTask: 1.33, workSec: 845, waitSec: 190, runsWithoutTimes: 1, costUsd: 1.234, costUnknownCalls: 1,
    });
  });

  it("stats1 AC-21: a run with unknown cost shows ' · <k> unknown'; the totals say 'calls with unknown cost'", async () => {
    putRun(A, run(A, { costUsd: 0.5, costUnknownCalls: 3 }));
    const l = await text();
    expect(l[1]).toMatch(/\$0\.50 · 3 unknown$/);
    expect(l).toContain("  cost: $0.50 · 3 calls with unknown cost");
  });

  it("stats1 AC-22: control characters in text values print as ?, JSON keeps them", async () => {
    putRun(A, run(A, { stage: "a\u001b[31mb\u0085c\nd" }));
    putRun("bad\u001bname", "{oops");
    const l = await text();
    expect(l[1]).toContain("a?[31mb?c?d");
    expect(l).toContain("skipped: bad?name — not a run id");
    for (const line of l) expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    const j = await json();
    expect(j["runs"][0]["stage"]).toBe("a\u001b[31mb\u0085c\nd");
    expect(j["skipped"][0]["id"]).toBe("bad\u001bname");
  });
});
