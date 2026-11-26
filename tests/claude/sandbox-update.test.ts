import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateCommand } from "../../src/commands/generate.js";
import { updateCommand } from "../../src/commands/update.js";
import { buildSandboxBlock } from "../../src/claude/sandbox.js";
import { pinPlatform } from "./pin-platform.js";

pinPlatform(); // the warnings these tests compare must not depend on the machine (Linux without socat)

// The Contract's `update` lines (docs/specs/sandbox1/SPEC.md).
const ADD = "  add sandbox.allowedDomains to .claude/gates.json to change the list";
const BAD =
  ".claude/gates.json sandbox.allowedDomains must be a list of domain names, so the detected list was used. " +
  "Fix it, then run update again.";
const UNREADABLE = ".claude/settings.json is not valid JSON, so it was left as is.";

const dirs: string[] = [];
let project: string;
let printed: string[];
/** The detected domain list, as `generate` seeded it into gates.json. */
let detected: string[];

const path = (rel: string): string => join(project, ".claude", rel);
const read = (rel: string): string => readFileSync(path(rel), "utf-8");
const readJson = (rel: string): Record<string, unknown> => JSON.parse(read(rel)) as Record<string, unknown>;
const write = (rel: string, value: unknown): string => {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 4) + "\n";
  writeFileSync(path(rel), text);
  return text;
};

function capture(): void {
  printed = [];
  const grab = (...a: unknown[]): void => {
    printed.push(a.join(" "));
  };
  vi.spyOn(console, "log").mockImplementation(grab);
  vi.spyOn(console, "error").mockImplementation(grab);
  vi.spyOn(console, "warn").mockImplementation(grab);
}

const count = (needle: string): number => printed.filter((l) => l.includes(needle)).length;

const settingsDomains = (): unknown =>
  (readJson("settings.json").sandbox as { network: { allowedDomains: unknown } }).network.allowedDomains;
const manifestSandbox = (): unknown => readJson(".harness.json").generatedSandbox;

/** gates.json as generated, with its `sandbox` key replaced (or removed with `undefined`). */
function gatesWith(sandbox: unknown): Record<string, unknown> {
  const gates = readJson("gates.json");
  if (sandbox === undefined) delete gates.sandbox;
  else gates.sandbox = sandbox;
  return gates;
}

/** settings.json as generated, without `sandbox`, with a user key at the end. */
function settingsWithoutSandbox(): void {
  const { sandbox: _drop, ...rest } = readJson("settings.json");
  write("settings.json", { ...rest, env: { FOO: "1" } });
}

