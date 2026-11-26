import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateCommand } from "../../src/commands/generate.js";
import { updateCommand } from "../../src/commands/update.js";
import { buildSandboxBlock, HARNESS_WRITE_PATHS, SECRET_FOLDERS } from "../../src/claude/sandbox.js";

const DENY_WRITE = [...HARNESS_WRITE_PATHS];
import { pinPlatform } from "./pin-platform.js";

pinPlatform(); // the warnings these tests compare must not depend on the machine (Linux without socat)

// The Contract's `update` lines (docs/specs/sandbox1/SPEC.md).
const KEPT = "  kept your setting in settings.json — ";
const WARN = {
  enabled: (v: string) => `sandbox.enabled is ${v} in .claude/settings.json: Bash runs without the sandbox`,
  allowUnsandboxedCommands: (v: string) =>
    `sandbox.allowUnsandboxedCommands is ${v} in .claude/settings.json: the model can run a command outside the sandbox`,
  failIfUnavailable: (v: string) =>
    `sandbox.failIfUnavailable is ${v} in .claude/settings.json: Bash runs without the sandbox when the sandbox cannot start`,
};
const replacedObject = (p: string): string => `replaced ${p} in .claude/settings.json: it was not an object`;
const replacedList = (p: string): string => `replaced ${p} in .claude/settings.json: it was not a list`;

/** The safe-text ranges (Terms): none of them may reach the terminal. */
const UNSAFE = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029\\u202a-\\u202e\\u2066-\\u2069]");
/** chalk's colour codes (SGR): not part of the Contract, removed before the check. */
const COLOUR = new RegExp("\\u001b\\[[0-9;]*m", "g");

const dirs: string[] = [];
let project: string;
let printed: string[];
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
    printed.push(a.map(String).join(" ").replace(COLOUR, ""));
  };
  vi.spyOn(console, "log").mockImplementation(grab);
  vi.spyOn(console, "error").mockImplementation(grab);
  vi.spyOn(console, "warn").mockImplementation(grab);
}

const count = (needle: string): number => printed.filter((l) => l.includes(needle)).length;
/** The `customSettings` entries as printed, in order. */
const keptLines = (): string[] => printed.filter((l) => l.startsWith(KEPT)).map((l) => l.slice(KEPT.length));
const sandboxKept = (): string[] => keptLines().filter((l) => l.startsWith("sandbox."));
const warnings = (): string[] => printed.filter((l) => l.startsWith("⚠ ")).map((l) => l.slice(2));

/** settings.json as generated, with its `sandbox` replaced by the user's value and a user key at the end. */
function settingsWith(sandbox: unknown): Record<string, unknown> {
  const settings = readJson("settings.json");
  return { ...settings, sandbox, env: { FOO: "1" } };
}
const settingsSandbox = (): Record<string, unknown> => readJson("settings.json").sandbox as Record<string, unknown>;

/** The manifest without `generatedSandbox`, as 0.4.8 left it (AC-15): every user list entry counts as the user's. */
function asOldManifest(): void {
  const m = readJson(".harness.json");
  delete m.generatedSandbox;
  write(".harness.json", m);
}

