import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import {
  filePrompter,
  nonePrompter,
  selectPrompter,
  terminalPrompter,
} from "../../src/run/gate.js";
import { RunError } from "../../src/run/errors.js";

function tmpFile(content: string): string {
  const p = join(mkdtempSync(join(tmpdir(), "gate-")), "input.txt");
  writeFileSync(p, content);
  return p;
}

describe("gate prompters", () => {
  it("v04 AC-29: file prompter returns one line per ask, then null at EOF", async () => {
    const p = filePrompter(tmpFile("a\n\nc\n"));
    expect(await p.ask("q1")).toBe("a");
    expect(await p.ask("q2")).toBe("");
    expect(await p.ask("q3")).toBe("c");
    expect(await p.ask("q4")).toBeNull();
    expect(await p.ask("q5")).toBeNull();
  });

  it("v04 AC-29: file prompter on an unreadable file throws RunError(1)", () => {
    let thrown: unknown = null;
    try {
      filePrompter("/nonexistent/gate-input");
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(RunError);
    expect(thrown instanceof RunError ? thrown.exitCode : null).toBe(1);
  });

  it("v04 AC-29: close ends the terminal prompter and is a no-op for the others", async () => {
    const input = new PassThrough();
    const p = terminalPrompter(input, new PassThrough());
    const pending = p.ask("q ");
    p.close();
    expect(await pending).toBeNull();
    expect(await p.ask("again ")).toBeNull();
    p.close();
    filePrompter(tmpFile("a\n")).close();
    nonePrompter.close();
  });

  it("v04 AC-29: none prompter always returns null", async () => {
    expect(await nonePrompter.ask("q")).toBeNull();
  });

  it("v04 AC-29: selectPrompter picks file, terminal or none", async () => {
    const file = tmpFile("x\n");
    const withFile = selectPrompter({ AGENT_STACK_GATE_INPUT: file }, false);
    expect(await withFile.ask("q")).toBe("x");
    expect(selectPrompter({}, false)).toBe(nonePrompter);
    const term = selectPrompter({}, true, new PassThrough(), new PassThrough());
    expect(term).not.toBe(nonePrompter);
    term.close();
  });

  it("v04 AC-29: terminal prompter reads lines from the stream and returns null at close", async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const p = terminalPrompter(input, output);
    const first = p.ask("Size? ");
    input.write("story\n");
    expect(await first).toBe("story");
    const second = p.ask("Next? ");
    input.end("last\n");
    expect(await second).toBe("last");
    expect(await p.ask("Gone? ")).toBeNull();
    expect(output.read()?.toString()).toContain("Size? ");
  });
});
