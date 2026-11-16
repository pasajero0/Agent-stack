import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectUsage, emptyReport, ingestLine, newState, type UsageReport } from "../../src/usage/collect.js";

const TS = "2026-11-05T10:00:00Z";

function run(lines: unknown[], agent = "main"): UsageReport {
  const r = emptyReport();
  const st = newState();
  for (const l of lines) ingestLine(r, typeof l === "string" ? l : JSON.stringify(l), agent, st);
  return r;
}

const assistant = (content: unknown[], extra: Record<string, unknown> = {}) => ({
  type: "assistant",
  timestamp: TS,
  message: { id: "m1", model: "claude-opus-5-5", content, ...extra },
});
const toolUse = (name: string, input: Record<string, unknown>) => ({ type: "tool_use", name, input });
const hookText =
  "PreToolUse:Write hook error: [$CLAUDE_PROJECT_DIR/.claude/hooks/spec-gate.sh]: Blocked by spec-gate (a.ts): ...";
const userResult = (content: unknown, isError?: boolean) => ({
  type: "user",
  message: {
    content: [{ type: "tool_result", content, ...(isError === undefined ? {} : { is_error: isError }) }],
  },
});

describe("ingestLine counter keys", () => {
  it("counts names that clash with Object.prototype", () => {
    const r = run([assistant([toolUse("Agent", { subagent_type: "constructor" }), toolUse("Skill", { skill: "toString" })])]);
    expect(r.agents.constructor).toBe(1);
    expect(r.skills.toString).toBe(1);
    expect(JSON.parse(JSON.stringify(r.agents))).toEqual({ constructor: 1 });
  });

  it("counts every hook error in one tool result", () => {
    const r = run([userResult(`${hookText}\n${hookText.replace("spec-gate.sh", "cheat-guard.sh")}`, true)]);
    expect(r.hookBlocks["spec-gate"]).toBe(1);
    expect(r.hookBlocks["cheat-guard"]).toBe(1);
  });

  it("reads hook blocks and Stop-hook runs from quoted commands too", () => {
    const quoted = hookText.replace("[$CLAUDE_PROJECT_DIR/", '["$CLAUDE_PROJECT_DIR"/');
    const r = run([
      userResult(quoted, true),
      { type: "system", subtype: "stop_hook_summary", hookInfos: [{ command: '"$CLAUDE_PROJECT_DIR"/.claude/hooks/evidence-gate.sh' }] },
    ]);
    expect(r.hookBlocks["spec-gate"]).toBe(1);
    expect(r.stopRuns["evidence-gate"]).toBe(1);
  });

  it("ignores a hook error quoted inside another failing command's output", () => {
    const r = run([userResult(`grep: exit 1\nlog.jsonl:12: ${hookText}`, true)]);
    expect(r.hookBlocks).toEqual({});
  });
});

describe("ingestLine tokens", () => {
  const usage = { input_tokens: 1, cache_creation_input_tokens: 10, cache_read_input_tokens: 100, output_tokens: 5 };

  it("counts a message id once", () => {
    const line = assistant([], { usage });
    const r = run([line, line]);
    expect(r.tokens).toEqual([
      { agent: "main", model: "claude-opus-5-5", input: 1, cacheWrite: 10, cacheRead: 100, output: 5 },
    ]);
  });

  it("groups rows by agent and model", () => {
    const r = emptyReport();
    const st = newState();
    const l = (id: string, model: string) =>
      JSON.stringify({ type: "assistant", timestamp: TS, message: { id, model, usage, content: [] } });
    ingestLine(r, l("a", "m1"), "main", st);
    ingestLine(r, l("b", "m1"), "main", st);
    ingestLine(r, l("c", "m2"), "main", st);
    ingestLine(r, l("d", "m1"), "implementer", st);
    expect(r.tokens).toHaveLength(3);
    const main = r.tokens.find((t) => t.agent === "main" && t.model === "m1");
    expect(main?.output).toBe(10);
  });
});

