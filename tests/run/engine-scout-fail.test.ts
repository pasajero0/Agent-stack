/**
 * scout1: the scout endings that never stop the run — a call that ends early, no kept entry, a failed write — and
 * the endings that do stop it as for any call: the fuse and an interrupt. Spec: docs/specs/scout1/SPEC.md (AC-10,
 * AC-11, AC-13, AC-14, AC-23, AC-28).
 */
import { existsSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cleanupProjects } from "../hooks/fixture.js";
import { resumeRun, startRun } from "../../src/run/engine/index.js";
import { runDir } from "../../src/run/store.js";
import { makeFakeExecutable, repo, text, type Json, type LoggedCall, type Repo } from "./engine-fixture.js";
import { clarify, patchRun, scout, TASK_DESC } from "./engine-task-fixture.js";

/** Switches for the fs and parse failures this file makes (off by default, reset after each test). */
const fail = vi.hoisted(() => ({ write: false, rename: false, parse: false }));

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  const isTmp = (p: unknown): boolean => typeof p === "string" && p.endsWith("scout.md.tmp");
  return {
    ...fs,
    // A partial write: the temp file is there, then the write fails (as on a full disk).
    writeFileSync: (...args: Parameters<typeof fs.writeFileSync>): void => {
      if (fail.write && isTmp(args[0])) {
        fs.writeFileSync(args[0], "# Scout");
        throw new Error("ENOSPC: no space left on device");
      }
      fs.writeFileSync(...args);
    },
    renameSync: (...args: Parameters<typeof fs.renameSync>): void => {
      if (fail.rename && isTmp(args[0])) throw new Error("EXDEV: cross-device link not permitted");
      fs.renameSync(...args);
    },
  };
});

vi.mock("../../src/run/schemas.js", async (importOriginal) => {
  const s = await importOriginal<typeof import("../../src/run/schemas.js")>();
  // A parse failure after `ok`: the call layer's schema check passed, the driver's parse does not.
  return { ...s, parseScout: (v: unknown) => (fail.parse ? "entries must be {path, lines?, why}[]" : s.parseScout(v)) };
});

beforeAll(makeFakeExecutable);
afterEach(() => {
  fail.write = false;
  fail.rename = false;
  fail.parse = false;
  cleanupProjects();
});

const roleOf = (c: LoggedCall): string => (c.prompt.split("\n").find((l) => l.trim() !== "") ?? "").replace("# Role: ", "");
const roles = (r: Repo): string[] => r.logged().map(roleOf);
const folder = (r: Repo): string => runDir(r.dir, r.run().id);
const scoutFile = (r: Repo): string => join(folder(r), "scout.md");
const noMap = (reason: string): string => `scout: no map (${reason}); the run goes on without it`;

const DENIAL = { tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "git push" } };
const DENIAL_TEXT = "Bash git push";
const result = (o: Json): Json => ({ type: "result", is_error: false, num_turns: 3, total_cost_usd: 0.01, permission_denials: [], ...o });
/** A scout call that ends `ok` with `entries` and one permission denial. */
const scoutDenied = (entries: Json[]): Json => ({
  expectRole: "scout",
  stdout: result({ subtype: "success", permission_denials: [DENIAL], structured_output: { entries } }),
});

/** The scout endings of AC-10, each with the response that gives it; every one carries a permission denial. */
const EARLY: { reason: string; response: Json; slow?: boolean; parse?: boolean }[] = [
  { reason: "infra", response: { expectRole: "scout", stdout: "not json", exit: 1 } },
  {
    reason: "schema",
    response: { expectRole: "scout", stdout: result({ subtype: "success", permission_denials: [DENIAL], structured_output: { entries: [{ path: "README.md" }] } }) },
  },
  { reason: "schema", parse: true, response: scoutDenied([{ path: "README.md", why: "the readme" }]) },
  {
    reason: "max-turns",
    response: { expectRole: "scout", stdout: result({ subtype: "error_max_turns", is_error: true, num_turns: 30, permission_denials: [DENIAL] }) },
  },
  { reason: "timeout", slow: true, response: { ...scout(), sleepMs: 5000 } },
  {
    reason: "exec-error",
    response: { expectRole: "scout", stdout: result({ subtype: "error_during_execution", is_error: true, permission_denials: [DENIAL] }) },
  },
];