beforeEach(async () => {
  project = mkdtempSync(join(tmpdir(), "sandbox-merge-"));
  dirs.push(project);
  vi.spyOn(process, "cwd").mockReturnValue(project);
  capture();
  await generateCommand();
  detected = (readJson("gates.json").sandbox as { allowedDomains: string[] }).allowedDomains;
  vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
    throw new Error(`process.exit(${String(code)})`);
  });
  capture();
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("sandbox1: switches", () => {
  it("sandbox1 AC-6: an empty user sandbox gets the whole block, nothing reported", async () => {
    write("settings.json", settingsWith({}));
    await updateCommand();
    const settings = readJson("settings.json");
    expect(Object.keys(settings)).toEqual(["$schema", "permissions", "sandbox", "hooks", "env"]);
    expect(settings.sandbox).toEqual(buildSandboxBlock(detected));
    expect(sandboxKept()).toEqual([]);
    expect(warnings()).toEqual([]);
  });

  it("sandbox1 AC-6: switches equal to the harness value stay and are not reported", async () => {
    write("settings.json", settingsWith({ failIfUnavailable: true, enabled: true, allowUnsandboxedCommands: false }));
    await updateCommand();
    expect(settingsSandbox()).toEqual(buildSandboxBlock(detected));
    expect(Object.keys(settingsSandbox())).toEqual(Object.keys(buildSandboxBlock(detected)));
    expect(sandboxKept()).toEqual([]);
    expect(warnings()).toEqual([]);
  });

  it("sandbox1 AC-6: an absent filesystem, network or list gets the harness value with no line", async () => {
    write("settings.json", settingsWith({ enabled: true, filesystem: {}, network: { other: 1 } }));
    await updateCommand();
    const sandbox = settingsSandbox();
    expect(sandbox.filesystem).toEqual({ denyRead: [...SECRET_FOLDERS], denyWrite: DENY_WRITE });
    expect(sandbox.network).toEqual({ allowedDomains: detected, other: 1 });
    expect(warnings()).toEqual([]);
  });

  it("sandbox1 AC-7: a weaker switch is kept, reported as sandbox.<key>: <v>, and warned once", async () => {
    write("settings.json", settingsWith({ enabled: false }));
    await updateCommand();
    expect(settingsSandbox().enabled).toBe(false);
    expect(settingsSandbox().allowUnsandboxedCommands).toBe(false);
    expect(sandboxKept()).toEqual(["sandbox.enabled: false"]);
    expect(count("sandbox.enabled is false in .claude/settings.json: Bash runs without the sandbox")).toBe(1);
    expect(warnings()).toEqual([WARN.enabled("false")]);
  });

  it("sandbox1 AC-7: every switch, non-boolean values too, in the harness order", async () => {
    write(
      "settings.json",
      settingsWith({ failIfUnavailable: "yes", allowUnsandboxedCommands: true, enabled: null })
    );
    await updateCommand();
    const sandbox = settingsSandbox();
    expect(Object.keys(sandbox).slice(0, 3)).toEqual(["enabled", "allowUnsandboxedCommands", "failIfUnavailable"]);
    expect(sandbox.enabled).toBe(null);
    expect(sandbox.allowUnsandboxedCommands).toBe(true);
    expect(sandbox.failIfUnavailable).toBe("yes");
    expect(sandboxKept()).toEqual([
      "sandbox.enabled: null",
      "sandbox.allowUnsandboxedCommands: true",
      'sandbox.failIfUnavailable: "yes"',
    ]);
    expect(warnings()).toEqual([
      WARN.enabled("null"),
      WARN.allowUnsandboxedCommands("true"),
      WARN.failIfUnavailable('"yes"'),
    ]);
  });

  it("sandbox1 AC-7: --dry-run prints the same lines and writes nothing", async () => {
    const text = write("settings.json", settingsWith({ enabled: 0 }));
    await updateCommand({ dryRun: true });
    expect(read("settings.json")).toBe(text);
    expect(sandboxKept()).toEqual(["sandbox.enabled: 0"]);
    expect(warnings()).toEqual([WARN.enabled("0")]);
  });
});

