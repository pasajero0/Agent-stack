/**
 * Starting Claude Code for one role and classifying how the call ended.
 * Spec: docs/specs/v04/SPEC.md — "How Claude Code is invoked", "Result fields the driver reads", AC-2, AC-35..38, AC-58.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import type { Role } from "./types.js";

export type Model = "opus" | "sonnet";

/** implement's commands: its `--allowedTools` entries are built from them. */
export interface CallCommands {
  test: string;
  lint: string;
  verify: string;
}

interface CallSpecBase {
  model: Model;
  maxTurns: number;
  /** The role's JSON schema, passed as `--json-schema`. */
  schema: Record<string, unknown>;
  /** Dollars left; set only with a `usd` fuse, otherwise null. */
  budgetUsd: number | null;
}

/** Keyed on role: `commands` is required for implement and absent for every other role. */
export type CallSpec =
  | (CallSpecBase & { role: "implement"; commands: CallCommands })
  | (CallSpecBase & { role: Exclude<Role, "implement">; commands?: never });

export interface CallIo {
  cwd: string;
  /** Sent on stdin; never written to disk. */
  prompt: string;
  /** Exported to the child as `AGENT_STACK_RUN`. */
  runId: string;
  /** The run's `calls/` folder. */
  callsDir: string;
  /** Number of this call in the run; names `calls/<n>-<role>.json`. */
  callNo: number;
  timeoutMs: number;
  /** Extra environment; also the source of `AGENT_STACK_CLAUDE` (falls back to process.env). */
  env?: Record<string, string>;
  /** Checks `structured_output`; returns an error message or null. */
  validate?: (value: unknown) => string | null;
  /** Aborting kills the call's whole process group (SIGINT/SIGTERM in the driver, AC-51). */
  signal?: AbortSignal;
}

/** What a call may load besides the repo (AC-58): the project's MCP config, and the user CLAUDE.md to exclude. */
export interface CallScope {
  /** `--mcp-config`: the project's `.mcp.json`, or an empty server list. */
  mcpConfig: string;
  /** Absolute path of the user-level CLAUDE.md, passed in `claudeMdExcludes`. */
  userClaudeMd: string;
}

const NO_MCP = '{"mcpServers":{}}';

/** `configDir` is `$CLAUDE_CONFIG_DIR`: Claude Code keeps the user's CLAUDE.md there when it is set (AC-58). */
export function callScope(projectDir: string, home: string, configDir?: string): CallScope {
  const mcp = join(projectDir, ".mcp.json");
  const userDir = configDir ? configDir : join(home, ".claude");
  return { mcpConfig: existsSync(mcp) ? mcp : NO_MCP, userClaudeMd: join(userDir, "CLAUDE.md") };
}

/**
 * The child's env (AC-58): the account's claude.ai connectors (about 150k tokens a turn), auto-memory and the
 * git status snapshot (the user's name) are off.
 */
export const PROJECT_ONLY_ENV: Readonly<Record<string, string>> = {
  ENABLE_CLAUDEAI_MCP_SERVERS: "false",
  CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
  CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1",
};

export type CallOutcome =
  // costUsd is null when the cost is unknown: a killed call, or a result without total_cost_usd (AC-62).
  | { kind: "ok"; output: unknown; costUsd: number | null; denials: string[]; turns: number }
  | { kind: "infra"; message: string; costUsd: number | null }
  | {
      kind: "turns" | "exec-error" | "timeout" | "aborted" | "budget" | "schema";
      message: string;
      costUsd: number | null;
      turns: number;
    };

const ROLE_TOOLS: Record<Role, { tools: string; mode: "default" | "acceptEdits" }> = {
  clarify: { tools: "Read,Glob,Grep", mode: "default" },
  spec: { tools: "Read,Glob,Grep,Write,Edit,Agent", mode: "acceptEdits" },
  // The driver writes tasks.json from the output (AC-12): Claude Code guards `.claude/` even under acceptEdits.
  plan: { tools: "Read,Glob,Grep", mode: "default" },
  implement: { tools: "Read,Glob,Grep,Edit,Write,Bash", mode: "acceptEdits" },
  review: { tools: "Read,Glob,Grep", mode: "default" },
};

