import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { runCommand, type RunOptions } from "../../src/commands/run.js";

let dir: string;
let outside: string;
let savedClaude: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "stats-command-"));
  outside = mkdtempSync(join(tmpdir(), "stats-command-fake-"));
  savedClaude = process.env["AGENT_STACK_CLAUDE"];
});
afterEach(() => {
  if (savedClaude === undefined) delete process.env["AGENT_STACK_CLAUDE"];
  else process.env["AGENT_STACK_CLAUDE"] = savedClaude;
  rmSync(dir, { recursive: true, force: true });
  rmSync(outside, { recursive: true, force: true });
});

const runs = (): string => join(dir, ".claude", "tmp", "runs");

const OK_REVIEW = {
  type: "result", subtype: "success", is_error: false, num_turns: 2, total_cost_usd: 0.1,
  structured_output: { spec: "pass", quality: "pass", verifyProves: true, findings: [] },
};

function runFile(id: string, calls: number): Record<string, unknown> {
  return {
    id, description: "d", mode: "task", specFlow: "merge", specApproved: null, status: "finished",
    next: "gate:accept", returnTo: null, limitReason: null, proposal: null, stage: "s1", stagePrefill: null,
    size: null, branch: "b", baseCommit: null, tasks: [], createdBranches: [], gates: [], answers: [],
    humanDecisions: [], costUsd: 0.5, costUnknownCalls: 0, calls, fuse: "off", card: null,
    steps: [{ step: "implement:T1", start: "2026-11-20T10:15:00.000Z", end: "2026-11-20T10:20:00.000Z" }],
    estimateSec: null,
  };
}

/** A run folder with `calls` review call files; `pad` grows each file by about that many bytes. */
function putRun(id: string, calls: number, pad = 0): void {
  const d = join(runs(), id);
  mkdirSync(join(d, "calls"), { recursive: true });
  writeFileSync(join(d, "run.json"), JSON.stringify(runFile(id, calls)));
  const body = JSON.stringify({ argv: ["claude"], exitCode: 0, result: OK_REVIEW, pad: "x".repeat(pad) });
  for (let n = 1; n <= calls; n++) writeFileSync(join(d, "calls", `${n}-review.json`), body);
}

function snapshot(root: string): string[] {
  const lines: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const s = statSync(p);
      lines.push(`${relative(root, p)} ${s.isDirectory() ? "dir" : s.size} ${s.mtimeMs}`);
      if (s.isDirectory()) walk(p);
    }
  };
  walk(root);
  return lines;
}

async function call(mode: string | undefined, options: RunOptions, projectDir = dir): Promise<{ code: number; out: string[] }> {
  const out: string[] = [];
  const code = await runCommand(mode, undefined, options, { projectDir, out: (l) => out.push(l) });
  return { code, out };
}

describe("run --stats command", () => {
  it("stats1 AC-17: --stats with another action prints the new two-action message", async () => {
    // The project dir does not exist, so reading a run would fail: the check must come first.
    const none = join(dir, "missing");
    for (const o of [{ resume: true }, { status: true }, { cancel: "r-1" }, { watch: true }] as RunOptions[]) {
      expect(await call(undefined, { stats: true, ...o }, none)).toEqual({
        code: 1, out: ["Use one of --resume, --status, --cancel, --watch or --stats."],
      });
    }
  });

  it("stats1 AC-17: every two-action case prints the new message", async () => {
    expect(await call(undefined, { resume: true, status: true })).toEqual({
      code: 1, out: ["Use one of --resume, --status, --cancel, --watch or --stats."],
    });
  });

  it("stats1 AC-17: --stats with a mode, run id, --stage or --answer", async () => {
    const msg = { code: 1, out: ["--stats takes no run id, mode, --stage or --answer."] };
    expect(await call("quick", { stats: true })).toEqual(msg);
    expect(await call("r-20261120-101500", { stats: true })).toEqual(msg);
    expect(await call(undefined, { stats: true, stage: "s1" })).toEqual(msg);
    expect(await call(undefined, { stats: true, answer: ["x"] })).toEqual(msg);
  });

  it("stats1 AC-17: --json without --status or --stats", async () => {
    expect(await call(undefined, { cancel: true, json: true })).toEqual({ code: 1, out: ["--json goes with --status or --stats."] });
    expect(await call("quick", { json: true })).toEqual({ code: 1, out: ["--json goes with --status or --stats."] });
  });

  it("stats1 AC-17: --stats and --stats --json print the report", async () => {
    putRun("r-20261120-101500", 1);
    const text = await call(undefined, { stats: true });
    expect(text.code).toBe(0);
    expect(text.out[1]).toContain("r-20261120-101500");
    const json = await call(undefined, { stats: true, json: true });
    expect(json.code).toBe(0);
    expect(JSON.parse(json.out[0] ?? "").version).toBe(1);
  });

  it("stats1 AC-8: changes no file, takes no lock, starts no Claude, needs no harness", async () => {
    const marker = join(outside, "ran");
    const fake = join(outside, "claude");
    writeFileSync(fake, `#!/bin/sh\ntouch "${marker}"\nexit 1\n`);
    chmodSync(fake, 0o755);
    process.env["AGENT_STACK_CLAUDE"] = fake;
    putRun("r-20261120-101500", 3);
    putRun("r-20261121-083000", 2);
    mkdirSync(join(runs(), "not-a-run"));
    writeFileSync(join(dir, "README.md"), "x");
    expect(existsSync(join(dir, ".claude", ".harness.json"))).toBe(false);
    const before = snapshot(dir);
    expect((await call(undefined, { stats: true })).code).toBe(0);
    expect((await call(undefined, { stats: true, json: true })).code).toBe(0);
    expect(snapshot(dir)).toEqual(before);
    expect(existsSync(join(runs(), "lock"))).toBe(false);
    expect(existsSync(marker)).toBe(false);
  });

  it("stats1 NFR: 100 runs with 40 call files of about 20 KB end in under 3 s", async () => {
    for (let i = 0; i < 100; i++) putRun(`r-20261120-10${String(i).padStart(4, "0")}`, 40, 20_000);
    const start = Date.now();
    const r = await call(undefined, { stats: true });
    expect(r.code).toBe(0);
    expect(Date.now() - start).toBeLessThan(3000);
  }, 60_000);
});