describe("sandbox1: other keys and list entries", () => {
  it("sandbox1 AC-8: other keys follow the harness keys at their place and are reported", async () => {
    write(
      "settings.json",
      settingsWith({
        excludedCommands: ["docker"],
        network: { deniedDomains: ["bad.com"], allowedDomains: [] },
        filesystem: { allowWrite: ["/tmp/x"] },
        enabled: true,
        autoAllowBashIfSandboxed: true,
      })
    );
    await updateCommand();
    const sandbox = settingsSandbox();
    expect(Object.keys(sandbox)).toEqual([
      "enabled",
      "allowUnsandboxedCommands",
      "failIfUnavailable",
      "filesystem",
      "network",
      "excludedCommands",
      "autoAllowBashIfSandboxed",
    ]);
    expect(sandbox.excludedCommands).toEqual(["docker"]);
    expect(sandbox.filesystem).toEqual({ denyRead: [...SECRET_FOLDERS], denyWrite: DENY_WRITE, allowWrite: ["/tmp/x"] });
    expect(Object.keys(sandbox.filesystem as object)).toEqual(["denyRead", "denyWrite", "allowWrite"]);
    expect(sandbox.network).toEqual({ allowedDomains: detected, deniedDomains: ["bad.com"] });
    expect(Object.keys(sandbox.network as object)).toEqual(["allowedDomains", "deniedDomains"]);
    expect(sandboxKept()).toEqual([
      "sandbox.excludedCommands",
      "sandbox.autoAllowBashIfSandboxed",
      "sandbox.filesystem.allowWrite",
      "sandbox.network.deniedDomains",
    ]);
    expect(warnings()).toEqual([]);
  });

  it("sandbox1 AC-8: lists are the harness entries, then the user's, no entry twice; each user entry reported once", async () => {
    expect(detected.length).toBeGreaterThan(0);
    asOldManifest();
    write(
      "settings.json",
      settingsWith({
        filesystem: { denyRead: ["~/.foo", "~/.ssh", "~/.foo", "~/.bar"] },
        network: { allowedDomains: ["example.com", detected[0], { host: 1 }, "example.com", { host: 1 }] },
      })
    );
    await updateCommand();
    const sandbox = settingsSandbox();
    expect((sandbox.filesystem as { denyRead: unknown }).denyRead).toEqual([...SECRET_FOLDERS, "~/.foo", "~/.bar"]);
    expect((sandbox.network as { allowedDomains: unknown }).allowedDomains).toEqual([
      ...detected,
      "example.com",
      { host: 1 },
    ]);
    expect(sandboxKept()).toEqual([
      "sandbox.filesystem.denyRead: ~/.foo",
      "sandbox.filesystem.denyRead: ~/.bar",
      "sandbox.network.allowedDomains: example.com",
      'sandbox.network.allowedDomains: {"host":1}',
    ]);
  });

  it("sandbox1 AC-8: the Contract order — top-level keys first, then switches, other keys, denyRead, allowedDomains", async () => {
    write(
      "settings.json",
      settingsWith({
        network: { allowedDomains: ["example.com"], deniedDomains: [] },
        filesystem: { denyRead: ["~/.foo"], allowRead: [] },
        mine: 1,
        failIfUnavailable: false,
      })
    );
    await updateCommand();
    expect(keptLines()).toEqual([
      "env",
      "sandbox.failIfUnavailable: false",
      "sandbox.mine",
      "sandbox.filesystem.allowRead",
      "sandbox.network.deniedDomains",
      "sandbox.filesystem.denyRead: ~/.foo",
      "sandbox.network.allowedDomains: example.com",
    ]);
  });

  it("sandbox1 AC-8: a second update keeps the same file and reports the same entries", async () => {
    write("settings.json", settingsWith({ enabled: false, excludedCommands: ["x"], filesystem: { denyRead: ["~/.foo"] } }));
    await updateCommand();
    const first = read("settings.json");
    const kept = sandboxKept();
    capture();
    await updateCommand();
    expect(read("settings.json")).toBe(first);
    expect(sandboxKept()).toEqual(kept);
  });
});

describe("sandbox1: wrong-typed places", () => {
  it("sandbox1 AC-13: a sandbox that is not an object gets the harness block and one replaced line", async () => {
    for (const value of ["x", null, [], 42, true]) {
      write("settings.json", settingsWith(value));
      capture();
      await expect(updateCommand()).resolves.toBeUndefined();
      const settings = readJson("settings.json");
      expect(settings.sandbox).toEqual(buildSandboxBlock(detected));
      expect(settings.env).toEqual({ FOO: "1" });
      expect(warnings()).toEqual([replacedObject("sandbox")]);
      expect(sandboxKept()).toEqual([]);
    }
  });

  it("sandbox1 AC-13: a wrong-typed filesystem or network is replaced; the user's other keys stay", async () => {
    write(
      "settings.json",
      settingsWith({ enabled: false, filesystem: ["~/.foo"], network: null, excludedCommands: ["x"] })
    );
    await updateCommand();
    const sandbox = settingsSandbox();
    expect(sandbox.enabled).toBe(false);
    expect(sandbox.filesystem).toEqual({ denyRead: [...SECRET_FOLDERS], denyWrite: DENY_WRITE });
    expect(sandbox.network).toEqual({ allowedDomains: detected });
    expect(sandbox.excludedCommands).toEqual(["x"]);
    expect(warnings()).toEqual([
      WARN.enabled("false"),
      replacedObject("sandbox.filesystem"),
      replacedObject("sandbox.network"),
    ]);
    expect(sandboxKept()).toEqual(["sandbox.enabled: false", "sandbox.excludedCommands"]);
  });

  it("sandbox1 AC-13: a denyRead or allowedDomains that is not a list is replaced; keys around it stay", async () => {
    write(
      "settings.json",
      settingsWith({
        filesystem: { denyRead: "~/.ssh", allowWrite: ["/tmp"] },
        network: { deniedDomains: ["bad.com"], allowedDomains: { a: 1 } },
      })
    );
    await updateCommand();
    const sandbox = settingsSandbox();
    expect(sandbox.filesystem).toEqual({ denyRead: [...SECRET_FOLDERS], denyWrite: DENY_WRITE, allowWrite: ["/tmp"] });
    expect(sandbox.network).toEqual({ allowedDomains: detected, deniedDomains: ["bad.com"] });
    expect(warnings()).toEqual([
      replacedList("sandbox.filesystem.denyRead"),
      replacedList("sandbox.network.allowedDomains"),
    ]);
    expect(count("replaced sandbox.filesystem.denyRead")).toBe(1);
  });

  it("sandbox1 AC-13: a second update prints no replaced line", async () => {
    write("settings.json", settingsWith({ filesystem: { denyRead: null } }));
    await updateCommand();
    expect(warnings()).toEqual([replacedList("sandbox.filesystem.denyRead")]);
    capture();
    await updateCommand();
    expect(warnings()).toEqual([]);
  });
});

