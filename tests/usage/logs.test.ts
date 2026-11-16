import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, mkdtempSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { projectLogDir, listLogFiles } from "../../src/usage/logs.js";

describe("projectLogDir", () => {
  it("replaces every non-alphanumeric character with a dash", () => {
    expect(projectLogDir("/Users/a/my.proj/x_y", "/h")).toBe("/h/.claude/projects/-Users-a-my-proj-x-y");
  });
});

describe("listLogFiles", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "agent-stack-logs-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const byPath = (files: { path: string; agent: string }[]) =>
    Object.fromEntries(files.map((f) => [f.path.slice(dir.length + 1), f.agent]));

  it("returns [] for a missing directory", () => {
    expect(listLogFiles(join(dir, "nope"))).toEqual([]);
  });

  it("labels main files, subagent files by meta, and ignores non-jsonl", () => {
    writeFileSync(join(dir, "s1.jsonl"), "");
    writeFileSync(join(dir, "notes.txt"), "");
    const sub = join(dir, "s1", "subagents");
    mkdirSync(sub, { recursive: true });
    writeFileSync(join(sub, "agent-1.jsonl"), "");
    writeFileSync(join(sub, "agent-1.meta.json"), JSON.stringify({ agentType: "test-writer" }));
    writeFileSync(join(sub, "agent-2.jsonl"), "");
    writeFileSync(join(sub, "agent-3.jsonl"), "");
    writeFileSync(join(sub, "agent-3.meta.json"), "{not json");
    writeFileSync(join(sub, "agent-4.jsonl"), "");
    writeFileSync(join(sub, "agent-4.meta.json"), JSON.stringify({ agentType: "" }));

    expect(byPath(listLogFiles(dir))).toEqual({
      "s1.jsonl": "main",
      "s1/subagents/agent-1.jsonl": "test-writer",
      "s1/subagents/agent-2.jsonl": "subagent",
      "s1/subagents/agent-3.jsonl": "subagent",
      "s1/subagents/agent-4.jsonl": "subagent",
    });
  });

  it("ignores .jsonl files outside the top level and <session>/subagents/", () => {
    writeFileSync(join(dir, "s1.jsonl"), "");
    mkdirSync(join(dir, "s1", "tool-results"), { recursive: true });
    writeFileSync(join(dir, "s1", "tool-results", "x.jsonl"), "");
    writeFileSync(join(dir, "s1", "stray.jsonl"), "");
    expect(byPath(listLogFiles(dir))).toEqual({ "s1.jsonl": "main" });
  });

  it("does not follow a symlink loop", () => {
    mkdirSync(join(dir, "s1"));
    symlinkSync(dir, join(dir, "s1", "subagents"));
    writeFileSync(join(dir, "s1.jsonl"), "");
    expect(byPath(listLogFiles(dir))).toEqual({ "s1.jsonl": "main" });
  });
});