describe("ingestLine tool use", () => {
  it("counts tools, agents with and without subagent_type", () => {
    const r = run([
      assistant([toolUse("Agent", { subagent_type: "implementer" }), toolUse("Agent", {})]),
    ]);
    expect(r.agents).toEqual({ implementer: 1, "general-purpose": 1 });
    expect(r.tools).toEqual({ Agent: 2 });
  });

  it("counts Skill calls and SKILL.md reads, but not other skill files", () => {
    const r = run([
      assistant([
        toolUse("Skill", { skill: "spec" }),
        toolUse("Read", { file_path: "/p/.claude/skills/adr/SKILL.md" }),
        toolUse("Read", { file_path: ".claude/skills/adr/template.md" }),
      ]),
    ]);
    expect(r.skills).toEqual({ spec: 1, adr: 1 });
  });

  it("counts .claude/bin tools run through Bash", () => {
    const r = run([assistant([toolUse("Bash", { command: ".claude/bin/trace A0 && .claude/bin/verify" })])]);
    expect(r.bin).toEqual({ trace: 1, verify: 1 });
  });
});

describe("ingestLine hook blocks", () => {
  it("counts an error tool_result from a hook", () => {
    expect(run([userResult(hookText, true)]).hookBlocks).toEqual({ "spec-gate": 1 });
  });

  it("accepts array-of-text content", () => {
    expect(run([userResult([{ type: "text", text: hookText }], true)]).hookBlocks).toEqual({ "spec-gate": 1 });
  });

  it("ignores the same text when is_error is false or absent", () => {
    expect(run([userResult(hookText, false), userResult(hookText)]).hookBlocks).toEqual({});
  });
});

describe("ingestLine hook context", () => {
  const att = (attachment: Record<string, unknown>) => ({ type: "attachment", attachment });

  it("counts hook_additional_context by hook name", () => {
    const r = run([att({ type: "hook_additional_context", hookName: "PostToolUse:Edit", content: ["lint: 1 error"] })]);
    expect(r.hookContext).toEqual({ "PostToolUse:Edit": 1 });
  });

  it("ignores IDE diagnostics", () => {
    const r = run([
      att({ type: "hook_additional_context", hookName: "PostToolUse:Edit", content: ["<ide_diagnostics>x</ide_diagnostics>"] }),
    ]);
    expect(r.hookContext).toEqual({});
  });

  it("counts SessionStart hook_success only", () => {
    const r = run([
      att({ type: "hook_success", hookName: "SessionStart:startup", hookEvent: "SessionStart" }),
      att({ type: "hook_success", hookName: "PostToolUse:Edit", hookEvent: "PostToolUse" }),
    ]);
    expect(r.hookContext).toEqual({ "SessionStart:startup": 1 });
  });
});

describe("ingestLine stop hooks", () => {
  const stop = (hasOutput: boolean) => ({
    type: "system",
    subtype: "stop_hook_summary",
    hookInfos: [
      { command: "$CLAUDE_PROJECT_DIR/.claude/hooks/evidence-gate.sh" },
      { command: '"/x/gk" ai hook run' },
    ],
    hookErrors: [],
    preventedContinuation: false,
    hasOutput,
  });

  it("counts runs of project hooks only and no action without output", () => {
    const r = run([stop(false)]);
    expect(r.stopRuns).toEqual({ "evidence-gate": 1 });
    expect(r.stopsActed).toBe(0);
  });

  it("counts a stop with output as acted", () => {
    expect(run([stop(true)]).stopsActed).toBe(1);
  });
});

describe("ingestLine slash commands", () => {
  const cmd = { type: "user", message: { content: "<command-name>/review</command-name>" } };

  it("counts commands typed in the main conversation", () => {
    expect(run([cmd]).commands).toEqual({ review: 1 });
  });

  it("ignores commands inside a subagent", () => {
    expect(run([cmd], "implementer").commands).toEqual({});
  });
});

describe("ingestLine robustness", () => {
  it("ignores malformed and non-object lines", () => {
    const r = emptyReport();
    const st = newState();
    for (const l of ["", "{oops", "null", "42", '"str"', "[1,2]"]) {
      expect(() => ingestLine(r, l, "main", st)).not.toThrow();
    }
    expect(r).toEqual(emptyReport());
  });
});

