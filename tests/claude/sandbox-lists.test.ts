import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateCommand } from "../../src/commands/generate.js";
import { updateCommand } from "../../src/commands/update.js";
import { buildSandboxBlock, SECRET_FOLDERS } from "../../src/claude/sandbox.js";

// The Contract's `update` lines (docs/specs/sandbox1/SPEC.md).
const KEPT = "  kept your setting in settings.json — ";
const ADD = "  add sandbox.allowedDomains to .claude/gates.json to change the list";
const readable = (entry: string): string =>
  `${entry} is readable inside the sandbox: it is not in sandbox.filesystem.denyRead`;

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

const keptLines = (): string[] => printed.filter((l) => l.startsWith(KEPT)).map((l) => l.slice(KEPT.length));
const sandboxKept = (): string[] => keptLines().filter((l) => l.startsWith("sandbox."));
const warnings = (): string[] => printed.filter((l) => l.startsWith("⚠ ")).map((l) => l.slice(2));
const readableLines = (): string[] => warnings().filter((l) => l.includes(" is readable inside the sandbox"));
/** Every sandbox line of the Contract table "update output", in order (the add line and the warnings). */
const sandboxLines = (): string[] =>
  printed.filter((l) => l === ADD || (l.startsWith("⚠ ") && l.includes("sandbox"))).map((l) => l.replace(/^⚠ /, ""));

/** settings.json as generated, with its `sandbox` replaced by the user's value (or removed with `undefined`). */
function settingsWith(sandbox: unknown): Record<string, unknown> {
  const settings = readJson("settings.json");
  if (sandbox === undefined) {
    delete settings.sandbox;
    return settings;
  }
  return { ...settings, sandbox };
}
const settingsSandbox = (): Record<string, unknown> => readJson("settings.json").sandbox as Record<string, unknown>;
const denyRead = (): unknown => (settingsSandbox().filesystem as { denyRead: unknown }).denyRead;
const allowedDomains = (): unknown => (settingsSandbox().network as { allowedDomains: unknown }).allowedDomains;
const manifestSandbox = (): Record<string, unknown> =>
  readJson(".harness.json").generatedSandbox as Record<string, unknown>;

/** The manifest with its `generatedSandbox` replaced (or removed with `undefined`), as 0.4.8 or a hand edit left it. */
function manifestWith(generated: unknown): void {
  const m = readJson(".harness.json");
  if (generated === undefined) delete m.generatedSandbox;
  else m.generatedSandbox = generated;
  write(".harness.json", m);
}

function gatesDomains(domains: string[] | undefined): void {
  const gates = readJson("gates.json");
  if (domains === undefined) delete gates.sandbox;
  else gates.sandbox = { allowedDomains: domains };
  write("gates.json", gates);
}

const without = (folder: string): string[] => SECRET_FOLDERS.filter((f) => f !== folder);

