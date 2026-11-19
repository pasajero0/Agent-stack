import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { setTimeout as delay } from "node:timers/promises";
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { buildArgs, callClaude, callScope, PROJECT_ONLY_ENV, type CallSpec, type CallIo, type CallScope } from "../../src/run/claude.js";
import type { Role } from "../../src/run/types.js";

type Commands = { test: string; lint: string; verify: string };
type Common = Pick<CallSpec, "model" | "maxTurns" | "schema" | "budgetUsd">;
const NO_COMMANDS: Commands = { test: "", lint: "", verify: "" };

const FAKE = fileURLToPath(new URL("./fake-claude.mjs", import.meta.url));
const SCHEMA = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
const SCOPE: CallScope = { mcpConfig: '{"mcpServers":{}}', userClaudeMd: "/home/u/.claude/CLAUDE.md" };
const FORBIDDEN = ["--bare", "bypassPermissions", "--dangerously-skip-permissions", "disableAllHooks"];

/** A non-implement spec: it carries no commands. */
const spec = (role: Exclude<Role, "implement">, over: Partial<Common> = {}): CallSpec => ({
  role,
  model: "opus",
  maxTurns: 60,
  schema: SCHEMA,
  budgetUsd: null,
  ...over,
});

/** An implement spec: commands are required. */
const impl = (commands: Commands = NO_COMMANDS, over: Partial<Common> = {}): CallSpec => ({
  role: "implement",
  commands,
  model: "sonnet",
  maxTurns: 60,
  schema: SCHEMA,
  budgetUsd: null,
  ...over,
});

const anyRole = (role: Role, commands: Commands): CallSpec => (role === "implement" ? impl(commands) : spec(role));

/** True while a process with this pid exists. */
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** Waits up to `ms` for the pid to disappear. */
async function gone(pid: number, ms = 3_000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (!alive(pid)) return true;
    await delay(50);
  }
  return !alive(pid);
}

const valueAfter = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

/** Values of a variadic flag: the args after it up to the next `--` flag. */
const variadic = (args: string[], name: string): string[] => {
  const i = args.indexOf(name);
  if (i < 0) return [];
  const out: string[] = [];
  for (let j = i + 1; j < args.length && !args[j].startsWith("-"); j++) out.push(args[j]);
  return out;
};

