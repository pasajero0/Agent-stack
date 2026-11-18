/** Shared setup for the v04 engine tests: a temp repo with the harness, the fake claude, gate input files. */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { deployHarness, git, patchGates, write } from "../hooks/fixture.js";
import type { EngineOptions } from "../../src/run/engine/index.js";
import { listRuns, readRunStrict } from "../../src/run/store.js";
import type { RunFile } from "../../src/run/types.js";

export const FAKE = fileURLToPath(new URL("./fake-claude.mjs", import.meta.url));
/** Above any pid_max: a lock with this pid belongs to a dead driver, so the run reads as interrupted. */
export const DEAD_PID = 4_999_999;

/** Call once per test file (beforeAll). */
export const makeFakeExecutable = (): void => chmodSync(FAKE, 0o755);

export type Json = Record<string, unknown>;

export const BRANCH = "quick/fix-the-readme-line";
export const DESC = "Fix the README line";
export const lines = (n: number): string => Array.from({ length: n }, (_, i) => `line ${i}`).join("\n") + "\n";

export interface LoggedCall {
  argv: string[];
  env: { AGENT_STACK_RUN: string | null };
}

/** One line of the fake's log, checked rather than cast. */
function isLoggedCall(v: unknown): v is LoggedCall {
  if (typeof v !== "object" || v === null || !("argv" in v) || !("env" in v)) return false;
  const { argv, env } = v;
  if (!Array.isArray(argv) || !argv.every((a) => typeof a === "string")) return false;
  if (typeof env !== "object" || env === null || !("AGENT_STACK_RUN" in env)) return false;
  return env.AGENT_STACK_RUN === null || typeof env.AGENT_STACK_RUN === "string";
}

function parseLogged(line: string): LoggedCall {
  const v: unknown = JSON.parse(line);
  if (!isLoggedCall(v)) throw new Error(`fake-claude log line has an unexpected shape: ${line}`);
  return v;
}

export interface Repo {
  dir: string;
  out: string[];
  /** Fake claude responses, consumed in order across invocations. */
  script: (responses: Json[]) => void;
  /** Engine options; `gate` lines become the AGENT_STACK_GATE_INPUT file of this invocation. */
  opts: (o?: { gate?: string[]; pid?: number; signal?: AbortSignal }) => EngineOptions;
  run: () => RunFile;
  logged: () => LoggedCall[];
}

let clock = 0;

export function repo(gates: { test?: string; lint?: string; run?: Json; extra?: Json } = {}): Repo {
  const dir = deployHarness();
  patchGates(dir, {
    commands: { test: gates.test ?? "true", lint: gates.lint ?? "" },
    ...(gates.run ? { run: gates.run } : {}),
    ...(gates.extra ?? {}),
  });
  write(dir, "README.md", "# demo\n");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "test");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "chore: init");
  const scriptPath = join(dir, ".git", "fake-script.json");
  const logPath = join(dir, ".git", "fake-log.jsonl");
  const out: string[] = [];
  let gateNo = 0;
  return {
    dir,
    out,
    script: (responses) => writeFileSync(scriptPath, JSON.stringify(responses)),
    opts: (o = {}) => {
      const env: Record<string, string> = {
        AGENT_STACK_CLAUDE: FAKE,
        FAKE_CLAUDE_SCRIPT: scriptPath,
        FAKE_CLAUDE_LOG: logPath,
      };
      if (o.gate) {
        const file = join(dir, ".git", `gate-${gateNo++}.txt`);
        writeFileSync(file, o.gate.map((l) => `${l}\n`).join(""));
        env["AGENT_STACK_GATE_INPUT"] = file;
      }
      clock++;
      return {
        projectDir: dir,
        env,
        isTTY: false,
        pid: o.pid ?? DEAD_PID,
        now: new Date(2026, 10, 18, 12, Math.floor(clock / 60) % 60, clock % 60),
        out: (line: string) => out.push(line),
        ...(o.signal ? { signal: o.signal } : {}),
      };
    },
    run: () => {
      const ids = listRuns(dir);
      return readRunStrict(dir, ids[ids.length - 1] ?? "");
    },
    logged: () =>
      existsSync(logPath)
        ? readFileSync(logPath, "utf8")
            .trim()
            .split("\n")
            .map(parseLogged)
        : [],
  };
}

export const impl = (o: {
  writes?: Record<string, string>;
  model?: "sonnet" | "opus";
  status?: "DONE" | "BLOCKED";
  exec?: string;
  subject?: string;
  report?: string;
  needs?: string[];
}): Json => ({
  expectRole: "implement",
  expectModel: o.model ?? "sonnet",
  ...(o.writes ? { writes: o.writes } : {}),
  ...(o.exec ? { exec: o.exec } : {}),
  output: {
    status: o.status ?? "DONE",
    report: o.report ?? "changed the readme",
    commit: { type: "fix", subject: o.subject ?? "Fix the README line." },
    needsHumanDecision: o.needs ?? [],
  },
});

export const review = (o: { quality?: "pass" | "fail"; verifyProves?: boolean; warning?: string } = {}): Json => ({
  expectRole: "review",
  output: {
    spec: "pass",
    quality: o.quality ?? "pass",
    verifyProves: o.verifyProves ?? true,
    findings: o.warning ? [{ severity: "warning", text: o.warning }] : [],
  },
});

export const sh = (dir: string, ...args: string[]): string => git(dir, ...args).trim();
export const text = (r: Repo): string => r.out.join("\n");
