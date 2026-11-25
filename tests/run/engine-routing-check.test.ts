/**
 * effort1: the driver checks `gates.json → routing` when a run starts or resumes, before any step, branch or lock.
 * Spec: docs/specs/effort1/SPEC.md (Contract "Routing check messages"; AC-1, AC-12).
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupProjects, patchGates } from "../hooks/fixture.js";
import { resumeRun, startRun } from "../../src/run/engine/index.js";
import { loadRunConfig } from "../../src/run/config.js";
import { readLock } from "../../src/run/store.js";
import { DESC, impl, makeFakeExecutable, repo, sh, text, type Json, type Repo } from "./engine-fixture.js";

beforeAll(makeFakeExecutable);
afterEach(() => cleanupProjects());

/** The default routing, read from the template the harness deploys (not copied here). */
const DEFAULT_ROUTING = JSON.parse(
  readFileSync(join(__dirname, "..", "..", "templates", "claude", "_routing.json"), "utf8")
) as Json;
const clone = (): Json => JSON.parse(JSON.stringify(DEFAULT_ROUTING)) as Json;

const FIX = "Fix .claude/gates.json, then run again.";
const HINT = '"<model>·<effort>"';
const badRoute = (path: string, got: string): string =>
  `gates.json routing.${path} must be ${HINT} (model opus, sonnet or haiku; effort low, medium, high, xhigh or max); got ${got}.`;

const gatesFile = (r: Repo): string => join(r.dir, ".claude", "gates.json");

/** Writes gates.json with `routing` set to `value`; `undefined` removes the key. */
function setRouting(r: Repo, value: unknown): void {
  const g = JSON.parse(readFileSync(gatesFile(r), "utf8")) as Json;
  delete g["routing"];
  writeFileSync(gatesFile(r), JSON.stringify(value === undefined ? g : { ...g, routing: value }, null, 2));
}

const runsDir = (r: Repo): string => join(r.dir, ".claude", "tmp", "runs");

/** Starts a quick run and checks: exit 1, the message ends with FIX, nothing changed. Returns the printed lines. */
async function refusedStart(r: Repo, mode: "quick" | "task" = "quick"): Promise<string[]> {
  const head = sh(r.dir, "rev-parse", "HEAD");
  const branches = sh(r.dir, "branch", "--format=%(refname:short)");
  r.out.length = 0;
  const code = await startRun({ ...r.opts({ gate: ["a"] }), mode, description: DESC });
  expect(code, text(r)).toBe(1);
  expect(existsSync(runsDir(r)) ? readdirSync(runsDir(r)) : []).toEqual([]);
  expect(readLock(r.dir)).toBeNull();
  expect(sh(r.dir, "branch", "--format=%(refname:short)")).toBe(branches);
  expect(sh(r.dir, "rev-parse", "HEAD")).toBe(head);
  expect(sh(r.dir, "branch", "--show-current")).toBe("main");
  expect(r.logged()).toEqual([]);
  return text(r).split("\n");
}