describe("buildArgs", () => {
  const table: Array<[Role, string, string]> = [
    ["clarify", "Read,Glob,Grep", "default"],
    ["spec", "Read,Glob,Grep,Write,Edit,Agent", "acceptEdits"],
    ["plan", "Read,Glob,Grep", "default"],
    ["implement", "Read,Glob,Grep,Edit,Write,Bash", "acceptEdits"],
    ["review", "Read,Glob,Grep", "default"],
  ];

  for (const [role, tools, mode] of table) {
    it(`v04 AC-2: ${role} gets -p, json output, max turns, model, schema, its tools and permission mode`, () => {
      const args = buildArgs(anyRole(role, { test: "pnpm test", lint: "", verify: "pnpm vitest run x" }), SCOPE);
      expect(args).toContain("-p");
      expect(valueAfter(args, "--output-format")).toBe("json");
      expect(valueAfter(args, "--max-turns")).toBe("60");
      expect(valueAfter(args, "--model")).toBe(role === "implement" ? "sonnet" : "opus");
      expect(JSON.parse(valueAfter(args, "--json-schema") ?? "null")).toEqual(SCHEMA);
      expect(valueAfter(args, "--tools")).toBe(tools);
      expect(valueAfter(args, "--permission-mode")).toBe(mode);
      expect(args).not.toContain("--max-budget-usd");
      if (role !== "implement") expect(args).not.toContain("--allowedTools");
      for (const a of args) for (const bad of FORBIDDEN) expect(a).not.toContain(bad);
    });
  }

  it("v04 AC-2: implement allows test, lint prefix, read-only git and the task's verify verbatim", () => {
    const verify = "test -f a.ts && pnpm vitest run tests/run/a.test.ts && pnpm typecheck";
    const args = buildArgs(impl({ test: "pnpm test", lint: "eslint --fix {file}", verify }, { model: "opus" }), SCOPE);
    expect(valueAfter(args, "--model")).toBe("opus");
    expect(variadic(args, "--allowedTools")).toEqual([
      "Bash(pnpm test:*)",
      "Bash(eslint --fix:*)",
      "Bash(git status:*)",
      "Bash(git diff:*)",
      "Bash(git log:*)",
      "Bash(git show:*)",
      `Bash(${verify})`,
    ]);
    for (const a of args) expect(a).not.toContain(".claude/bin/verify");
  });

  it("v04 AC-2: implement leaves out allowedTools entries whose command is empty", () => {
    const args = buildArgs(impl({ test: "", lint: "  ", verify: "" }), SCOPE);
    expect(variadic(args, "--allowedTools")).toEqual([
      "Bash(git status:*)",
      "Bash(git diff:*)",
      "Bash(git log:*)",
      "Bash(git show:*)",
    ]);
  });

  it("v04 AC-35: --max-budget-usd is passed only with a dollar fuse", () => {
    expect(valueAfter(buildArgs(spec("review", { budgetUsd: 1.25 }), SCOPE), "--max-budget-usd")).toBe("1.25");
    expect(buildArgs(spec("review", { budgetUsd: null }), SCOPE)).not.toContain("--max-budget-usd");
  });

  it("v04 AC-58: every role loads only the project's MCP servers, settings and CLAUDE.md", () => {
    for (const role of ["clarify", "spec", "plan", "implement", "review"] as const) {
      const args = buildArgs(anyRole(role, { test: "pnpm test", lint: "", verify: "x" }), SCOPE);
      expect(args).toContain("--strict-mcp-config");
      expect(valueAfter(args, "--mcp-config")).toBe('{"mcpServers":{}}');
      expect(valueAfter(args, "--setting-sources")).toBe("project,local");
      expect(JSON.parse(valueAfter(args, "--settings") ?? "null")).toEqual({ claudeMdExcludes: ["/home/u/.claude/CLAUDE.md"] });
    }
  });

  it("v04 AC-58: implement's variadic --allowedTools stays last, after the project-only flags", () => {
    const args = buildArgs(impl({ test: "pnpm test", lint: "", verify: "" }), SCOPE);
    expect(args.indexOf("--allowedTools")).toBeGreaterThan(args.indexOf("--settings"));
    expect(args.indexOf("--allowedTools") + variadic(args, "--allowedTools").length).toBe(args.length - 1);
  });

  it("v04 AC-58: callScope uses the project's .mcp.json when it exists, an empty server list otherwise", () => {
    const d = mkdtempSync(join(tmpdir(), "as-scope-"));
    try {
      expect(callScope(d, "/home/u")).toEqual(SCOPE);
      writeFileSync(join(d, ".mcp.json"), '{"mcpServers":{"x":{"command":"x"}}}');
      expect(callScope(d, "/home/u")).toEqual({ mcpConfig: join(d, ".mcp.json"), userClaudeMd: "/home/u/.claude/CLAUDE.md" });
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("v04 AC-58: the env turns off account connectors, auto-memory and the git status snapshot", () => {
    expect(PROJECT_ONLY_ENV).toEqual({
      ENABLE_CLAUDEAI_MCP_SERVERS: "false",
      CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
      CLAUDE_CODE_DISABLE_GIT_INSTRUCTIONS: "1",
    });
  });
});

describe("callClaude with the fake claude", () => {
  let dir: string;
  let script: string;
  let log: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-stack-claude-"));
    script = join(dir, "script.json");
    log = join(dir, "log.jsonl");
    chmodSync(FAKE, 0o755);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const io = (responses: unknown[], over: Partial<CallIo> = {}): CallIo => {
    writeFileSync(script, JSON.stringify(responses));
    return {
      cwd: dir,
      prompt: "# Role: review\nSECRET-PROMPT-TEXT",
      runId: "20261118-120000",
      callsDir: join(dir, "calls"),
      callNo: 1,
      timeoutMs: 10_000,
      env: { AGENT_STACK_CLAUDE: FAKE, FAKE_CLAUDE_SCRIPT: script, FAKE_CLAUDE_LOG: log },
      ...over,
    };
  };
  type Env = { AGENT_STACK_RUN: string | null } & Record<string, string | null>;
  const logged = (): Array<{ argv: string[]; env: Env }> =>
    readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as { argv: string[]; env: Env });

  it("v04 AC-2: runs $AGENT_STACK_CLAUDE with the built argv, prompt on stdin and AGENT_STACK_RUN set", async () => {
    const s = spec("review");
    const out = await callClaude(s, io([{ expectRole: "review", output: { ok: true } }]));
    expect(out).toEqual({ kind: "ok", output: { ok: true }, costUsd: 0.01, denials: [], turns: 3 });
    const [entry] = logged();
    expect(entry.argv).toEqual(buildArgs(s, callScope(dir, homedir())));
    expect(entry.env.AGENT_STACK_RUN).toBe("20261118-120000");
  });

  it("v04 AC-58: the child gets the project-only env", async () => {
    await callClaude(spec("review"), io([{ output: { ok: true } }]));
    const [entry] = logged();
    expect(entry.env).toMatchObject(PROJECT_ONLY_ENV);
  });

  it("v04 AC-2: writes calls/<n>-<role>.json with argv, exit code and result, never the prompt", async () => {
    await callClaude(spec("review"), io([{ output: { ok: true } }], { callNo: 4 }));
    const file = join(dir, "calls", "4-review.json");
    const raw = readFileSync(file, "utf8");
    expect(raw).not.toContain("SECRET-PROMPT-TEXT");
    const rec = JSON.parse(raw) as { argv: string[]; exitCode: number; result: { subtype: string } };
    expect(rec.argv).toContain("--json-schema");
    expect(rec.exitCode).toBe(0);
    expect(rec.result.subtype).toBe("success");
  });

  it("v04 AC-2: ok reports permission denials and the cost", async () => {
    const stdout = {
      type: "result", subtype: "success", is_error: false, num_turns: 7, total_cost_usd: 0.5,
      permission_denials: [{ tool_name: "Bash", tool_input: { command: "rm -rf x" } }],
      structured_output: { ok: true },
    };
    const out = await callClaude(spec("review"), io([{ stdout }]));
    expect(out.kind).toBe("ok");
    if (out.kind !== "ok") return;
    expect(out.costUsd).toBe(0.5);
    expect(out.turns).toBe(7);
    expect(out.denials).toHaveLength(1);
    expect(out.denials[0]).toContain("Bash");
  });

  it("v04 AC-36: no result JSON is an infrastructure failure", async () => {
    const out = await callClaude(spec("review"), io([{ stdout: "boom, not json", exit: 1 }]));
    expect(out.kind).toBe("infra");
    expect(existsSync(join(dir, "calls", "1-review.json"))).toBe(true);
  });

  it("v04 AC-36: is_error with num_turns 0 is an infrastructure failure", async () => {
    const stdout = { type: "result", subtype: "error_during_execution", is_error: true, num_turns: 0, total_cost_usd: 0 };
    const out = await callClaude(spec("review"), io([{ stdout, exit: 1 }]));
    expect(out.kind).toBe("infra");
  });

  it("v04 AC-36: a binary that cannot start is an infrastructure failure", async () => {
    const out = await callClaude(
      spec("review"),
      io([{}], { env: { AGENT_STACK_CLAUDE: join(dir, "no-such-claude") } })
    );
    expect(out.kind).toBe("infra");
  });

  it("v04 AC-37: structured_output rejected by the validator is a schema outcome", async () => {
    const validate = (v: unknown): string | null =>
      typeof v === "object" && v !== null && "ok" in v ? null : "missing ok";
    const out = await callClaude(spec("review"), io([{ output: { nope: 1 } }], { validate }));
    expect(out).toMatchObject({ kind: "schema", message: expect.stringContaining("missing ok") });
  });

  it("v04 AC-37: a missing structured_output is a schema outcome", async () => {
    const out = await callClaude(spec("review"), io([{}]));
    expect(out.kind).toBe("schema");
  });

  it("v04 AC-37: error_max_structured_output_retries is a schema outcome", async () => {
    const stdout = { type: "result", subtype: "error_max_structured_output_retries", is_error: true, num_turns: 4, total_cost_usd: 0.2 };
    const out = await callClaude(spec("review"), io([{ stdout, exit: 1 }]));
    expect(out).toMatchObject({ kind: "schema", costUsd: 0.2 });
  });

  it("v04 AC-38: error_max_turns is a turns outcome", async () => {
    const stdout = { type: "result", subtype: "error_max_turns", is_error: true, num_turns: 60, total_cost_usd: 1 };
    const out = await callClaude(impl(), io([{ stdout, exit: 1 }]));
    expect(out).toMatchObject({ kind: "turns", turns: 60, costUsd: 1 });
  });

  it("v04 AC-38: error_during_execution after more than 0 turns is an exec-error outcome", async () => {
    const stdout = { type: "result", subtype: "error_during_execution", is_error: true, num_turns: 5, total_cost_usd: 0.3 };
    const out = await callClaude(impl(), io([{ stdout, exit: 1 }]));
    expect(out).toMatchObject({ kind: "exec-error", turns: 5 });
  });

  it("v04 AC-38: a call past its timeout is killed and is a timeout outcome", async () => {
    const started = Date.now();
    const out = await callClaude(impl(), io([{ sleepMs: 20_000, output: { ok: true } }], { timeoutMs: 300 }));
    expect(out.kind).toBe("timeout");
    expect(Date.now() - started).toBeLessThan(8_000);
    expect(existsSync(join(dir, "calls", "1-implement.json"))).toBe(true);
  });

  it("v04 AC-35: error_max_budget_usd is a budget outcome", async () => {
    const stdout = { type: "result", subtype: "error_max_budget_usd", is_error: true, num_turns: 9, total_cost_usd: 2 };
    const out = await callClaude(impl(NO_COMMANDS, { budgetUsd: 2 }), io([{ stdout, exit: 1 }]));
    expect(out).toMatchObject({ kind: "budget", costUsd: 2 });
  });

  it("the fake checks role and model, and the calls folder holds one file per call", async () => {
    const out = await callClaude(spec("clarify", { model: "sonnet" }), io([{ expectRole: "clarify" }], {
      prompt: "# Role: clarify\n",
    }));
    expect(out.kind).toBe("infra");
    expect(readdirSync(join(dir, "calls"))).toEqual(["1-clarify.json"]);
  });

  it("v04 AC-36: success with is_error after 0 turns is an infrastructure failure", async () => {
    const stdout = { type: "result", subtype: "success", is_error: true, num_turns: 0, total_cost_usd: 0, result: "auth" };
    const out = await callClaude(spec("review"), io([{ stdout, exit: 1 }]));
    expect(out.kind).toBe("infra");
  });

  it("v04 AC-38: success with is_error after more than 0 turns is an exec-error outcome", async () => {
    const stdout = { type: "result", subtype: "success", is_error: true, num_turns: 4, total_cost_usd: 0.4 };
    const out = await callClaude(impl(), io([{ stdout, exit: 1 }]));
    expect(out).toMatchObject({ kind: "exec-error", turns: 4, costUsd: 0.4 });
  });

  /** A response whose exec starts a long-lived grandchild and records its pid, then keeps the fake busy. */
  const withGrandchild = (pidFile: string) => ({ exec: `sleep 30 & echo $! > '${pidFile}'; wait` });
  async function grandchildPid(pidFile: string): Promise<number> {
    for (let i = 0; i < 100 && !existsSync(pidFile); i++) await delay(20);
    return Number(readFileSync(pidFile, "utf8").trim());
  }

  it("v04 AC-38: a timeout kills the whole process group, grandchildren included", async () => {
    const pidFile = join(dir, "grandchild.pid");
    const out = await callClaude(impl(), io([withGrandchild(pidFile)], { timeoutMs: 500 }));
    expect(out.kind).toBe("timeout");
    const pid = await grandchildPid(pidFile);
    expect(pid).toBeGreaterThan(0);
    expect(await gone(pid)).toBe(true);
  });

  it("v04 AC-51: an abort signal kills the whole process group and is an aborted outcome", async () => {
    const pidFile = join(dir, "grandchild.pid");
    const ctl = new AbortController();
    const pending = callClaude(impl(), io([withGrandchild(pidFile)], { timeoutMs: 20_000, signal: ctl.signal }));
    const pid = await grandchildPid(pidFile);
    expect(alive(pid)).toBe(true);
    const started = Date.now();
    ctl.abort();
    const out = await pending;
    expect(out.kind).toBe("aborted");
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(await gone(pid)).toBe(true);
    expect(existsSync(join(dir, "calls", "1-implement.json"))).toBe(true);
  });

  it("v04 AC-51: an already aborted signal does not leave a child running", async () => {
    const ctl = new AbortController();
    ctl.abort();
    const out = await callClaude(impl(), io([{ sleepMs: 20_000 }], { signal: ctl.signal }));
    expect(out.kind).toBe("aborted");
  });
});
