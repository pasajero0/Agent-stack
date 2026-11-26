import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateCommand } from "../../src/commands/generate.js";
import { updateCommand } from "../../src/commands/update.js";
import { pinPlatform } from "./pin-platform.js";

pinPlatform(); // the warnings these tests compare must not depend on the machine (Linux without socat)

const SHIPPED = join(__dirname, "..", "..", "templates", "claude");
const DEFAULT_ROUTING = JSON.parse(readFileSync(join(SHIPPED, "_routing.json"), "utf-8"));
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

/** Replace routing in the generated gates.json, keeping every other key where it is. */
function withRouting(routing: unknown, indent = 2): string {
  const text = JSON.stringify({ ...JSON.parse(readGates()), routing }, null, indent) + "\n";
  writeFileSync(gatesPath(), text);
  return text;
}

beforeEach(async () => {
  project = mkdtempSync(join(tmpdir(), "scout-update-"));
  dirs.push(project);
  vi.spyOn(process, "cwd").mockReturnValue(project);
  capture();
  await generateCommand();
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("scout1 AC-9: update adds missing routing keys", () => {
  it("scout1 AC-9: generate writes the default routing with scout", () => {
    const routing = JSON.parse(readGates()).routing;
    expect(routing).toEqual(DEFAULT_ROUTING);
    expect(routing.scout).toBe("haiku·low");
  });

  it("scout1 AC-9: update adds scout and prints the Contract lines", async () => {
    const { scout: _s, ...rest } = DEFAULT_ROUTING;
    withRouting(rest);
    capture();
    await updateCommand();
    expect(JSON.parse(readGates()).routing).toEqual(DEFAULT_ROUTING);
    const lines = printed.join("\n").split("\n");
    const i = lines.findIndex((l) => l.includes("Harness updated:"));
    expect(i).toBeGreaterThanOrEqual(0);
    expect(lines[i + 1]).toContain("added routing.scout to .claude/gates.json");
    expect(printed.join("\n")).toContain(`${UNTOUCHED}, except the routing keys added to gates.json.`);
  });

  it("scout1 AC-9: update adds retry and scout together, in order", async () => {
    const { retry: _r, scout: _s, ...rest } = DEFAULT_ROUTING;
    withRouting(rest);
    capture();
    await updateCommand();
    const routing = JSON.parse(readGates()).routing;
    expect(routing).toEqual(DEFAULT_ROUTING);
    expect(Object.keys(routing)).toEqual(["S", "M", "L", "risky", "retry", "scout"]);
    expect(printed.join("\n")).toContain("added routing.retry, routing.scout to .claude/gates.json");
  });

  it("scout1 AC-9: --dry-run prints the ~ line and writes nothing", async () => {
    const { scout: _s, ...rest } = DEFAULT_ROUTING;
    const before = withRouting(rest);
    capture();
    await updateCommand({ dryRun: true });
    expect(printed.join("\n")).toContain("  ~ .claude/gates.json (routing.scout added)");
    expect(readGates()).toBe(before);
  });
});

describe("scout1 AC-16: update keeps gates.json", () => {
  it("scout1 AC-16: all six keys present: byte for byte", async () => {
    const text = JSON.stringify({ a: 1, routing: DEFAULT_ROUTING }, null, 4);
    writeFileSync(gatesPath(), text);
    capture();
    await updateCommand();
    expect(readGates()).toBe(text);
    expect(printed.join("\n")).not.toContain("added routing.");
  });

  it("scout1 AC-16: routing not an object: untouched", async () => {
    for (const value of [null, "x", [], 7]) {
      const text = JSON.stringify({ a: 1, routing: value }, null, 4);
      writeFileSync(gatesPath(), text);
      capture();
      await updateCommand();
      expect(readGates()).toBe(text);
    }
  });

  it("scout1 AC-16: key order kept and no cell added inside a tier", async () => {
    const routing = { retry: "x", S: { low: "a" }, extra: 1 };
    const before = JSON.parse(withRouting(routing));
    await updateCommand();
    const after = JSON.parse(readGates());
    expect(Object.keys(after)).toEqual(Object.keys(before));
    expect(Object.keys(after.routing)).toEqual(["retry", "S", "extra", "M", "L", "risky", "scout"]);
    expect(after.routing.S).toEqual({ low: "a" });
    expect(after.routing.retry).toBe("x");
    expect(after.routing.extra).toBe(1);
    expect(after.routing.M).toEqual(DEFAULT_ROUTING.M);
  });
});