/** implement's `--allowedTools`: test, lint prefix, read-only git, the task's verify verbatim; empty ones left out. */
function implementAllowed(c: CallCommands): string[] {
  const lintPrefix = c.lint.split("{file}")[0]?.trim() ?? "";
  const test = c.test.trim();
  const verify = c.verify.trim();
  const out: string[] = [];
  if (test) out.push(`Bash(${test}:*)`);
  if (lintPrefix) out.push(`Bash(${lintPrefix}:*)`);
  out.push("Bash(git status:*)", "Bash(git diff:*)", "Bash(git log:*)", "Bash(git show:*)");
  if (verify) out.push(`Bash(${verify})`);
  return out;
}

/** implement's allowed shell commands in words, from the same list as its `--allowedTools` (AC-4). */
export function allowedCommandLines(c: CallCommands): string[] {
  const prefixes: string[] = [];
  const exact: string[] = [];
  for (const e of implementAllowed(c)) {
    const inner = e.slice("Bash(".length, -1);
    if (inner.endsWith(":*")) prefixes.push(inner.slice(0, -2));
    else exact.push(inner);
  }
  const git = prefixes.filter((p) => p.startsWith("git "));
  return [
    ...prefixes.filter((p) => !p.startsWith("git ")).map((p) => `- \`${p}\` (any arguments)`),
    ...(git.length > 0 ? [`- ${git.map((g) => `\`${g}\``).join(", ")} (any arguments)`] : []),
    ...exact.map((x) => `- \`${x}\` (exactly)`),
  ];
}

/**
 * The argv (without the binary) for one call. Never `--bare`, a bypass mode or `disableAllHooks` (AC-2); only
 * the project's MCP servers, settings and CLAUDE.md (AC-58).
 */
