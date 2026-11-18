import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadRunConfig, parseFuse } from "../../src/run/config.js";
import { RunError } from "../../src/run/errors.js";
import { DEFAULT_STAGE_PATTERN } from "../../src/claude/gates.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "agent-stack-runcfg-"));
  mkdirSync(join(dir, ".claude"), { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const writeGates = (g: unknown) => writeFileSync(join(dir, ".claude", "gates.json"), JSON.stringify(g));

/** Loads the config and returns the RunError it throws; fails the test if it throws nothing else. */
function refusal(label: string): RunError {
  let err: unknown;
  try {
    loadRunConfig(dir);
  } catch (e) {
    err = e;
  }
  expect(err, label).toBeInstanceOf(RunError);
  if (!(err instanceof RunError)) throw new Error(`${label}: no RunError`);
  expect(err.exitCode, label).toBe(1);
  return err;
}

const DEFAULTS = {
  maxTurns: 60,
  fuse: { calls: 40 },
  stepTimeoutMin: 30,
  checkTimeoutMin: 15,
  quickReviewLines: 120,
  commands: { test: "", lint: "" },
  lintMatch: [],
  specsDir: "docs/specs",
  adrDir: "docs/adr",
  baseBranch: "main",
  stagePattern: DEFAULT_STAGE_PATTERN,
};

describe("loadRunConfig", () => {
  it("fills the run defaults when gates.json has no run key", () => {
    writeGates({
      baseBranch: "main",
      specsDir: "docs/specs",
      adrDir: "docs/adr",
      stagePattern: "^([A-Za-z]+[0-9]+)",
      commands: { test: "pnpm test", lint: "" },
      lintMatch: ["*.ts"],
    });
    expect(loadRunConfig(dir)).toMatchObject({
      ...DEFAULTS,
      commands: { test: "pnpm test", lint: "" },
      lintMatch: ["*.ts"],
      stagePattern: "^([A-Za-z]+[0-9]+)",
    });
  });

  it("treats run: null as no run key", () => {
    writeGates({ run: null });
    expect(loadRunConfig(dir)).toEqual(DEFAULTS);
  });

  it("fills defaults for every missing optional gates key", () => {
    writeGates({});
    expect(loadRunConfig(dir)).toEqual(DEFAULTS);
  });

  it("returns a fresh default fuse on every call", () => {
    writeGates({});
    const a = loadRunConfig(dir);
    const b = loadRunConfig(dir);
    expect(a.fuse).toEqual({ calls: 40 });
    expect(a.fuse).not.toBe(b.fuse);
  });

  it("takes run overrides, fractional timeouts and the usd and off fuses", () => {
    writeGates({ run: { maxTurns: 10, stepTimeoutMin: 0.5, checkTimeoutMin: 0.25, fuse: { usd: 2.5 } } });
    const c = loadRunConfig(dir);
    expect(c.maxTurns).toBe(10);
    expect(c.stepTimeoutMin).toBe(0.5);
    expect(c.checkTimeoutMin).toBe(0.25);
    expect(c.fuse).toEqual({ usd: 2.5 });
    writeGates({ run: { fuse: "off" } });
    expect(loadRunConfig(dir).fuse).toBe("off");
  });

  it("refuses an invalid fuse with exit code 1", () => {
    for (const fuse of [{ calls: 0 }, { usd: -1 }, "on", 5, { calls: 1, usd: 1 }, {}, null, { calls: "3" }, { calls: 1.5 }]) {
      writeGates({ run: { fuse } });
      expect(refusal(JSON.stringify(fuse)).message).toContain("run.fuse");
    }
  });

  it("refuses a non-integer or non-positive maxTurns and quickReviewLines", () => {
    for (const key of ["maxTurns", "quickReviewLines"]) {
      for (const v of [0, -3, 2.5, "60", null, true]) {
        writeGates({ run: { [key]: v } });
        expect(refusal(`${key}=${JSON.stringify(v)}`).message).toContain(`run.${key}`);
      }
    }
  });

  it("refuses a non-positive timeout", () => {
    for (const key of ["stepTimeoutMin", "checkTimeoutMin"]) {
      for (const v of [0, -0.5, "30", null]) {
        writeGates({ run: { [key]: v } });
        expect(refusal(`${key}=${JSON.stringify(v)}`).message).toContain(`run.${key}`);
      }
    }
  });

  it("refuses a present key of the wrong type and names it", () => {
    const cases: [unknown, string][] = [
      [{ commands: { test: 5 } }, "commands.test"],
      [{ commands: { lint: false } }, "commands.lint"],
      [{ commands: "pnpm test" }, "commands"],
      [{ lintMatch: "*.ts" }, "lintMatch"],
      [{ lintMatch: ["*.ts", 3] }, "lintMatch"],
      [{ specsDir: 1 }, "specsDir"],
      [{ adrDir: null }, "adrDir"],
      [{ baseBranch: [] }, "baseBranch"],
      [{ stagePattern: {} }, "stagePattern"],
      [{ run: [] }, "run"],
      [{ run: "x" }, "run"],
    ];
    for (const [gates, key] of cases) {
      writeGates(gates);
      expect(refusal(JSON.stringify(gates)).message).toContain(key);
    }
  });

  it("refuses a missing or malformed gates.json with exit code 1", () => {
    refusal("missing");
    writeFileSync(join(dir, ".claude", "gates.json"), "{nope");
    refusal("malformed");
    writeGates([1, 2]);
    refusal("array");
  });
});

describe("parseFuse", () => {
  it("accepts the three forms and returns null for anything else", () => {
    expect(parseFuse({ calls: 3 })).toEqual({ calls: 3 });
    expect(parseFuse({ usd: 0.5 })).toEqual({ usd: 0.5 });
    expect(parseFuse("off")).toBe("off");
    for (const v of [{ calls: 2.5 }, { usd: 0 }, { calls: 1, x: 1 }, undefined, Number.NaN, { usd: Infinity }]) {
      expect(parseFuse(v), String(v)).toBeNull();
    }
  });
});