describe("the routing check at run start and resume", () => {
  it("effort1 AC-1: a valid routing starts the run, and RunConfig holds the parsed routing", async () => {
    const r = repo();
    expect(loadRunConfig(r.dir).routing).toEqual(DEFAULT_ROUTING);
    r.script([impl({ writes: { "README.md": "# demo\nfixed\n" } })]);
    expect(await startRun({ ...r.opts({ gate: ["a"] }), mode: "quick", description: DESC }), text(r)).toBe(0);
  });

  it("effort1 AC-12: no routing key gives the update line, then the fix line", async () => {
    const r = repo();
    setRouting(r, undefined);
    expect(await refusedStart(r)).toEqual([
      "gates.json has no routing block. Run agent-stack update to add it (CHANGELOG: Upgrading from 0.4.7).",
      FIX,
    ]);
  });

  it("effort1 AC-12: routing that is not an object is one line", async () => {
    const r = repo();
    setRouting(r, ["opus·high"]);
    expect(await refusedStart(r)).toEqual([
      'gates.json routing must be an object; got ["opus·high"]. Fix it, or remove the key and run agent-stack update.',
      FIX,
    ]);
  });

  it("effort1 AC-12: a missing tier is one line in place of its three cells", async () => {
    const r = repo();
    const g = clone();
    delete g["M"];
    setRouting(r, g);
    expect(await refusedStart(r)).toEqual(["gates.json routing.M is missing. Add it as an object with low, medium and high.", FIX]);
  });

  it("effort1 AC-12: a bad cell (opus-high) is refused with the route pattern", async () => {
    const r = repo();
    const g = clone();
    (g["L"] as Json)["medium"] = "opus-high";
    setRouting(r, g);
    expect(await refusedStart(r)).toEqual([badRoute("L.medium", '"opus-high"'), FIX]);
  });

  it("effort1 AC-12: missing retry and risky give one line each", async () => {
    const r = repo();
    const g = clone();
    delete g["retry"];
    delete g["risky"];
    setRouting(r, g);
    expect(await refusedStart(r)).toEqual([
      `gates.json routing.retry is missing. Add it as ${HINT}.`,
      `gates.json routing.risky is missing. Add it as ${HINT}.`,
      FIX,
    ]);
  });

  it("effort1 AC-12: an unknown key with a control char is printed as JSON with ? and cannot fake a line", async () => {
    const r = repo();
    const g = clone();
    g["fast\u0085x"] = "opus·high";
    (g["S"] as Json)["extreme\nFix"] = "opus·max";
    setRouting(r, g);
    expect(await refusedStart(r)).toEqual([
      'gates.json routing."fast?x" is not a routing key; remove it.',
      'gates.json routing.S."extreme\\nFix" is not a routing key; remove it.',
      FIX,
    ]);
  });

  it("effort1 AC-12: every problem is printed, in the Contract's order", async () => {
    const r = repo();
    setRouting(r, {
      zzz: 1,
      risky: "gpt·high",
      L: "big",
      S: { high: "opus·high", low: "sonnet·low", odd: "x" },
      M: { low: "sonnet·low", medium: "sonnet·medium", high: "opus·high", extra: "y" },
    });
    expect(await refusedStart(r, "task")).toEqual([
      `gates.json routing.S.medium is missing. Add it as ${HINT}.`,
      'gates.json routing.L must be an object with low, medium and high; got "big".',
      `gates.json routing.retry is missing. Add it as ${HINT}.`,
      badRoute("risky", '"gpt·high"'),
      'gates.json routing."zzz" is not a routing key; remove it.',
      'gates.json routing.S."odd" is not a routing key; remove it.',
      'gates.json routing.M."extra" is not a routing key; remove it.',
      FIX,
    ]);
  });

  it("effort1 AC-12: a bad run.fuse is reported alone, before the routing check", async () => {
    const r = repo();
    setRouting(r, undefined);
    patchGates(r.dir, { run: { fuse: { calls: 0 } } });
    const lines = await refusedStart(r);
    expect(lines.join("\n")).toContain("run.fuse");
    expect(lines.join("\n")).not.toContain("routing");
  });

  it("effort1 AC-12: run --resume with a bad routing exits 1 and changes nothing", async () => {
    const r = repo();
    r.script([impl({ writes: { "README.md": "# demo\nfixed\n" } })]);
    expect(await startRun({ ...r.opts(), mode: "quick", description: DESC })).toBe(3);
    const run = r.run();
    const runFile = join(runsDir(r), run.id, "run.json");
    const before = readFileSync(runFile, "utf8");
    const lock = readLock(r.dir);
    const files = readdirSync(join(runsDir(r), run.id));
    const calls = r.logged().length;
    const g = clone();
    (g["S"] as Json)["low"] = "opus-high";
    setRouting(r, g);
    r.out.length = 0;
    expect(await resumeRun({ ...r.opts({ gate: ["a"] }) })).toBe(1);
    expect(text(r).split("\n")).toEqual([badRoute("S.low", '"opus-high"'), FIX]);
    expect(readFileSync(runFile, "utf8")).toBe(before);
    expect(readLock(r.dir)).toEqual(lock);
    expect(readdirSync(join(runsDir(r), run.id))).toEqual(files);
    expect(r.logged().length).toBe(calls);
  });
});
