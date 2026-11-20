import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanupProjects } from "../hooks/fixture.js";
import { parseResult } from "../../src/run/claude.js";
import { startRun } from "../../src/run/engine/index.js";
import { lineSplitter, toolLine, toolLines } from "../../src/run/engine/progress.js";
import { runDir } from "../../src/run/store.js";
import { impl, makeFakeExecutable, repo, text } from "./engine-fixture.js";

beforeAll(makeFakeExecutable);
afterEach(() => cleanupProjects());

describe("tool lines (AC-78)", () => {
  it("v04 AC-78: a tool line names the file, the command or the pattern, on one line, cut to 80", () => {
    expect(toolLine("Read", { file_path: "src/a.ts" })).toBe("   · Read src/a.ts");
    expect(toolLine("Bash", { command: "pnpm test\n  --run" })).toBe("   · Bash pnpm test --run");
    expect(toolLine("Grep", { pattern: "TODO" })).toBe("   · Grep TODO");
    expect(toolLine("TodoWrite", { todos: [] })).toBe("   · TodoWrite");
    const long = toolLine("Bash", { command: "x".repeat(200) });
    expect(long).toBe(`   · Bash ${"x".repeat(79)}…`);
  });

  it("v04 AC-78: only assistant tool_use events give lines; other events give none", () => {
    const event = { type: "assistant", message: { content: [{ type: "text", text: "hi" }, { type: "tool_use", name: "Edit", input: { file_path: "a.ts" } }] } };
    expect(toolLines(event)).toEqual(["   · Edit a.ts"]);
    expect(toolLines({ type: "user", message: { content: [] } })).toEqual([]);
    expect(toolLines("not an object")).toEqual([]);
  });

  it("v04 AC-78: the result is the last result event; a line that is not JSON is skipped; none gives null", () => {
    const stream = ['{"type":"system"}', "garbage", '{"type":"result","subtype":"success","num_turns":2}', ""].join("\n");
    expect(parseResult(stream)?.["num_turns"]).toBe(2);
    expect(parseResult('{"type":"assistant"}\nnot json\n')).toBeNull();
  });

  it("v04 AC-78: the splitter gives whole lines only, across chunks", () => {
    const s = lineSplitter();
    expect(s.push('{"a":')).toEqual([]);
    expect(s.push('1}\n{"b"')).toEqual(['{"a":1}']);
    expect(s.push(":2}\n")).toEqual(['{"b":2}']);
    expect(s.rest()).toBe("");
  });
});

describe("a run can be seen (AC-78, AC-79)", () => {
  it("v04 AC-78, v04 AC-79: the tools print under the step, now.json holds the step, progress.log the lines", async () => {
    const r = repo();
    r.script([{ ...impl({ writes: { "README.md": "# demo\nfixed\n" } }), tools: [{ name: "Read", input: { file_path: "README.md" } }, { name: "Edit", input: { file_path: "README.md" } }] }]);
    expect(await startRun({ ...r.opts({ gate: ["a"] }), mode: "quick", description: "Fix the README line." })).toBe(0);
    const t = text(r);
    expect(t).toMatch(/-> implement:Q1 · implement · sonnet · call 1\/40 \.\.\.\n {3}· Read README\.md\n {3}· Edit README\.md\n {3}ok in /);
    const dir = runDir(r.dir, r.run().id);
    const now = JSON.parse(readFileSync(join(dir, "now.json"), "utf8")) as { step: string; since: string; last: string };
    expect(now.step).toBe("gate:accept");
    expect(Number.isNaN(Date.parse(now.since))).toBe(false);
    const log = readFileSync(join(dir, "progress.log"), "utf8");
    expect(log).toMatch(/\timplement:Q1\t· Read README\.md\n/);
    expect(log).toMatch(/\tgate:accept\tstep gate:accept\n/);
    expect(existsSync(join(dir, "now.json.tmp"))).toBe(false);
  });
});
