import { readFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_STAGE_PATTERN } from "../claude/gates.js";
import { RunError } from "./errors.js";
import type { Fuse, RunConfig } from "./types.js";

const DEFAULTS = {
  maxTurns: 60,
  stepTimeoutMin: 30,
  checkTimeoutMin: 15,
  quickReviewLines: 120,
  baseBranch: "main",
  specsDir: "docs/specs",
  adrDir: "docs/adr",
};

/** A fresh `{calls: 40}` each time: callers copy the fuse into a run file and may raise it there. */
const defaultFuse = (): Fuse => ({ calls: 40 });

type Obj = Record<string, unknown>;

export function isObj(v: unknown): v is Obj {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const isPositive = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v) && v > 0;
const isPositiveInt = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v > 0;

/** `{calls: n}` (integer n > 0), `{usd: n}` (n > 0) or `"off"`; null for anything else. Shared with the run file. */
export function parseFuse(v: unknown): Fuse | null {
  if (v === "off") return "off";
  if (!isObj(v)) return null;
  const keys = Object.keys(v);
  if (keys.length !== 1) return null;
  if (keys[0] === "calls" && isPositiveInt(v.calls)) return { calls: v.calls };
  if (keys[0] === "usd" && isPositive(v.usd)) return { usd: v.usd };
  return null;
}

function fuse(o: Obj): Fuse {
  if (o.fuse === undefined) return defaultFuse();
  const f = parseFuse(o.fuse);
  if (f) return f;
  throw new RunError(
    `gates.json run.fuse must be {"calls": n} (whole n > 0), {"usd": n} (n > 0) or "off"; got ${JSON.stringify(o.fuse)}. Fix .claude/gates.json.`,
    1
  );
}

function positive(o: Obj, key: string, fallback: number): number {
  const v = o[key];
  if (v === undefined) return fallback;
  if (!isPositive(v)) throw new RunError(`gates.json run.${key} must be a number above 0; got ${JSON.stringify(v)}.`, 1);
  return v;
}

function positiveInt(o: Obj, key: string, fallback: number): number {
  const v = o[key];
  if (v === undefined) return fallback;
  if (!isPositiveInt(v)) throw new RunError(`gates.json run.${key} must be a whole number above 0; got ${JSON.stringify(v)}.`, 1);
  return v;
}

/** `name` is the key's path in gates.json, for the message. */
function str(o: Obj, key: string, fallback: string, name: string = key): string {
  const v = o[key];
  if (v === undefined) return fallback;
  if (typeof v !== "string") throw new RunError(`gates.json ${name} must be a string; got ${JSON.stringify(v)}.`, 1);
  return v;
}

function strings(o: Obj, key: string): string[] {
  const v = o[key];
  if (v === undefined) return [];
  if (!Array.isArray(v) || !v.every((x): x is string => typeof x === "string")) {
    throw new RunError(`gates.json ${key} must be an array of strings; got ${JSON.stringify(v)}.`, 1);
  }
  return v;
}

/** An optional object key: undefined (and, for `run`, null) means "use the defaults". */
function obj(o: Obj, key: string, allowNull: boolean): Obj {
  const v = o[key];
  if (v === undefined || (allowNull && v === null)) return {};
  if (!isObj(v)) throw new RunError(`gates.json ${key} must be an object; got ${JSON.stringify(v)}.`, 1);
  return v;
}

/** A repo-relative directory as the driver compares paths: no leading `./`, no trailing `/`. */
const dirPath = (p: string): string => p.replace(/^(\.\/)+/, "").replace(/\/+$/, "");

/** Reads `.claude/gates.json` and fills the `run` defaults. An invalid value is a `RunError` (exit 1). */
export function loadRunConfig(projectDir: string): RunConfig {
  const path = join(projectDir, ".claude", "gates.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    const why = e instanceof Error ? e.message : String(e);
    throw new RunError(`Cannot read ${path}: ${why}. Run \`agent-stack generate\` or fix the file.`, 1);
  }
  if (!isObj(parsed)) throw new RunError(`${path} must contain a JSON object.`, 1);

  const run = obj(parsed, "run", true);
  const cmds = obj(parsed, "commands", false);

  return {
    maxTurns: positiveInt(run, "maxTurns", DEFAULTS.maxTurns),
    fuse: fuse(run),
    stepTimeoutMin: positive(run, "stepTimeoutMin", DEFAULTS.stepTimeoutMin),
    checkTimeoutMin: positive(run, "checkTimeoutMin", DEFAULTS.checkTimeoutMin),
    quickReviewLines: positiveInt(run, "quickReviewLines", DEFAULTS.quickReviewLines),
    commands: { test: str(cmds, "test", "", "commands.test"), lint: str(cmds, "lint", "", "commands.lint") },
    lintMatch: strings(parsed, "lintMatch"),
    specsDir: dirPath(str(parsed, "specsDir", DEFAULTS.specsDir)),
    adrDir: dirPath(str(parsed, "adrDir", DEFAULTS.adrDir)),
    baseBranch: str(parsed, "baseBranch", DEFAULTS.baseBranch),
    stagePattern: str(parsed, "stagePattern", DEFAULT_STAGE_PATTERN),
    // The same default as .claude/bin/trace: docs/GLOSSARY.md unless gates.json names one ("" for none).
    glossary: dirPath(str(parsed, "glossary", "docs/GLOSSARY.md")),
  };
}
