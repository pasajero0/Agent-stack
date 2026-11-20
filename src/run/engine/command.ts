/**
 * How hints name the driver, and the harness floor. Spec: docs/specs/v04/SPEC.md, Terms "Command name",
 * "Harness floor"; AC-72, AC-73.
 */
import { execFileSync } from "node:child_process";
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, delimiter, isAbsolute, join } from "node:path";
import { toolVersion } from "../../claude/harness.js";
import { RunError } from "../errors.js";

/** The lowest harness this driver runs with: 0.4.1 brought the agent sections it reads (AC-67, AC-72). */
export const HARNESS_FLOOR = "0.4.1";

const real = (p: string): string | null => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};

/**
 * The first executable `agent-stack` file on PATH, or null. Relative entries (`.`, `node_modules/.bin`) are
 * skipped: they resolve in the target repo, which may ship its own `agent-stack`.
 */
function onPath(env: NodeJS.ProcessEnv): string | null {
  for (const dir of (env["PATH"] ?? "").split(delimiter)) {
    if (dir === "" || !isAbsolute(dir)) continue;
    const p = join(dir, "agent-stack");
    try {
      accessSync(p, constants.X_OK);
      if (!statSync(p).isFile()) continue;
      return p;
    } catch {
      // not here
    }
  }
  return null;
}

/** A shell word for a path: single quotes when it holds anything but safe characters. */
const shellWord = (p: string): string => (/^[A-Za-z0-9_./~+-]+$/.test(p) ? p : `'${p.replace(/'/g, "'\\''")}'`);

let cached: string | null = null;

/**
 * The command name (AC-73): `agent-stack` when the one on PATH is the running cli.mjs (symlinks followed) or
 * prints the same version (a pnpm shim); otherwise `node <the running cli.mjs>`. Found once per process. When the
 * driver does not run from cli.mjs (tests, an import), it is `agent-stack`.
 */
export function commandName(argv: readonly string[] = process.argv, env: NodeJS.ProcessEnv = process.env): string {
  if (cached !== null && argv === process.argv) return cached;
  const script = argv[1] ? real(argv[1]) : null;
  let name = "agent-stack";
  if (script !== null && basename(script) === "cli.mjs") {
    const found = onPath(env);
    let same = found !== null && real(found) === script;
    if (!same && found !== null) {
      try {
        same = execFileSync(found, ["--version"], { encoding: "utf8", timeout: 5000, killSignal: "SIGKILL", stdio: ["ignore", "pipe", "ignore"] }).trim() === toolVersion();
      } catch {
        same = false;
      }
    }
    if (!same) name = `node ${shellWord(script)}`;
  }
  if (argv === process.argv) cached = name;
  return name;
}

/** `x.y.z` as numbers, or null. */
function parts(v: unknown): [number, number, number] | null {
  const m = typeof v === "string" ? /^(\d+)\.(\d+)\.(\d+)$/.exec(v) : null;
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

const below = (a: [number, number, number], b: [number, number, number]): boolean => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return (a[i] ?? 0) < (b[i] ?? 0);
  return false;
};

/** AC-72: refuses a run on a harness older than the floor, or with no readable version, before any call. */
export function requireHarness(projectDir: string): void {
  let v: [number, number, number] | null = null;
  let shown = "missing";
  try {
    const m: unknown = JSON.parse(readFileSync(join(projectDir, ".claude", ".harness.json"), "utf8"));
    const tv = typeof m === "object" && m !== null ? (m as Record<string, unknown>)["templateVersion"] : undefined;
    v = parts(tv);
    if (v !== null) shown = String(tv);
  } catch {
    v = null;
  }
  const floor = parts(HARNESS_FLOOR);
  if (floor === null) throw new Error(`bad HARNESS_FLOOR ${HARNESS_FLOOR}`);
  if (v === null || below(v, floor)) {
    throw new RunError(`The harness is ${shown}; this driver needs ${HARNESS_FLOOR} or later: run ${commandName()} update, then commit .claude/.`, 1);
  }
}
