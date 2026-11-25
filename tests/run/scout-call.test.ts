/**
 * scout1: the scout role in the call layer — its argv, its output schema, and the fake claude's rules for it.
 * Spec: docs/specs/scout1/SPEC.md (AC-2, AC-24).
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { buildArgs, type CallScope, type CallSpec } from "../../src/run/claude.js";
import { roleSchemas, validateOutput } from "../../src/run/schemas.js";

const FAKE = fileURLToPath(new URL("./fake-claude.mjs", import.meta.url));
const SCOPE: CallScope = { mcpConfig: '{"mcpServers":{}}', userClaudeMd: "/home/u/.claude/CLAUDE.md" };

const scout = (over: Partial<Extract<CallSpec, { role: "scout" }>> = {}): CallSpec => ({
  role: "scout",
  model: "haiku",
  effort: "low",
  maxTurns: 30,
  schema: { ...roleSchemas.scout },
  budgetUsd: null,
  ...over,
});

const valueAfter = (args: string[], name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

describe("buildArgs for the scout (scout1 AC-2)", () => {
  it("scout1 AC-2: the scout gets its model, --effort right after --model, read-only tools, default mode, no --allowedTools", () => {
    const args = buildArgs(scout(), SCOPE);
    const m = args.indexOf("--model");
    expect(args[m + 1]).toBe("haiku");
    expect(args[m + 2]).toBe("--effort");
    expect(args[m + 3]).toBe("low");
    expect(valueAfter(args, "--tools")).toBe("Read,Glob,Grep");
    expect(valueAfter(args, "--permission-mode")).toBe("default");
    expect(args).not.toContain("--allowedTools");
    expect(JSON.parse(valueAfter(args, "--json-schema") ?? "null")).toEqual(roleSchemas.scout);
  });

  it("scout1 AC-2: a scout spec without effort passes no --effort", () => {
    const { effort: _e, ...rest } = scout() as Extract<CallSpec, { role: "scout" }>;
    expect(buildArgs(rest, SCOPE)).not.toContain("--effort");
  });

  it("scout1 AC-2: implement still gets --effort right after --model", () => {
    const args = buildArgs(
      { role: "implement", commands: { test: "", lint: "", verify: "" }, model: "sonnet", effort: "high", maxTurns: 60, schema: {}, budgetUsd: null },
      SCOPE
    );
    const m = args.indexOf("--model");
    expect(args.slice(m, m + 4)).toEqual(["--model", "sonnet", "--effort", "high"]);
  });
});

describe("the scout's output schema (scout1 AC-2)", () => {
  const item = (o: Record<string, unknown> = {}): Record<string, unknown> => ({ path: "src/a.ts", why: "the entry", ...o });

  it("scout1 AC-2: the schema requires entries, items need string path and why, optional string lines, no maxItems", () => {
    const s = roleSchemas.scout;
    expect(s.type).toBe("object");
    expect(s.required).toEqual(["entries"]);
    const entries = s.properties["entries"] as { type: string; maxItems?: number; items: { type: string; required: string[]; properties: Record<string, unknown> } };
    expect(entries.type).toBe("array");
    expect(entries.maxItems).toBeUndefined();
    expect(entries.items.type).toBe("object");
    expect(entries.items.required).toEqual(["path", "why"]);
    expect(entries.items.properties).toEqual({ path: { type: "string" }, lines: { type: "string" }, why: { type: "string" } });
  });

  it("scout1 AC-2: valid outputs pass: empty, with and without lines", () => {
    expect(validateOutput("scout", { entries: [] })).toBeNull();
    expect(validateOutput("scout", { entries: [item(), item({ lines: "3-9" })] })).toBeNull();
  });

  it("scout1 AC-2: one bad item fails the whole output", () => {
    const bad: unknown[] = [
      { why: "no path" },
      { path: "a" },
      { path: 1, why: "w" },
      { path: "a", why: 2 },
      { path: "a", why: "w", lines: 5 },
      "src/a.ts",
      null,
    ];
    for (const b of bad) expect(validateOutput("scout", { entries: [item(), b, item()] }), JSON.stringify(b)).not.toBeNull();
    expect(validateOutput("scout", {})).not.toBeNull();
    expect(validateOutput("scout", { entries: "x" })).not.toBeNull();
  });

  it("scout1 AC-2: 31 and more items pass the schema", () => {
    expect(validateOutput("scout", { entries: Array.from({ length: 31 }, (_, i) => item({ path: `f${i}` })) })).toBeNull();
    expect(validateOutput("scout", { entries: Array.from({ length: 150 }, (_, i) => item({ path: `f${i}` })) })).toBeNull();
  });
});

describe("the fake claude's rules for the scout (scout1 AC-24)", () => {
  /** Runs the fake once with one scripted response; returns its exit code. */
  function fake(response: Record<string, unknown>, args: string[], prompt: string): number | null {
    const dir = mkdtempSync(join(tmpdir(), "fake-scout-"));
    try {
      const script = join(dir, "script.json");
      writeFileSync(script, JSON.stringify([response]));
      const env = { ...process.env, FAKE_CLAUDE_SCRIPT: script };
      delete env["FAKE_CLAUDE_LOG"];
      return spawnSync(process.execPath, [FAKE, ...args], { cwd: dir, env, input: prompt }).status;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  const SCOUT = "# Role: scout\n";
  const REVIEW = "# Role: review\n";
  const out = { entries: [] };

  it("scout1 AC-24: expectRole scout accepts any --model unless expectModel is set", () => {
    const r = { expectRole: "scout", output: out };
    expect(fake(r, ["--model", "haiku"], SCOUT)).toBe(0);
    expect(fake(r, ["--model", "sonnet"], SCOUT)).toBe(0);
    expect(fake(r, [], SCOUT)).toBe(9);
    const m = { expectRole: "scout", expectModel: "haiku", output: out };
    expect(fake(m, ["--model", "haiku"], SCOUT)).toBe(0);
    expect(fake(m, ["--model", "opus"], SCOUT)).toBe(9);
  });

  it("scout1 AC-24: expectRole scout accepts --effort, checked by expectEffort when set", () => {
    expect(fake({ expectRole: "scout", output: out }, ["--model", "haiku", "--effort", "low"], SCOUT)).toBe(0);
    const e = { expectRole: "scout", expectEffort: "low", output: out };
    expect(fake(e, ["--model", "haiku", "--effort", "low"], SCOUT)).toBe(0);
    expect(fake(e, ["--model", "haiku", "--effort", "high"], SCOUT)).toBe(9);
    expect(fake(e, ["--model", "haiku"], SCOUT)).toBe(9);
  });

  it("scout1 AC-24: a role other than implement or scout still exits 9 on --effort", () => {
    const r = { expectRole: "review", output: {} };
    expect(fake(r, ["--model", "opus"], REVIEW)).toBe(0);
    expect(fake(r, ["--model", "opus", "--effort", "low"], REVIEW)).toBe(9);
  });
});