beforeEach(async () => {
  project = mkdtempSync(join(tmpdir(), "sandbox-update-"));
  dirs.push(project);
  vi.spyOn(process, "cwd").mockReturnValue(project);
  capture();
  await generateCommand();
  detected = (readJson("gates.json").sandbox as { allowedDomains: string[] }).allowedDomains;
  capture();
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("sandbox1: the domain source on update", () => {
  it("sandbox1 AC-4: a valid settings.json without sandbox gets the block with the gates.json list, deduplicated", async () => {
    settingsWithoutSandbox();
    write("gates.json", gatesWith({ allowedDomains: ["a.com", "b.com", "a.com"] }));
    await updateCommand();
    const settings = readJson("settings.json");
    expect(Object.keys(settings)).toEqual(["$schema", "permissions", "sandbox", "hooks", "env"]);
    expect(settings.sandbox).toEqual(buildSandboxBlock(["a.com", "b.com"]));
    expect(settings.env).toEqual({ FOO: "1" });
    expect(manifestSandbox()).toEqual({ denyRead: buildSandboxBlock([]).filesystem.denyRead, allowedDomains: ["a.com", "b.com"] });
    expect(count(ADD.trim())).toBe(0);
    expect(count(BAD)).toBe(0);
  });

  it("sandbox1 AC-4: the Contract example [a.com, a.com] → [a.com] in settings.json and the manifest", async () => {
    settingsWithoutSandbox();
    write("gates.json", gatesWith({ allowedDomains: ["a.com", "a.com"] }));
    await updateCommand();
    expect(settingsDomains()).toEqual(["a.com"]);
    expect((manifestSandbox() as { allowedDomains: unknown }).allowedDomains).toEqual(["a.com"]);
  });

  it("sandbox1 AC-4: an empty list stays empty and prints no add line", async () => {
    settingsWithoutSandbox();
    write("gates.json", gatesWith({ allowedDomains: [] }));
    await updateCommand();
    expect(settingsDomains()).toEqual([]);
    expect((manifestSandbox() as { allowedDomains: unknown }).allowedDomains).toEqual([]);
    expect(count(ADD.trim())).toBe(0);
  });

  it("sandbox1 AC-4: --dry-run prints the same and writes nothing", async () => {
    settingsWithoutSandbox();
    const settings = read("settings.json");
    write("gates.json", gatesWith({ allowedDomains: ["a.com"] }));
    await updateCommand({ dryRun: true });
    expect(read("settings.json")).toBe(settings);
    expect(count(ADD.trim())).toBe(0);
  });

  it("sandbox1 AC-5: gates.json without sandbox → the detected list, one add line, gates.json byte for byte", async () => {
    settingsWithoutSandbox();
    write("gates.json", gatesWith({ allowedDomains: ["x.com"] }));
    await updateCommand(); // the block is now there, with x.com
    expect(settingsDomains()).toEqual(["x.com"]);
    for (const sandbox of [undefined, {}, { other: 1 }]) {
      const text = write("gates.json", gatesWith(sandbox));
      capture();
      await updateCommand();
      expect(settingsDomains()).toEqual(detected);
      expect((manifestSandbox() as { allowedDomains: unknown }).allowedDomains).toEqual(detected);
      expect(count(ADD.trim())).toBe(1);
      expect(printed.find((l) => l.includes(ADD.trim()))).toContain(ADD);
      expect(count(BAD)).toBe(0);
      expect(read("gates.json")).toBe(text);
    }
  });

  it("sandbox1 AC-5: the add line comes after today's reportExtras lines, also on --dry-run", async () => {
    write("gates.json", gatesWith(undefined));
    await updateCommand({ dryRun: true });
    const add = printed.findIndex((l) => l.includes(ADD.trim()));
    const unchanged = printed.findIndex((l) => l.includes(" unchanged. rules/ and tmp/"));
    expect(add).toBeGreaterThanOrEqual(0);
    expect(add).toBeLessThan(unchanged);
  });

  it("sandbox1 AC-11: a wrong-typed sandbox or allowedDomains → the detected list, the bad list warning, no add line", async () => {
    const cases: unknown[] = [
      null,
      "x",
      [],
      42,
      { allowedDomains: "a.com" },
      { allowedDomains: null },
      { allowedDomains: { a: 1 } },
      { allowedDomains: ["a.com", 1] },
      { allowedDomains: ["a.com", null] },
    ];
    for (const sandbox of cases) {
      write("gates.json", gatesWith({ allowedDomains: ["x.com"] }));
      capture();
      await updateCommand();
      expect(settingsDomains()).toEqual(["x.com"]);
      const text = write("gates.json", gatesWith(sandbox));
      capture();
      await updateCommand();
      expect(settingsDomains()).toEqual(detected);
      expect((manifestSandbox() as { allowedDomains: unknown }).allowedDomains).toEqual(detected);
      expect(count(BAD)).toBe(1);
      expect(count(ADD.trim())).toBe(0);
      expect(read("gates.json")).toBe(text);
    }
  });

  it("sandbox1 AC-12: gates.json not valid JSON or not an object → the detected list, no sandbox line about gates.json", async () => {
    const cases: [string, string][] = [
      ["{not json", ".claude/gates.json is not valid JSON, so routing was not added."],
      ["[1, 2]", ".claude/gates.json is not a JSON object, so routing was not added."],
      ['"x"', ".claude/gates.json is not a JSON object, so routing was not added."],
      ["null", ".claude/gates.json is not a JSON object, so routing was not added."],
    ];
    const valid = gatesWith({ allowedDomains: ["x.com"] });
    for (const [text, routingWarning] of cases) {
      write("gates.json", valid);
      capture();
      await updateCommand();
      expect(settingsDomains()).toEqual(["x.com"]);
      write("gates.json", text);
      capture();
      await updateCommand();
      expect(settingsDomains()).toEqual(detected);
      expect(count(routingWarning)).toBe(1);
      expect(count(ADD.trim())).toBe(0);
      expect(count(BAD)).toBe(0);
      expect(printed.filter((l) => l.includes("sandbox"))).toEqual([]);
      expect(read("gates.json")).toBe(text);
    }
  });

  it("sandbox1 AC-12: a missing gates.json is created with sandbox, and its list is used", async () => {
    write("gates.json", gatesWith({ allowedDomains: ["x.com"] }));
    await updateCommand();
    unlinkSync(path("gates.json"));
    capture();
    await updateCommand();
    expect(existsSync(path("gates.json"))).toBe(true);
    const gates = readJson("gates.json");
    expect(gates.sandbox).toEqual({ allowedDomains: detected });
    expect(Object.keys(gates).slice(-2)).toEqual(["sandbox", "routing"]);
    expect(settingsDomains()).toEqual(detected);
    expect(count(ADD.trim())).toBe(0);
    expect(count(BAD)).toBe(0);
  });

  it("sandbox1 AC-24: a missing settings.json is created with the gates.json list", async () => {
    write("gates.json", gatesWith({ allowedDomains: ["example.com"] }));
    unlinkSync(path("settings.json"));
    await updateCommand();
    const settings = readJson("settings.json");
    expect(Object.keys(settings)).toEqual(["$schema", "permissions", "sandbox", "hooks"]);
    expect(settings.sandbox).toEqual(buildSandboxBlock(["example.com"]));
    expect((manifestSandbox() as { allowedDomains: unknown }).allowedDomains).toEqual(["example.com"]);
  });

  it("sandbox1 AC-24: a missing settings.json and no sandbox in gates.json → the detected list and the add line", async () => {
    write("gates.json", gatesWith(undefined));
    unlinkSync(path("settings.json"));
    await updateCommand();
    expect(settingsDomains()).toEqual(detected);
    expect(count(ADD.trim())).toBe(1);
  });
});

describe("sandbox1: an invalid settings.json", () => {
  it("sandbox1 AC-10: settings.json stays, today's warning, no add or bad list line, old generatedSandbox kept as read", async () => {
    const broken = write("settings.json", "{not json");
    const old = { denyRead: ["~/.ssh", 3, "~/.x"], allowedDomains: "nope" };
    write(".harness.json", { ...readJson(".harness.json"), generatedSandbox: old });
    for (const sandbox of [undefined, null, { allowedDomains: ["a.com", "a.com"] }]) {
      write("gates.json", gatesWith(sandbox));
      capture();
      await updateCommand();
      expect(read("settings.json")).toBe(broken);
      expect(count(UNREADABLE)).toBe(1);
      expect(count(ADD.trim())).toBe(0);
      expect(count(BAD)).toBe(0);
      expect(printed.filter((l) => l.includes("sandbox"))).toEqual([]);
      expect(manifestSandbox()).toEqual({ denyRead: ["~/.ssh", "~/.x"], allowedDomains: [] });
    }
  });

  it("sandbox1 AC-10: a manifest without generatedSandbox, or with a non-object one, reads as two empty lists", async () => {
    write("settings.json", "[1");
    for (const value of [undefined, null, "x", [1]]) {
      const m = readJson(".harness.json");
      if (value === undefined) delete m.generatedSandbox;
      else m.generatedSandbox = value;
      write(".harness.json", m);
      capture();
      await updateCommand();
      expect(manifestSandbox()).toEqual({ denyRead: [], allowedDomains: [] });
    }
  });
});