beforeEach(async () => {
  project = mkdtempSync(join(tmpdir(), "sandbox-lists-"));
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

describe("sandbox1: entries the harness wrote last time", () => {
  it("sandbox1 AC-14: a domain dropped from gates.json leaves settings.json and is not reported", async () => {
    gatesDomains(["registry.npmjs.org", "example.com"]);
    await updateCommand();
    expect(allowedDomains()).toEqual(["registry.npmjs.org", "example.com"]);
    expect(manifestSandbox().allowedDomains).toEqual(["registry.npmjs.org", "example.com"]);
    gatesDomains(["registry.npmjs.org"]);
    capture();
    await updateCommand();
    expect(allowedDomains()).toEqual(["registry.npmjs.org"]);
    expect(manifestSandbox().allowedDomains).toEqual(["registry.npmjs.org"]);
    expect(sandboxKept()).toEqual([]);
    expect(printed.filter((l) => l.includes("example.com"))).toEqual([]);
  });

  it("sandbox1 AC-14: a denyRead entry the harness wrote last time and not now is dropped; the user's stay", async () => {
    manifestWith({ denyRead: [...SECRET_FOLDERS, "~/.old"], allowedDomains: [...detected, "gone.com"] });
    write(
      "settings.json",
      settingsWith({
        filesystem: { denyRead: [...SECRET_FOLDERS, "~/.old", "~/.foo"] },
        network: { allowedDomains: [...detected, "gone.com", "mine.com"] },
      })
    );
    await updateCommand();
    expect(denyRead()).toEqual([...SECRET_FOLDERS, "~/.foo"]);
    expect(allowedDomains()).toEqual([...detected, "mine.com"]);
    expect(sandboxKept()).toEqual(["sandbox.filesystem.denyRead: ~/.foo", "sandbox.network.allowedDomains: mine.com"]);
    expect(manifestSandbox()).toEqual({ denyRead: [...SECRET_FOLDERS], allowedDomains: detected });
    expect(readableLines()).toEqual([]);
  });
});

describe("sandbox1: reading generatedSandbox", () => {
  it("sandbox1 AC-15: no, or a non-object, generatedSandbox → every user entry is the user's; exit 0", async () => {
    for (const generated of [undefined, null, "x", 42, [SECRET_FOLDERS[0]]]) {
      manifestWith(generated);
      write(
        "settings.json",
        settingsWith({ filesystem: { denyRead: ["~/.foo"] }, network: { allowedDomains: ["example.com"] } })
      );
      capture();
      await expect(updateCommand()).resolves.toBeUndefined();
      expect(denyRead()).toEqual([...SECRET_FOLDERS, "~/.foo"]);
      expect(allowedDomains()).toEqual([...detected, "example.com"]);
      expect(sandboxKept()).toEqual([
        "sandbox.filesystem.denyRead: ~/.foo",
        "sandbox.network.allowedDomains: example.com",
      ]);
      expect(readableLines()).toEqual([]);
      expect(manifestSandbox()).toEqual({ denyRead: [...SECRET_FOLDERS], allowedDomains: detected });
    }
  });

  it("sandbox1 AC-15: a list that is not an array reads as empty; non-string entries of an array are dropped", async () => {
    manifestWith({ denyRead: [1, "~/.foo", null, { a: 1 }], allowedDomains: "example.com" });
    write(
      "settings.json",
      settingsWith({ filesystem: { denyRead: ["~/.foo", "~/.bar"] }, network: { allowedDomains: ["example.com"] } })
    );
    await expect(updateCommand()).resolves.toBeUndefined();
    expect(denyRead()).toEqual([...SECRET_FOLDERS, "~/.bar"]); // ~/.foo was ours last time
    expect(allowedDomains()).toEqual([...detected, "example.com"]); // a non-array list: every entry is the user's
    expect(sandboxKept()).toEqual([
      "sandbox.filesystem.denyRead: ~/.bar",
      "sandbox.network.allowedDomains: example.com",
    ]);
    expect(readableLines()).toEqual([]);
  });
});

describe("sandbox1: removed secret folders", () => {
  it("sandbox1 AC-18: a 0.4.8 repo with denyRead [~/.foo] and no generatedSandbox → the nine, then ~/.foo, no readable line", async () => {
    manifestWith(undefined);
    write("settings.json", settingsWith({ filesystem: { denyRead: ["~/.foo"] } }));
    await updateCommand();
    expect(denyRead()).toEqual([...SECRET_FOLDERS, "~/.foo"]);
    expect(sandboxKept()).toEqual(["sandbox.filesystem.denyRead: ~/.foo"]);
    expect(readableLines()).toEqual([]);
  });

  it("sandbox1 AC-18: a 0.5.0 repo whose user deleted ~/.npmrc → the other eight, one readable line", async () => {
    const block = buildSandboxBlock(detected);
    write("settings.json", settingsWith({ ...block, filesystem: { denyRead: without("~/.npmrc") } }));
    await updateCommand();
    expect(denyRead()).toEqual(without("~/.npmrc"));
    expect(readableLines()).toEqual([readable("~/.npmrc")]);
    expect(printed.filter((l) => l.includes(readable("~/.npmrc")))).toHaveLength(1);
    expect(sandboxKept()).toEqual([]);
    expect(manifestSandbox().denyRead).toEqual([...SECRET_FOLDERS]);
  });

  it("sandbox1 AC-18: a 0.5.0 repo whose user deleted the whole sandbox key → the full block, no readable line", async () => {
    write("settings.json", settingsWith(undefined));
    await updateCommand();
    expect(settingsSandbox()).toEqual(buildSandboxBlock(detected));
    expect(readableLines()).toEqual([]);
    expect(manifestSandbox().denyRead).toEqual([...SECRET_FOLDERS]);
  });

  it("sandbox1 AC-18: an absent filesystem or denyRead → all nine, no line", async () => {
    for (const sandbox of [{ enabled: true }, { filesystem: {} }, { filesystem: { allowWrite: ["/tmp"] } }]) {
      write("settings.json", settingsWith(sandbox));
      capture();
      await updateCommand();
      expect(denyRead()).toEqual([...SECRET_FOLDERS]);
      expect(readableLines()).toEqual([]);
      expect(warnings()).toEqual([]);
    }
  });

  it("sandbox1 AC-18: removed folders keep their place out; readable lines come in secret-folder order, after replaced", async () => {
    write(
      "settings.json",
      settingsWith({
        enabled: false,
        network: { allowedDomains: "x" },
        filesystem: { denyRead: ["~/.foo", ...SECRET_FOLDERS.filter((f) => f !== "~/.azure" && f !== "~/.ssh")] },
      })
    );
    await updateCommand();
    expect(denyRead()).toEqual([...SECRET_FOLDERS.filter((f) => f !== "~/.azure" && f !== "~/.ssh"), "~/.foo"]);
    expect(warnings()).toEqual([
      "sandbox.enabled is false in .claude/settings.json: Bash runs without the sandbox",
      "replaced sandbox.network.allowedDomains in .claude/settings.json: it was not a list",
      readable("~/.ssh"),
      readable("~/.azure"),
    ]);
    expect(manifestSandbox().denyRead).toEqual([...SECRET_FOLDERS]);
  });

  it("sandbox1 AC-18: a folder not in generatedSandbox.denyRead (never deployed) is written at its place, no line", async () => {
    manifestWith({ denyRead: without("~/.kube"), allowedDomains: detected });
    write("settings.json", settingsWith({ filesystem: { denyRead: without("~/.kube") } }));
    await updateCommand();
    expect(denyRead()).toEqual([...SECRET_FOLDERS]);
    expect(readableLines()).toEqual([]);
    expect(manifestSandbox().denyRead).toEqual([...SECRET_FOLDERS]);
  });

  it("sandbox1 AC-18: a removed folder stays removed on the next update and warns again", async () => {
    write("settings.json", settingsWith({ filesystem: { denyRead: without("~/.docker") } }));
    await updateCommand();
    capture();
    await updateCommand();
    expect(denyRead()).toEqual(without("~/.docker"));
    expect(readableLines()).toEqual([readable("~/.docker")]);
  });
});

describe("sandbox1: a second update", () => {
  it("sandbox1 AC-17: twice in a row → the same settings.json and manifest, the same lines minus replaced", async () => {
    gatesDomains(undefined); // the add line
    write(
      "settings.json",
      settingsWith({
        enabled: false,
        excludedCommands: ["docker"],
        network: null,
        filesystem: { denyRead: ["~/.foo", ...without("~/.npmrc")], allowWrite: ["/tmp"] },
      })
    );
    await updateCommand();
    const settings = read("settings.json");
    const manifest = read(".harness.json");
    const first = sandboxLines();
    const kept = keptLines();
    expect(first).toEqual([
      ADD,
      "sandbox.enabled is false in .claude/settings.json: Bash runs without the sandbox",
      "replaced sandbox.network in .claude/settings.json: it was not an object",
      readable("~/.npmrc"),
    ]);
    capture();
    await updateCommand();
    expect(read("settings.json")).toBe(settings);
    expect(read(".harness.json")).toBe(manifest);
    expect(sandboxLines()).toEqual(first.filter((l) => !l.startsWith("replaced ")));
    expect(keptLines()).toEqual(kept);
  });

  it("sandbox1 AC-17: a plain repo updates twice with the same bytes and no sandbox line", async () => {
    await updateCommand();
    const settings = read("settings.json");
    const manifest = read(".harness.json");
    const first = sandboxLines();
    capture();
    await updateCommand();
    expect(read("settings.json")).toBe(settings);
    expect(read(".harness.json")).toBe(manifest);
    expect(sandboxLines()).toEqual(first);
    expect(readableLines()).toEqual([]);
  });
});