/** Starts a task run with `first` as the scout response; clarify then stops at gate:answers (exit 3). */
async function start(r: Repo, first: Json): Promise<number> {
  r.script([first, clarify(), clarify()]);
  return startRun({ ...r.opts(), mode: "task", description: TASK_DESC });
}

/** The run went on to clarify with no scout map, after exactly one scout call. */
function wentOnWithoutMap(r: Repo, code: number): void {
  expect(code, text(r)).toBe(3);
  expect(roles(r)).toEqual(["scout", "clarify"]);
  expect(existsSync(scoutFile(r))).toBe(false);
  expect(readdirSync(folder(r)).filter((f) => f.startsWith("scout"))).toEqual([]);
  const run = r.run();
  expect(run.next).toBe("gate:answers");
  expect(run.steps.map((s) => s.step).slice(0, 2)).toEqual(["scout", "clarify"]);
}

describe("a scout call that ends early (scout1 AC-10)", () => {
  for (const e of EARLY) {
    const name = e.parse ? "schema (a parse failure after ok)" : e.reason;
    it(`scout1 AC-10: the ending ${name} makes one call, no map, the no-map line, and goes to clarify`, async () => {
      const r = e.slow ? repo({ run: { stepTimeoutMin: 0.005 } }) : repo(); // 300 ms per call
      fail.parse = e.parse === true;
      const code = await start(r, e.response);
      fail.parse = false;
      wentOnWithoutMap(r, code);
      expect(r.out).toContain(noMap(e.reason));
      expect(r.run().calls).toBe(2);
      expect(text(r)).not.toMatch(/did not match its schema twice|ended early|stays at scout/);
    });
  }
});

describe("a scout output with no kept entry (scout1 AC-11)", () => {
  it("scout1 AC-11: an empty entries gives the no-map line `empty list` and goes to clarify", async () => {
    const r = repo();
    wentOnWithoutMap(r, await start(r, scout([])));
    expect(r.out).toContain(noMap("empty list"));
  });

  it("scout1 AC-11: entries where every item is dropped give `no entry kept` and go to clarify", async () => {
    const r = repo();
    const items = [
      { path: "src/no-such-file.ts", why: "missing" },
      { path: "/etc/passwd", why: "absolute" },
      { path: "./", why: "the root" },
    ];
    wentOnWithoutMap(r, await start(r, scout(items)));
    expect(r.out).toContain(noMap("no entry kept"));
  });
});

describe("a failed write of the scout map (scout1 AC-28)", () => {
  it("scout1 AC-28: a failed temp file write removes the temp file, leaves no map, says `write failed`, goes to clarify", async () => {
    const r = repo();
    fail.write = true;
    const code = await start(r, scout());
    fail.write = false;
    wentOnWithoutMap(r, code);
    expect(r.out).toContain(noMap("write failed"));
  });

  it("scout1 AC-28: a failed rename removes the temp file, leaves no map, says `write failed`, goes to clarify", async () => {
    const r = repo();
    fail.rename = true;
    const code = await start(r, scout());
    fail.rename = false;
    wentOnWithoutMap(r, code);
    expect(existsSync(`${scoutFile(r)}.tmp`)).toBe(false);
    expect(r.out).toContain(noMap("write failed"));
  });
});