describe("collectUsage", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-stack-collect-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const write = (name: string, lines: unknown[]) => {
    const p = join(dir, name);
    writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    return p;
  };
  const msg = (id: string, ts: string, out: number, model = "m") => ({
    type: "assistant",
    timestamp: ts,
    message: { id, model, usage: { output_tokens: out }, content: [] },
  });

  it("counts sessions and subagent runs with first/last timestamps", async () => {
    const main = write("a.jsonl", [msg("1", "2026-11-01T00:00:00Z", 1), msg("2", "2026-11-03T00:00:00Z", 1)]);
    const sub = write("b.jsonl", [msg("3", "2026-11-02T00:00:00Z", 1)]);
    const r = await collectUsage([
      { path: main, agent: "main" },
      { path: sub, agent: "implementer" },
    ]);
    expect(r.mainSessions).toBe(1);
    expect(r.subagentRuns).toBe(1);
    expect(r.first).toBe("2026-11-01T00:00:00Z");
    expect(r.last).toBe("2026-11-03T00:00:00Z");
  });

  it("drops lines older than sinceMs and skips files with only old lines", async () => {
    const mixed = write("a.jsonl", [msg("1", "2026-10-01T00:00:00Z", 100), msg("2", "2026-11-05T00:00:00Z", 7)]);
    const old = write("b.jsonl", [msg("3", "2026-10-02T00:00:00Z", 100)]);
    const r = await collectUsage(
      [
        { path: mixed, agent: "main" },
        { path: old, agent: "main" },
      ],
      Date.parse("2026-11-01T00:00:00Z"),
    );
    expect(r.mainSessions).toBe(1);
    expect(r.tokens).toHaveLength(1);
    expect(r.tokens[0]?.output).toBe(7);
    expect(r.first).toBe("2026-11-05T00:00:00Z");
  });

  it("counts a subagent run whose lines fall inside its parent session's span", async () => {
    const main = write("a.jsonl", [msg("1", "2026-11-01T00:00:00Z", 1), msg("2", "2026-11-03T00:00:00Z", 1)]);
    const sub = write("b.jsonl", [{ type: "user", timestamp: "2026-11-02T00:00:00Z", message: { content: "go" } }]);
    const r = await collectUsage([
      { path: main, agent: "main" },
      { path: sub, agent: "implementer" },
    ]);
    expect(r.subagentRuns).toBe(1);
  });

  it("counts lines copied into a resumed session once, by uuid", async () => {
    const copied = { uuid: "u1", ...assistant([toolUse("Agent", { subagent_type: "implementer" })]) };
    const a = write("a.jsonl", [copied]);
    const b = write("b.jsonl", [copied, { uuid: "u2", ...assistant([toolUse("Agent", { subagent_type: "implementer" })], { id: "m2" }) }]);
    const r = await collectUsage([
      { path: a, agent: "main" },
      { path: b, agent: "main" },
    ]);
    expect(r.agents.implementer).toBe(2);
    expect(r.mainSessions).toBe(2);
  });

  it("drops lines without a timestamp when a window is set", async () => {
    const f = write("a.jsonl", [{ type: "user", message: { content: "<command-name>/review</command-name>" } }]);
    const r = await collectUsage([{ path: f, agent: "main" }], Date.parse("2026-11-01T00:00:00Z"));
    expect(r.commands.review).toBeUndefined();
    expect(r.mainSessions).toBe(0);
  });

  it("skips an unreadable file instead of failing the report", async () => {
    const ok = write("a.jsonl", [msg("1", TS, 1)]);
    const r = await collectUsage([
      { path: join(dir, "gone.jsonl"), agent: "main" },
      { path: ok, agent: "main" },
    ]);
    expect(r.skippedFiles).toBe(1);
    expect(r.mainSessions).toBe(1);
  });

  it("drops all-zero token rows and sorts by cacheWrite+output descending", async () => {
    const f = write("a.jsonl", [
      msg("1", TS, 5, "small"),
      msg("2", TS, 50, "big"),
      msg("3", TS, 0, "zero"),
    ]);
    const r = await collectUsage([{ path: f, agent: "main" }]);
    expect(r.tokens.map((t) => t.model)).toEqual(["big", "small"]);
  });
});
