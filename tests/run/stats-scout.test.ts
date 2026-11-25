import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { statsRun } from "../../src/run/engine/index.js";
import type { RunFile } from "../../src/run/types.js";

const NOW = new Date("2026-01-01T00:10:00Z");
const ID = "r-20261120-101500";
const KEYS = ["ok", "schema", "max-turns", "exec-error", "budget", "infra", "killed", "unreadable", "denials"];

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "stats-scout-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seed(calls: number, files: Record<string, unknown>): void {
  const d = join(dir, ".claude", "tmp", "runs", ID);
  mkdirSync(join(d, "calls"), { recursive: true });
  const run = {
    id: ID, description: "d", mode: "task", specFlow: "merge", specApproved: null, status: "finished",
    next: "gate:accept", returnTo: null, limitReason: null, proposal: null, stage: null, stagePrefill: null,
    size: null, branch: "b", baseCommit: null, tasks: [], createdBranches: [], gates: [], answers: [],
    humanDecisions: [], costUsd: 0, costUnknownCalls: 0, calls, fuse: "off", card: null, steps: [],
    estimateSec: null,
  } as RunFile;
  writeFileSync(join(d, "run.json"), JSON.stringify(run));
  for (const [name, body] of Object.entries(files)) writeFileSync(join(d, "calls", name), JSON.stringify(body));
}

async function text(): Promise<string[]> {
  const lines: string[] = [];
  await statsRun({ projectDir: dir, out: (l) => lines.push(l), now: NOW });
  return lines;
}

async function json(): Promise<Record<string, any>> {
  const lines: string[] = [];
  await statsRun({ projectDir: dir, out: (l) => lines.push(l), json: true, now: NOW });
  return JSON.parse(lines[0] ?? "");
}

// An unreadable-by-schema result still counts under the role in the file name.
const SCOUT_FILE = { "1-scout.json": { argv: ["claude"], exitCode: 1, result: "boom" } };

describe("run stats scout", () => {
  it("scout1 AC-7: a run with a scout call counts under scout in text and JSON", async () => {
    seed(1, SCOUT_FILE);
    const calls = (await text()).find((l) => l.startsWith("  calls:"));
    expect(calls).toMatch(/^  calls: scout 1 \(infra 1\) · clarify 0/);
    const j = await json();
    expect(j["version"]).toBe(2);
    const by = j["totals"]["calls"]["byRole"];
    expect(Object.keys(by)).toEqual(["scout", "clarify", "spec", "plan", "implement", "review"]);
    expect(by["scout"]["infra"]).toBe(1);
    expect(j["runs"][0]["calls"]["byRole"]["scout"]["infra"]).toBe(1);
    expect(j["totals"]["calls"]["missing"]).toBe(0);
  });

  it("scout1 AC-18: a run without a scout call shows scout 0 and nine keys at 0", async () => {
    seed(0, {});
    const calls = (await text()).find((l) => l.startsWith("  calls:"));
    expect(calls).toMatch(/^  calls: scout 0 · clarify 0/);
    const j = await json();
    const scout = j["totals"]["calls"]["byRole"]["scout"];
    expect(Object.keys(scout)).toEqual(KEYS);
    expect(Object.values(scout)).toEqual(KEYS.map(() => 0));
  });
});
