import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readCalls } from "../../src/run/stats/calls.js";
import type { RunFile } from "../../src/run/types.js";

// Result objects as in tests/run/claude.test.ts.
const OK_REVIEW = {
  type: "result", subtype: "success", is_error: false, num_turns: 2, total_cost_usd: 0.1,
  structured_output: { spec: "pass", quality: "pass", verifyProves: true, findings: [] },
};
const OK_PLAN = { type: "result", subtype: "success", is_error: false, num_turns: 2, structured_output: { summary: "s", tasks: [], needsHumanDecision: [] } };
const BAD_SCHEMA = { type: "result", subtype: "success", is_error: false, num_turns: 4, total_cost_usd: 0.4 };
const MAX_TURNS = { type: "result", subtype: "error_max_turns", is_error: true, num_turns: 60, total_cost_usd: 1 };
const EXEC = { type: "result", subtype: "error_during_execution", is_error: true, num_turns: 5, total_cost_usd: 0.3 };
const BUDGET = { type: "result", subtype: "error_max_budget_usd", is_error: true, num_turns: 9, total_cost_usd: 2 };
const INFRA = { type: "result", subtype: "error_during_execution", is_error: true, num_turns: 0, total_cost_usd: 0 };

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "stats-calls-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const run = (calls: number): RunFile => ({ id: "r1", calls }) as RunFile;
const put = (name: string, body: unknown): void => {
  mkdirSync(join(dir, "calls"), { recursive: true });
  writeFileSync(join(dir, "calls", name), typeof body === "string" ? body : JSON.stringify(body));
};
const rec = (result: unknown, exitCode: unknown = 0): unknown => ({ argv: ["claude"], exitCode, result });