describe("sandbox1: safe text and __proto__", () => {
  it("sandbox1 AC-25: control and bidi characters in keys and entries print as ?, the file keeps them", async () => {
    const entry = "~/.x\u001b]0;pwned\u0007";
    const key = "‮evil";
    asOldManifest();
    write(
      "settings.json",
      settingsWith({
        [key]: 1,
        filesystem: { denyRead: [entry], ["a⁦b"]: 2 },
        network: { allowedDomains: ["c\u0085d.com"] },
      })
    );
    await updateCommand();
    for (const line of printed) expect(line).not.toMatch(UNSAFE);
    expect(sandboxKept()).toEqual([
      "sandbox.?evil",
      "sandbox.filesystem.a?b",
      "sandbox.filesystem.denyRead: ~/.x?]0;pwned?",
      "sandbox.network.allowedDomains: c?d.com",
    ]);
    const sandbox = settingsSandbox();
    expect(sandbox[key]).toBe(1);
    expect((sandbox.filesystem as { denyRead: unknown }).denyRead).toEqual([...SECRET_FOLDERS, entry]);
    expect((sandbox.filesystem as Record<string, unknown>)["a⁦b"]).toBe(2);
    expect((sandbox.network as { allowedDomains: unknown }).allowedDomains).toEqual([...detected, "c\u0085d.com"]);
  });

  it("sandbox1 AC-25: a switch value prints as the safe text of its JSON.stringify", async () => {
    write("settings.json", settingsWith({ enabled: "‮on\u001b", failIfUnavailable: { " ": 1 } }));
    await updateCommand();
    for (const line of printed) expect(line).not.toMatch(UNSAFE);
    expect(sandboxKept()).toEqual(['sandbox.enabled: "?on\\u001b"', 'sandbox.failIfUnavailable: {"?":1}']);
    expect(warnings()).toEqual([WARN.enabled('"?on\\u001b"'), WARN.failIfUnavailable('{"?":1}')]);
    expect(settingsSandbox().enabled).toBe("‮on\u001b");
  });

  it("sandbox1 AC-25: __proto__ under sandbox, filesystem or network is skipped and not reported", async () => {
    const settings = settingsWith({});
    const text = JSON.stringify(settings, null, 2).replace(
      '"sandbox": {}',
      '"sandbox": {"__proto__": {"polluted": 1}, "filesystem": {"__proto__": {"polluted": 2}}, ' +
        '"network": {"__proto__": {"polluted": 3}, "x": 1}}'
    );
    expect(text).toContain("__proto__");
    write("settings.json", text);
    await updateCommand();
    expect(read("settings.json")).not.toContain("__proto__");
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    const sandbox = settingsSandbox();
    expect(Object.getPrototypeOf(sandbox)).toBe(Object.prototype);
    expect(sandbox.filesystem).toEqual({ denyRead: [...SECRET_FOLDERS], denyWrite: DENY_WRITE });
    expect(sandbox.network).toEqual({ allowedDomains: detected, x: 1 });
    expect(sandboxKept()).toEqual(["sandbox.network.x"]);
    expect(printed.filter((l) => l.includes("__proto__"))).toEqual([]);
  });
});
