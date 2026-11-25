/**
 * scout1: routing.scout is required. Spec: docs/specs/scout1/SPEC.md (AC-8, AC-15, AC-27).
 */
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupProjects } from "../hooks/fixture.js";
import { startRun } from "../../src/run/engine/index.js";
import { checkRouting } from "../../src/run/routing.js";
import { readLock } from "../../src/run/store.js";
import { DESC, makeFakeExecutable, repo, sh, text, type Json, type Repo } from "./engine-fixture.js";

beforeAll(makeFakeExecutable);
afterEach(() => cleanupProjects());

const ROOT = join(__dirname, "..", "..");
const DEFAULT_ROUTING = JSON.parse(readFileSync(join(ROOT, "templates", "claude", "_routing.json"), "utf8")) as Json;
const clone = (): Json => JSON.parse(JSON.stringify(DEFAULT_ROUTING)) as Json;

const MISSING = "gates.json routing.scout is missing. Run agent-stack update to add it (CHANGELOG: Upgrading from 0.4.7).";
const HINT = '"<model>·<effort>"';
const bad = (got: string): string =>
  `gates.json routing.scout must be ${HINT} (model opus, sonnet or haiku; effort low, medium, high, xhigh or max); got ${got}.`;
const FIX = "Fix .claude/gates.json, then run again.";

function setRouting(r: Repo, routing: Json): void {
  const file = join(r.dir, ".claude", "gates.json");
  const g = JSON.parse(readFileSync(file, "utf8")) as Json;
  writeFileSync(file, JSON.stringify({ ...g, routing }, null, 2));
}

const runsDir = (r: Repo): string => join(r.dir, ".claude", "tmp", "runs");

describe("routing.scout", () => {
  it("scout1 AC-8: a missing scout gives the update line", () => {
    const g = clone();
    delete g["scout"];
    expect(checkRouting(g)).toEqual([MISSING]);
    expect(checkRouting(g, "x")).toEqual([MISSING.replace("agent-stack", "x")]);
  });

  it("scout1 AC-8: a bad scout value gives the route pattern line", () => {
    const g = clone();
    g["scout"] = "haiku-low";
    expect(checkRouting(g)).toEqual([bad('"haiku-low"')]);
  });

  it("scout1 AC-8: scout is checked right after risky, before unknown keys", () => {
    const g = clone();
    delete g["scout"];
    delete g["risky"];
    g["zzz"] = 1;
    expect(checkRouting(g)).toEqual([
      `gates.json routing.risky is missing. Add it as ${HINT}.`,
      MISSING,
      'gates.json routing."zzz" is not a routing key; remove it.',
    ]);
  });

  it("scout1 AC-8: scout is a known top-level key", () => {
    expect(checkRouting(clone())).toEqual([]);
  });

  for (const [name, value] of [["missing", undefined], ["bad", "gpt·low"]] as const) {
    for (const mode of ["task", "quick"] as const) {
      it(`scout1 AC-15: run ${mode} with scout ${name} exits 1 before any step and changes nothing`, async () => {
        const r = repo();
        const g = clone();
        if (value === undefined) delete g["scout"];
        else g["scout"] = value;
        setRouting(r, g);
        const head = sh(r.dir, "rev-parse", "HEAD");
        r.out.length = 0;
        const code = await startRun({ ...r.opts({ gate: ["a"] }), mode, description: DESC });
        expect(code, text(r)).toBe(1);
        expect(text(r).split("\n")).toEqual([value === undefined ? MISSING : bad('"gpt·low"'), FIX]);
        expect(existsSync(runsDir(r)) ? readdirSync(runsDir(r)) : []).toEqual([]);
        expect(readLock(r.dir)).toBeNull();
        expect(sh(r.dir, "rev-parse", "HEAD")).toBe(head);
        expect(r.logged()).toEqual([]);
      });
    }
  }
});

describe("one source of the default routing", () => {
  it("scout1 AC-27: _routing.json equals the Contract block", () => {
    expect(DEFAULT_ROUTING).toEqual({
      S: { low: "sonnet·low", medium: "sonnet·medium", high: "opus·high" },
      M: { low: "sonnet·low", medium: "sonnet·medium", high: "opus·high" },
      L: { low: "sonnet·medium", medium: "opus·medium", high: "opus·high" },
      retry: "opus·high",
      risky: "opus·high",
      scout: "haiku·low",
    });
  });

  it("scout1 AC-27: no file under src/ has a route value", () => {
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (/(opus|sonnet|haiku)·/.test(readFileSync(p, "utf8"))) hits.push(p);
      }
    };
    walk(join(ROOT, "src"));
    expect(hits).toEqual([]);
  });
});