describe("the fuse at the scout step (scout1 AC-13)", () => {
  it("scout1 AC-13: a scout call ended by error_max_budget_usd goes to gate:limit (fuse), returnTo scout; raise runs the scout again", async () => {
    const r = repo({ run: { fuse: { usd: 1 } } });
    const budget = result({ subtype: "error_max_budget_usd", is_error: true, num_turns: 9, total_cost_usd: 0.5 });
    r.script([{ expectRole: "scout", stdout: budget, exit: 1 }, scout(), clarify()]);
    expect(await startRun({ ...r.opts(), mode: "task", description: TASK_DESC }), text(r)).toBe(3);
    let run = r.run();
    expect(run.next).toBe("gate:limit");
    expect(run.limitReason).toBe("fuse");
    expect(run.returnTo).toBe("scout");
    expect(existsSync(scoutFile(r))).toBe(false);
    expect(text(r)).not.toMatch(/scout: (no )?map/);
    expect(roles(r)).toEqual(["scout"]);

    expect(await resumeRun({ ...r.opts({ gate: ["f 3"] }) }), text(r)).toBe(3);
    run = r.run();
    expect(roles(r)).toEqual(["scout", "scout", "clarify"]);
    expect(run.gates.map((g) => `${g.gate} ${g.decision}`)).toEqual(["gate:limit raise"]);
    expect(existsSync(scoutFile(r))).toBe(true);
    expect(run.next).toBe("gate:answers");
  });

  it("scout1 AC-13: a fuse reached before the scout call makes no call, goes to gate:limit (fuse), returnTo scout; raise runs the scout", async () => {
    const r = repo({ run: { fuse: { calls: 3 } } });
    expect(await start(r, scout()), text(r)).toBe(3);
    rmSync(scoutFile(r));
    patchRun(r, { next: "scout", status: "running", proposal: null, calls: 3 });
    r.script([scout(), clarify()]);
    rmSync(join(r.dir, ".git", "fake-script.json.idx"));
    r.out.length = 0;
    expect(await resumeRun({ ...r.opts() }), text(r)).toBe(3);
    let run = r.run();
    expect(run.next).toBe("gate:limit");
    expect(run.limitReason).toBe("fuse");
    expect(run.returnTo).toBe("scout");
    expect(run.calls).toBe(3);
    expect(roles(r)).toEqual(["scout", "clarify"]);
    expect(text(r)).not.toMatch(/scout: (no )?map/);

    expect(await resumeRun({ ...r.opts({ gate: ["f 10"] }) }), text(r)).toBe(3);
    run = r.run();
    expect(roles(r)).toEqual(["scout", "clarify", "scout", "clarify"]);
    expect(existsSync(scoutFile(r))).toBe(true);
    expect(run.calls).toBe(5);
    expect(run.next).toBe("gate:answers");
  });
});

describe("an interrupt during the scout call (scout1 AC-14)", () => {
  it("scout1 AC-14: an abort stops the scout call and keeps next at scout; resume makes a new scout call", async () => {
    const r = repo();
    r.script([{ ...scout(), sleepMs: 5000 }, scout(), clarify()]);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 800);
    const started = Date.now();
    expect(await startRun({ ...r.opts({ signal: ac.signal }), mode: "task", description: TASK_DESC }), text(r)).toBe(1);
    expect(Date.now() - started).toBeLessThan(4000);
    let run = r.run();
    expect(run.status).toBe("running");
    expect(run.next).toBe("scout");
    expect(existsSync(scoutFile(r))).toBe(false);
    expect(text(r)).toContain("Interrupted at scout");
    expect(text(r)).not.toMatch(/scout: (no )?map/);

    expect(await resumeRun({ ...r.opts() }), text(r)).toBe(3);
    run = r.run();
    expect(roles(r)).toEqual(["scout", "scout", "clarify"]);
    expect(existsSync(scoutFile(r))).toBe(true);
    expect(run.next).toBe("gate:answers");
  });
});

describe("permission denials of a scout call (scout1 AC-23)", () => {
  const OK: { reason: string; entries: Json[]; write?: boolean }[] = [
    { reason: "map", entries: [{ path: "README.md", why: "the readme" }] },
    { reason: "empty list", entries: [] },
    { reason: "no entry kept", entries: [{ path: "src/no-such-file.ts", why: "missing" }] },
    { reason: "write failed", entries: [{ path: "README.md", why: "the readme" }], write: true },
  ];
  for (const o of OK) {
    it(`scout1 AC-23: an ok ending (${o.reason}) adds its denials to humanDecisions`, async () => {
      const r = repo();
      fail.write = o.write === true;
      const code = await start(r, scoutDenied(o.entries));
      fail.write = false;
      expect(code, text(r)).toBe(3);
      const denials = r.run().humanDecisions.filter((d) => d.includes(DENIAL_TEXT));
      expect(denials).toHaveLength(1);
    });
  }

  for (const e of EARLY.filter((x) => x.reason !== "timeout")) {
    const name = e.parse ? "schema (a parse failure after ok)" : e.reason;
    it(`scout1 AC-23: the ending ${name} adds no denials`, async () => {
      const r = repo();
      fail.parse = e.parse === true;
      const code = await start(r, e.response);
      fail.parse = false;
      expect(code, text(r)).toBe(3);
      expect(r.run().humanDecisions.filter((d) => d.includes(DENIAL_TEXT))).toEqual([]);
    });
  }
});