describe("run stats calls", () => {
  it("stats1 AC-5: counts each outcome under the role in the file name", () => {
    put("1-review.json", rec(OK_REVIEW));
    put("2-plan.json", rec(BAD_SCHEMA));
    put("3-implement.json", rec(MAX_TURNS));
    put("4-spec.json", rec(EXEC));
    put("5-clarify.json", rec(BUDGET));
    put("6-review.json", rec(INFRA));
    put("7-review.json", rec("boom", null));
    put("8-review.json", rec("boom", 1));
    const s = readCalls(dir, run(8), false);
    expect(s.warnings).toEqual([]);
    expect(s.roles.review.outcomes).toMatchObject({ ok: 1, infra: 2, killed: 1 });
    expect(s.roles.plan.outcomes.schema).toBe(1);
    expect(s.roles.implement.outcomes["max-turns"]).toBe(1);
    expect(s.roles.spec.outcomes["exec-error"]).toBe(1);
    expect(s.roles.clarify.outcomes.budget).toBe(1);
    expect(s.roles.review.calls).toBe(4);
  });

  it("stats1 AC-5: the role's schema is the check", () => {
    put("1-plan.json", rec(OK_REVIEW));
    put("2-plan.json", rec(OK_PLAN));
    const s = readCalls(dir, run(2), false);
    expect(s.roles.plan.outcomes).toMatchObject({ ok: 1, schema: 1 });
  });

  it("stats1 AC-5: permission_denials add to the role's denials", () => {
    put("1-review.json", rec({ ...OK_REVIEW, permission_denials: [{}, {}] }));
    put("2-review.json", rec({ ...OK_REVIEW, permission_denials: "x" }));
    expect(readCalls(dir, run(2), false).roles.review.denials).toBe(2);
  });

  it("stats1 AC-10: unreadable files count as unreadable with a short reason, never file text", () => {
    put("1-review.json", "SECRET{not json");
    put("2-review.json", "[1]");
    put("3-review.json", JSON.stringify({ argv: [] }));
    put("4-review.json", rec(5));
    put("5-review.json", rec("s", "SECRET"));
    put("6-review.json", rec(null));
    const s = readCalls(dir, run(6), false);
    expect(s.roles.review.outcomes.unreadable).toBe(6);
    expect(s.warnings).toEqual([
      "r1: calls/1-review.json is unreadable: not JSON",
      "r1: calls/2-review.json is unreadable: not an object",
      "r1: calls/3-review.json is unreadable: no result key",
      "r1: calls/4-review.json is unreadable: bad result",
      "r1: calls/5-review.json is unreadable: bad exitCode",
      "r1: calls/6-review.json is unreadable: bad result",
    ]);
    expect(s.warnings.join()).not.toContain("SECRET");
  });

  it("stats1 AC-10: a file that cannot be read is unreadable: cannot read", () => {
    put("1-review.json", rec(OK_REVIEW));
    chmodSync(join(dir, "calls", "1-review.json"), 0o000);
    const s = readCalls(dir, run(1), false);
    if (process.getuid?.() === 0) return;
    expect(s.warnings).toEqual(["r1: calls/1-review.json is unreadable: cannot read"]);
    expect(s.roles.review.outcomes.unreadable).toBe(1);
  });

  it("stats1 AC-10: live, an unreadable file numbered calls or above is the call in progress", () => {
    put("1-review.json", rec(OK_REVIEW));
    put("2-review.json", "{");
    const live = readCalls(dir, run(2), true);
    expect(live.warnings).toEqual([]);
    expect(live.roles.review.calls).toBe(1);
    const done = readCalls(dir, run(2), false);
    expect(done.warnings).toEqual(["r1: calls/2-review.json is unreadable: not JSON"]);
  });

  it("stats1 AC-15: a number without a file is missing, except the one in progress when live", () => {
    put("1-review.json", rec(OK_REVIEW));
    put("3-review.json", rec(OK_REVIEW));
    const s = readCalls(dir, run(3), false);
    expect(s.missing).toBe(1);
    expect(s.warnings).toEqual(["r1: calls/2-*.json is missing"]);
    const t = readCalls(dir, run(4), true);
    expect(t.missing).toBe(1);
    expect(t.warnings).toEqual(["r1: calls/2-*.json is missing"]);
    expect(readCalls(dir, run(4), false).warnings).toEqual(["r1: calls/2-*.json is missing", "r1: calls/4-*.json is missing"]);
  });

  it("stats1 AC-19: names of another form are not call files", () => {
    put("1-review.json", rec(OK_REVIEW));
    put("01-plan.json", rec(OK_PLAN));
    put("2-other.json", rec(OK_PLAN));
    put("notes.txt", "x");
    mkdirSync(join(dir, "calls", "sub"));
    const s = readCalls(dir, run(1), false);
    expect([...s.warnings].sort()).toEqual([
      "r1: calls/01-plan.json is not a call file",
      "r1: calls/2-other.json is not a call file",
      "r1: calls/notes.txt is not a call file",
      "r1: calls/sub is not a call file",
    ]);
    expect(s.roles.review.calls).toBe(1);
    expect(s.roles.plan.calls).toBe(0);
  });

  it("stats1 AC-19: files numbered 0 or above calls are outside the range; live, above is skipped", () => {
    put("1-review.json", rec(OK_REVIEW));
    put("0-plan.json", rec(OK_PLAN));
    put("2-plan.json", rec(OK_PLAN));
    const s = readCalls(dir, run(1), false);
    expect([...s.warnings].sort()).toEqual(["r1: calls/0-plan.json is outside 1..1", "r1: calls/2-plan.json is outside 1..1"]);
    expect(s.roles.plan.calls).toBe(0);
    const l = readCalls(dir, run(1), true);
    expect(l.warnings).toEqual(["r1: calls/0-plan.json is outside 1..1"]);
    expect(l.roles.plan.calls).toBe(0);
  });

  it("stats1 AC-19: two valid files with the same n are both counted, one warning", () => {
    put("1-review.json", rec(OK_REVIEW));
    put("1-plan.json", rec(OK_PLAN));
    const s = readCalls(dir, run(1), false);
    expect(s.warnings).toEqual(["r1: calls/1-*.json: more than one file"]);
    expect(s.roles.review.calls + s.roles.plan.calls).toBe(2);
    expect(s.missing).toBe(0);
  });

  it("stats1 AC-19: calls/ that cannot be listed makes every call missing with one warning", () => {
    // calls is a file, not a folder: it exists but cannot be listed.
    writeFileSync(join(dir, "calls"), "x");
    const s = readCalls(dir, run(3), false);
    expect(s.missing).toBe(3);
    expect(s.warnings).toEqual(["r1: calls/ cannot be listed"]);
  });

  it("stats1 AC-19: no calls/ with calls 0 gives no warning", () => {
    const s = readCalls(dir, run(0), false);
    expect(s.warnings).toEqual([]);
    expect(s.missing).toBe(0);
  });
});
