import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateCommand } from "../../src/commands/generate.js";
import { updateCommand } from "../../src/commands/update.js";

const SHIPPED = join(__dirname, "..", "..", "templates", "claude");
const DEFAULT_ROUTING = JSON.parse(readFileSync(join(SHIPPED, "_routing.json"), "utf-8"));
const MSG = "templates/claude/_routing.json is not a valid routing; reinstall agent-stack.";
const UNTOUCHED = "  .claude/rules/, .claude/tmp/ and your seed files (CLAUDE.md, gates.json…) were left untouched";

const dirs: string[] = [];
let project: string;
let printed: string[];

const gatesPath = (): string => join(project, ".claude", "gates.json");
const readGates = (): string => readFileSync(gatesPath(), "utf-8");

function capture(): void {
  printed = [];
  const grab = (...a: unknown[]): void => {
    printed.push(a.join(" "));
  };
  vi.spyOn(console, "log").mockImplementation(grab);
  vi.spyOn(console, "error").mockImplementation(grab);
  vi.spyOn(console, "warn").mockImplementation(grab);
}

beforeEach(async () => {
  project = mkdtempSync(join(tmpdir(), "routing-update-"));
  dirs.push(project);
  vi.spyOn(process, "cwd").mockReturnValue(project);
  capture();
  await generateCommand();
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** Rewrite the generated gates.json without `routing`, with an extra key in the middle. */
function oldGates(): string {
  const { routing: _routing, ...rest } = JSON.parse(readGates());
  const keys = Object.keys(rest);
  const reordered: Record<string, unknown> = {};
  for (const k of keys.slice(0, 1)) reordered[k] = rest[k];
  reordered.myKey = { keep: [1, 2] };
  for (const k of keys.slice(1)) reordered[k] = rest[k];
  const text = JSON.stringify(reordered, null, 2) + "\n";
  writeFileSync(gatesPath(), text);
  return text;
}

describe("update adds routing", () => {
  it("effort1 AC-9: adds the default routing as the last key and prints the Contract lines", async () => {
    const before = oldGates();
    capture();
    await updateCommand();
    const after = JSON.parse(readGates());
    expect(Object.keys(after).at(-1)).toBe("routing");
    expect(after.routing).toEqual(DEFAULT_ROUTING);
    expect(readGates()).toBe(JSON.stringify(after, null, 2) + "\n");
    const lines = printed.join("\n").split("\n");
    const i = lines.findIndex((l) => l.includes("Harness updated:"));
    expect(i).toBeGreaterThanOrEqual(0);
    expect(lines[i + 1]).toContain("added the routing block to .claude/gates.json");
    expect(printed.join("\n")).toContain(`${UNTOUCHED}, except the routing block added to gates.json.`);
    expect(readGates()).not.toBe(before);
  });

  it("effort1 AC-9: --dry-run prints the ~ line and writes nothing", async () => {
    const before = oldGates();
    capture();
    await updateCommand({ dryRun: true });
    const out = printed.join("\n");
    expect(out).toContain("  ~ .claude/gates.json (routing block added)");
    expect(out).not.toContain("= .claude/gates.json (yours — kept)");
    expect(readGates()).toBe(before);
  });

  it("effort1 AC-9: --force changes nothing more", async () => {
    oldGates();
    capture();
    await updateCommand({ force: true });
    const after = JSON.parse(readGates());
    expect(after.routing).toEqual(DEFAULT_ROUTING);
    expect(after.myKey).toEqual({ keep: [1, 2] });
  });
});

describe("update keeps gates.json", () => {
  it("effort1 AC-16: every other key keeps its value and its order", async () => {
    const before = JSON.parse(oldGates());
    await updateCommand();
    const after = JSON.parse(readGates());
    expect(Object.keys(after)).toEqual([...Object.keys(before), "routing"]);
    for (const k of Object.keys(before)) expect(after[k]).toEqual(before[k]);
  });

  it("effort1 AC-16: a file with a routing key that is not an object stays byte for byte", async () => {
    for (const value of [null, "x", []]) {
      const text = JSON.stringify({ a: 1, routing: value }, null, 4);
      writeFileSync(gatesPath(), text);
      capture();
      await updateCommand();
      expect(readGates()).toBe(text);
      expect(printed.join("\n")).not.toContain("added the routing block");
      expect(printed.join("\n")).toContain(`${UNTOUCHED}.`);
    }
  });

  it("effort1 AC-16: not valid JSON or not an object: warning, nothing written, exit 0", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    const cases: [string, string][] = [
      ["{not json", ".claude/gates.json is not valid JSON, so routing was not added. Fix it, then run update again."],
      ["[1, 2]", ".claude/gates.json is not a JSON object, so routing was not added. Fix it, then run update again."],
      ["42", ".claude/gates.json is not a JSON object, so routing was not added. Fix it, then run update again."],
      ["null", ".claude/gates.json is not a JSON object, so routing was not added. Fix it, then run update again."],
    ];
    for (const [text, warning] of cases) {
      writeFileSync(gatesPath(), text);
      capture();
      await updateCommand();
      expect(readGates()).toBe(text);
      expect(printed.join("\n")).toContain(warning);
      expect(printed.join("\n")).not.toContain("added the routing block");
    }
    expect(exit).not.toHaveBeenCalled();
  });
});

describe("update with a broken _routing.json", () => {
  it("effort1 AC-19: update exits 1 with the message and writes nothing", async () => {
    const text = oldGates();
    const bad = mkdtempSync(join(tmpdir(), "routing-update-tpl-"));
    dirs.push(bad);
    cpSync(SHIPPED, bad, { recursive: true });
    writeFileSync(join(bad, "_routing.json"), '{"S": 1');
    const filesBefore = readdirSync(join(project, ".claude")).sort();
    capture();
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      throw new Error("exit");
    }) as never);
    await expect(updateCommand({ templatesDir: bad })).rejects.toThrow("exit");
    expect(exit).toHaveBeenCalledWith(1);
    expect(printed.join("\n")).toContain(MSG);
    expect(readGates()).toBe(text);
    expect(readdirSync(join(project, ".claude")).sort()).toEqual(filesBefore);
  });
});