export function buildArgs(spec: CallSpec, scope: CallScope): string[] {
  const { tools, mode } = ROLE_TOOLS[spec.role];
  const args = [
    "-p",
    "--output-format",
    "json",
    "--max-turns",
    String(spec.maxTurns),
    "--model",
    spec.model,
    "--json-schema",
    JSON.stringify(spec.schema),
    "--tools",
    tools,
    "--permission-mode",
    mode,
    "--strict-mcp-config",
    "--mcp-config",
    scope.mcpConfig,
    "--setting-sources",
    "project,local",
    "--settings",
    JSON.stringify({ claudeMdExcludes: [scope.userClaudeMd] }),
  ];
  if (spec.budgetUsd !== null) args.push("--max-budget-usd", String(spec.budgetUsd));
  if (spec.role === "implement") {
    // Variadic flag, one argv element per entry (entries hold spaces); kept last so nothing follows its values.
    args.push("--allowedTools", ...implementAllowed(spec.commands));
  }
  return args;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseResult(stdout: string): Record<string, unknown> | null {
  const text = stdout.trim();
  if (!text) return null;
  try {
    const v: unknown = JSON.parse(text);
    return isRecord(v) && v["type"] === "result" ? v : null;
  } catch {
    return null;
  }
}

/** The longest denial line, with its "permission denied: " prefix (AC-32). */
export const DENIAL_MAX = 120;
const PREFIX = "permission denied: ";

/** One short line per denial, prefix included: the tool and its file path or command, never the whole input (AC-32). */
export function denialLine(d: unknown): string {
  let text: string;
  if (typeof d === "string") text = d;
  else if (isRecord(d)) {
    const name = typeof d["tool_name"] === "string" ? d["tool_name"] : "tool";
    const input = isRecord(d["tool_input"]) ? d["tool_input"] : {};
    const target = [input["file_path"], input["command"], input["path"], input["pattern"]].find((v) => typeof v === "string");
    text = `${name} ${typeof target === "string" ? target : JSON.stringify(input)}`;
  } else text = JSON.stringify(d);
  const line = text.replace(/\s+/g, " ").trim();
  const room = DENIAL_MAX - PREFIX.length;
  return PREFIX + (line.length <= room ? line : `${line.slice(0, room - 1)}…`);
}

/** Classifies a parsed result by `subtype`, `is_error` and `num_turns`. */
export function classify(result: Record<string, unknown>, validate?: (v: unknown) => string | null): CallOutcome {
  const num = (k: string): number => {
    const v = result[k];
    return typeof v === "number" && Number.isFinite(v) ? v : 0;
  };
  const turns = num("num_turns");
  const rawCost = result["total_cost_usd"];
  const costUsd = typeof rawCost === "number" && Number.isFinite(rawCost) && rawCost >= 0 ? rawCost : null;
  const subtype = typeof result["subtype"] === "string" ? result["subtype"] : "";
  const isError = result["is_error"] === true;

  if (subtype === "error_max_budget_usd") return { kind: "budget", message: "the dollar fuse was reached", costUsd, turns };
  if (isError && turns === 0) {
    const detail = typeof result["result"] === "string" ? `: ${result["result"]}` : "";
    return { kind: "infra", message: `claude failed before its first turn (${subtype || "no subtype"})${detail}`, costUsd };
  }
  switch (subtype) {
    case "error_max_turns":
      return { kind: "turns", message: `stopped at max turns (${turns})`, costUsd, turns };
    case "error_during_execution":
      return { kind: "exec-error", message: `error during execution after ${turns} turns`, costUsd, turns };
    case "error_max_structured_output_retries":
      return { kind: "schema", message: "output did not match the schema after retries", costUsd, turns };
    case "success": {
      if (isError) return { kind: "exec-error", message: `is_error after ${turns} turns`, costUsd, turns };
      const output = result["structured_output"];
      if (output === undefined || output === null) {
        return { kind: "schema", message: "no structured_output in the result", costUsd, turns };
      }
      const err = validate ? validate(output) : null;
      if (err !== null) return { kind: "schema", message: `structured_output does not match: ${err}`, costUsd, turns };
      const raw = result["permission_denials"];
      const denials = Array.isArray(raw) ? raw.map(denialLine) : [];
      return { kind: "ok", output, costUsd, denials, turns };
    }
    default:
      return { kind: "infra", message: `unknown result subtype "${subtype}"`, costUsd };
  }
}

/** SIGKILL to the child's process group (it is spawned detached, so it leads one); the child alone as a fallback. */
function killGroup(pid: number | undefined, killChild: () => void): void {
  try {
    if (pid === undefined) throw new Error("no pid");
    process.kill(-pid, "SIGKILL");
  } catch {
    killChild();
  }
}

/**
 * Runs one Claude call: prompt on stdin, `AGENT_STACK_RUN` set; records `calls/<n>-<role>.json`.
 * The child runs detached in its own process group. After `timeoutMs`, or when `io.signal` aborts, the
 * whole group is killed, so tools the call started (test runners, servers) die with it.
 */
export async function callClaude(spec: CallSpec, io: CallIo): Promise<CallOutcome> {
  const bin = io.env?.["AGENT_STACK_CLAUDE"] ?? process.env["AGENT_STACK_CLAUDE"] ?? "claude";
  const configDir = io.env?.["CLAUDE_CONFIG_DIR"] ?? process.env["CLAUDE_CONFIG_DIR"];
  const args = buildArgs(spec, callScope(io.cwd, homedir(), configDir));
  const sub = execa(bin, args, {
    cwd: io.cwd,
    input: io.prompt,
    env: { ...io.env, ...PROJECT_ONLY_ENV, AGENT_STACK_RUN: io.runId },
    detached: true,
    reject: false,
    stripFinalNewline: false,
  });
  let stopped: "timeout" | "aborted" | null = null;
  const stop = (why: "timeout" | "aborted"): void => {
    stopped ??= why;
    killGroup(sub.pid, () => sub.kill("SIGKILL"));
  };
  const timer = setTimeout(() => stop("timeout"), io.timeoutMs);
  const onAbort = (): void => stop("aborted");
  if (io.signal?.aborted) onAbort();
  else io.signal?.addEventListener("abort", onAbort, { once: true });
  let proc: Awaited<typeof sub>;
  try {
    proc = await sub;
  } finally {
    clearTimeout(timer);
    io.signal?.removeEventListener("abort", onAbort);
  }
  const stdout = typeof proc.stdout === "string" ? proc.stdout : "";
  const result = parseResult(stdout);
  const exitCode = typeof proc.exitCode === "number" ? proc.exitCode : null;

  mkdirSync(io.callsDir, { recursive: true });
  writeFileSync(
    join(io.callsDir, `${io.callNo}-${spec.role}.json`),
    JSON.stringify({ argv: [bin, ...args], exitCode, result: result ?? stdout }, null, 2) + "\n"
  );

  if (stopped !== null) {
    const turns = result && typeof result["num_turns"] === "number" ? result["num_turns"] : 0;
    const message = stopped === "timeout" ? `killed after ${io.timeoutMs} ms` : "killed: the run was interrupted";
    return { kind: stopped, message, costUsd: null, turns };
  }
  if (!result) {
    const stderr = typeof proc.stderr === "string" ? proc.stderr.trim() : "";
    const why = proc.failed && exitCode === null ? proc.shortMessage : `exit ${exitCode ?? "none"}`;
    return { kind: "infra", message: `claude returned no result JSON (${why})${stderr ? `: ${stderr}` : ""}`, costUsd: null };
  }
  return classify(result, io.validate);
}
