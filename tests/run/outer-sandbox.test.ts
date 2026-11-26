import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { buildArgs, callClaude, type CallIo, type CallScope, type CallSpec } from "../../src/run/claude.js";
import { detectOuterSandbox, insideOuterSandbox, NO_TOKEN_MESSAGE, outerSandboxEnv, readTokenFile, TOKEN_FILE } from "../../src/run/outer-sandbox.js";

const FAKE = fileURLToPath(new URL("./fake-claude.mjs", import.meta.url));
const SCHEMA = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] };
const SCOPE: CallScope = { mcpConfig: '{"mcpServers":{}}', userClaudeMd: "/home/u/.claude/CLAUDE.md" };
const REVIEW: CallSpec = { role: "review", model: "opus", maxTurns: 60, schema: SCHEMA, budgetUsd: null };

const REFUSED = { status: 71, stderr: "sandbox-exec: sandbox_apply: Operation not permitted\n" };
const APPLIED = { status: 0, stderr: "" };

const settingsOf = (args: string[]): Record<string, unknown> => JSON.parse(args[args.indexOf("--settings") + 1] ?? "{}") as Record<string, unknown>;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "as-outer-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const saveToken = (home: string, text: string): void => {
  const file = join(home, TOKEN_FILE);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text);
};

describe("defect 57: the driver inside an OS sandbox", () => {
  it("macOS refuses a sandbox inside a sandbox: the probe's refusal means an outer sandbox", () => {
    expect(detectOuterSandbox({}, "darwin", () => REFUSED)).toBe(true);
    expect(detectOuterSandbox({}, "darwin", () => APPLIED)).toBe(false);
  });

  it("a probe that fails for another reason is not an outer sandbox", () => {
    expect(detectOuterSandbox({}, "darwin", () => ({ status: null, stderr: "spawn sandbox-exec ENOENT" }))).toBe(false);
  });

  it("other platforms are not probed", () => {
    let asked = 0;
    const probe = (): typeof REFUSED => {
      asked += 1;
      return REFUSED;
    };
    expect(detectOuterSandbox({}, "linux", probe)).toBe(false);
    expect(asked).toBe(0);
  });

  it('AGENT_STACK_OUTER_SANDBOX=0 skips the probe; "1" does not turn the answer on', () => {
    expect(detectOuterSandbox({ AGENT_STACK_OUTER_SANDBOX: "0" }, "darwin", () => REFUSED)).toBe(false);
    expect(detectOuterSandbox({ AGENT_STACK_OUTER_SANDBOX: "1" }, "darwin", () => APPLIED)).toBe(false);
    expect(detectOuterSandbox({ AGENT_STACK_OUTER_SANDBOX: "1" }, "linux", () => REFUSED)).toBe(false);
  });

  it("AGENT_STACK_OUTER_SANDBOX=0 answers before any probe of this process (what the test config relies on)", () => {
    expect(insideOuterSandbox({ AGENT_STACK_OUTER_SANDBOX: "0" })).toBe(false);
  });

  it("the token file is read with whitespace removed; a missing or empty file gives null", () => {
    expect(readTokenFile(dir)).toBeNull();
    saveToken(dir, " \n");
    expect(readTokenFile(dir)).toBeNull();
    saveToken(dir, "sk-ant-oat-AAA\nBBB\n");
    expect(readTokenFile(dir)).toBe("sk-ant-oat-AAABBB");
  });

  it("a credential already in the env wins over the file; no credential at all gives null", () => {
    saveToken(dir, "from-file");
    expect(outerSandboxEnv({}, dir)).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "from-file" });
    expect(outerSandboxEnv({ CLAUDE_CODE_OAUTH_TOKEN: "from-env" }, dir)).toEqual({});
    expect(outerSandboxEnv({ ANTHROPIC_API_KEY: "key" }, dir)).toEqual({});
    expect(outerSandboxEnv({ ANTHROPIC_API_KEY: "" }, join(dir, "nobody"))).toBeNull();
  });

  it("buildArgs turns the call's own sandbox off only inside an outer sandbox", () => {
    expect(settingsOf(buildArgs(REVIEW, SCOPE))).toEqual({ claudeMdExcludes: [SCOPE.userClaudeMd] });
    expect(settingsOf(buildArgs(REVIEW, { ...SCOPE, outerSandbox: true }))).toEqual({
      claudeMdExcludes: [SCOPE.userClaudeMd],
      sandbox: { enabled: false },
    });
  });

  const io = (over: Partial<CallIo>): CallIo => {
    const script = join(dir, "s.json");
    writeFileSync(script, JSON.stringify([{ exec: 'printf %s "$CLAUDE_CODE_OAUTH_TOKEN" > token-seen', output: { ok: true } }]));
    chmodSync(FAKE, 0o755);
    return {
      cwd: dir,
      prompt: "# Role: review",
      runId: "r-20261126-000000",
      callsDir: join(dir, "calls"),
      callNo: 1,
      timeoutMs: 10_000,
      env: { AGENT_STACK_CLAUDE: FAKE, FAKE_CLAUDE_SCRIPT: script, CLAUDE_CODE_OAUTH_TOKEN: "", ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "" },
      ...over,
    };
  };

  it("callClaude inside an outer sandbox: the child gets the token and the sandbox-off setting", async () => {
    const home = join(dir, "home");
    saveToken(home, "tok-123\n");
    const out = await callClaude(REVIEW, io({ outerSandbox: true, home }));
    expect(out.kind).toBe("ok");
    expect(readFileSync(join(dir, "token-seen"), "utf8")).toBe("tok-123");
    const rec = JSON.parse(readFileSync(join(dir, "calls", "1-review.json"), "utf8")) as { argv: string[] };
    expect(settingsOf(rec.argv)["sandbox"]).toEqual({ enabled: false });
    expect(JSON.stringify(rec)).not.toContain("tok-123");
  });

  it("callClaude inside an outer sandbox with no token: an infra outcome that says what to do, no call", async () => {
    const out = await callClaude(REVIEW, io({ outerSandbox: true, home: join(dir, "nobody") }));
    expect(out).toEqual({ kind: "infra", message: NO_TOKEN_MESSAGE, costUsd: null });
    expect(NO_TOKEN_MESSAGE).toContain("claude setup-token");
  });

  it("callClaude outside a sandbox: no token from the file, the call's sandbox stays as the project sets it", async () => {
    const home = join(dir, "home");
    saveToken(home, "tok-123");
    const out = await callClaude(REVIEW, io({ outerSandbox: false, home }));
    expect(out.kind).toBe("ok");
    expect(readFileSync(join(dir, "token-seen"), "utf8")).toBe("");
    const rec = JSON.parse(readFileSync(join(dir, "calls", "1-review.json"), "utf8")) as { argv: string[] };
    expect(settingsOf(rec.argv)["sandbox"]).toBeUndefined();
  });
});
