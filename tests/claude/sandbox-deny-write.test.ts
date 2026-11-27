import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateCommand } from "../../src/commands/generate.js";
import { updateCommand } from "../../src/commands/update.js";
import { buildHarnessFiles } from "../../src/claude/harness.js";
import { buildSandboxBlock, HARNESS_WRITE_PATHS, SECRET_FOLDERS } from "../../src/claude/sandbox.js";
import { TS_PARAMS } from "../hooks/fixture.js";
import { pinPlatform } from "./pin-platform.js";

pinPlatform();

const HARNESS = ["./.claude/gates.json", "./.claude/bin", "./CLAUDE.md"];
const KEPT = "  kept your setting in settings.json — ";
const writable = (entry: string): string =>
  `${entry} is writable by Bash inside the sandbox: it is not in sandbox.filesystem.denyWrite`;
const COLOUR = new RegExp("\\u001b\\[[0-9;]*m", "g");

const dirs: string[] = [];
let project: string;
let printed: string[];

const path = (rel: string): string => join(project, ".claude", rel);
const readJson = (rel: string): Record<string, unknown> =>
  JSON.parse(readFileSync(path(rel), "utf-8")) as Record<string, unknown>;
const write = (rel: string, value: unknown): void => {
  writeFileSync(path(rel), JSON.stringify(value, null, 2) + "\n");
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

const warnings = (): string[] => printed.filter((l) => l.startsWith("⚠ ")).map((l) => l.slice(2));
const sandboxKept = (): string[] =>
  printed.filter((l) => l.startsWith(KEPT)).map((l) => l.slice(KEPT.length)).filter((l) => l.startsWith("sandbox."));
const fsOf = (): Record<string, unknown> =>
  (readJson("settings.json").sandbox as { filesystem: Record<string, unknown> }).filesystem;
const manifestSandbox = (): Record<string, unknown> =>
  readJson(".harness.json").generatedSandbox as Record<string, unknown>;

/** settings.json with its `sandbox.filesystem` replaced by the user's value. */
function filesystemWith(fs: unknown): void {
  const s = readJson("settings.json");
  const sandbox = s.sandbox as Record<string, unknown>;
  write("settings.json", { ...s, sandbox: { ...sandbox, filesystem: fs } });
}

describe("Q1: the built block", () => {
  it("Q1: the constant holds the three harness places in order", () => {
    expect([...HARNESS_WRITE_PATHS]).toEqual(HARNESS);
  });

  it("Q1: denyWrite holds the three entries between denyRead and allowWrite", () => {
    const fs = buildSandboxBlock(["a.com"], ["~/.npm"]).filesystem;
    expect(Object.keys(fs)).toEqual(["denyRead", "denyWrite", "allowWrite"]);
    expect(fs.denyWrite).toEqual(HARNESS);
    expect(Object.keys(buildSandboxBlock([]).filesystem)).toEqual(["denyRead", "denyWrite"]);
  });

  it("Q1: generate writes denyWrite into settings.json and records it in the manifest", () => {
    const files = buildHarnessFiles(TS_PARAMS);
    const s = JSON.parse(files.find((f) => f.path === ".claude/settings.json")!.content);
    expect(s.sandbox.filesystem.denyWrite).toEqual(HARNESS);
    const m = JSON.parse(files.find((f) => f.path === ".claude/.harness.json")!.content);
    expect(m.generatedSandbox.denyWrite).toEqual(HARNESS);
  });
});

describe("Q1: update and denyWrite", () => {
  beforeEach(async () => {
    project = mkdtempSync(join(tmpdir(), "sandbox-deny-write-"));
    dirs.push(project);
    vi.spyOn(process, "cwd").mockReturnValue(project);
    capture();
    await generateCommand();
    vi.spyOn(process, "exit").mockImplementation((code?: string | number | null) => {
      throw new Error(`process.exit(${String(code)})`);
    });
    capture();
  });
  afterEach(() => {
    vi.restoreAllMocks();
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("Q1: an older settings.json (no denyWrite, no record) gets all three, recorded in the manifest", async () => {
    const m = readJson(".harness.json");
    const g = m.generatedSandbox as Record<string, unknown>;
    delete g.denyWrite;
    write(".harness.json", m);
    filesystemWith({ denyRead: [...SECRET_FOLDERS] });
    await updateCommand();
    expect(fsOf().denyWrite).toEqual(HARNESS);
    expect(Object.keys(fsOf()).slice(0, 2)).toEqual(["denyRead", "denyWrite"]);
    expect(manifestSandbox().denyWrite).toEqual(HARNESS);
    expect(warnings()).toEqual([]);
    expect(sandboxKept()).toEqual([]);
  });

  it("Q1: the user's own denyWrite entries stay after the harness entries, each once", async () => {
    filesystemWith({ denyRead: [...SECRET_FOLDERS], denyWrite: ["./secret", ...HARNESS, "./secret"] });
    await updateCommand();
    expect(fsOf().denyWrite).toEqual([...HARNESS, "./secret"]);
    expect(sandboxKept()).toEqual(["sandbox.filesystem.denyWrite: ./secret"]);
    expect(manifestSandbox().denyWrite).toEqual(HARNESS);
  });

  it("Q1: a removed harness entry stays removed and warns on every run", async () => {
    filesystemWith({ denyRead: [...SECRET_FOLDERS], denyWrite: ["./.claude/gates.json", "./CLAUDE.md"] });
    await updateCommand();
    expect(fsOf().denyWrite).toEqual(["./.claude/gates.json", "./CLAUDE.md"]);
    expect(warnings()).toEqual([writable("./.claude/bin")]);
    capture();
    await updateCommand();
    expect(fsOf().denyWrite).toEqual(["./.claude/gates.json", "./CLAUDE.md"]);
    expect(warnings()).toEqual([writable("./.claude/bin")]);
    expect(manifestSandbox().denyWrite).toEqual(HARNESS);
  });

  it("Q1: a denyWrite that is not a list is replaced with the harness list", async () => {
    filesystemWith({ denyRead: [...SECRET_FOLDERS], denyWrite: "./CLAUDE.md" });
    await updateCommand();
    expect(fsOf().denyWrite).toEqual(HARNESS);
    expect(warnings()).toEqual(["replaced sandbox.filesystem.denyWrite in .claude/settings.json: it was not a list"]);
  });
});
