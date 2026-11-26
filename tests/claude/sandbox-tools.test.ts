import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateCommand } from "../../src/commands/generate.js";
import { updateCommand } from "../../src/commands/update.js";

const line = (names: string): string =>
  `missing ${names} on PATH: every Bash command fails, because sandbox.failIfUnavailable is true. ` +
  "Install bubblewrap and socat, then run agent-stack detect.";

const dirs: string[] = [];
let project: string;
let printed: string[];

const read = (rel: string): string => readFileSync(join(project, ".claude", rel), "utf-8");
const toolLines = (): string[] => printed.filter((l) => l.includes(" on PATH: "));

/** `exists` that finds every tool except `absent`. */
const finds = (...absent: string[]) => vi.fn(async (cmd: string) => !absent.includes(cmd));

function capture(): void {
  printed = [];
  const grab = (...a: unknown[]): void => {
    printed.push(a.join(" "));
  };
  vi.spyOn(console, "log").mockImplementation(grab);
  vi.spyOn(console, "error").mockImplementation(grab);
  vi.spyOn(console, "warn").mockImplementation(grab);
}

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), "sandbox-tools-"));
  dirs.push(project);
  vi.spyOn(process, "cwd").mockReturnValue(project);
  capture();
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("sandbox1: the tools line", () => {
  it("sandbox1 AC-26: generate on linux prints the line once, right after the Generated line", async () => {
    await generateCommand({ platform: "linux", exists: finds("socat") });
    expect(toolLines()).toHaveLength(1);
    expect(toolLines()[0]).toContain(line("socat"));
    const generated = printed.findIndex((l) => /Generated \d+ harness file\(s\)\./.test(l));
    const tools = printed.findIndex((l) => l.includes(" on PATH: "));
    expect(generated).toBeGreaterThanOrEqual(0);
    expect(tools).toBe(generated + 1);
  });

  it("sandbox1 AC-26: both tools missing are named, bwrap first", async () => {
    await generateCommand({ platform: "linux", exists: finds("bwrap", "socat") });
    expect(toolLines()[0]).toContain(line("bwrap, socat"));
  });

  it("sandbox1 AC-26: update prints the line as the last sandbox line, also when settings.json is invalid", async () => {
    await generateCommand({ platform: "darwin", exists: finds() });
    capture();
    await updateCommand({ platform: "linux", exists: finds("bwrap") });
    expect(toolLines()).toHaveLength(1);
    expect(toolLines()[0]).toContain(line("bwrap"));

    writeFileSync(join(project, ".claude", "settings.json"), "{not json");
    capture();
    await updateCommand({ platform: "linux", exists: finds("bwrap") });
    expect(toolLines()).toHaveLength(1);
    const unreadable = printed.findIndex((l) => l.includes("is not valid JSON, so it was left as is."));
    expect(unreadable).toBeGreaterThanOrEqual(0);
    expect(printed.findIndex((l) => l.includes(" on PATH: "))).toBeGreaterThan(unreadable);
  });

  it("sandbox1 AC-26: the exit code is unchanged (no exit call)", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    await generateCommand({ platform: "linux", exists: finds("socat") });
    await updateCommand({ platform: "linux", exists: finds("socat") });
    expect(exit).not.toHaveBeenCalled();
  });

  it("sandbox1 AC-27: both tools found on linux → no line", async () => {
    await generateCommand({ platform: "linux", exists: finds() });
    expect(toolLines()).toEqual([]);
    capture();
    await updateCommand({ platform: "linux", exists: finds() });
    expect(toolLines()).toEqual([]);
  });

  it("sandbox1 AC-27: on another platform no line, and exists is never called", async () => {
    for (const platform of ["darwin", "win32"]) {
      const exists = finds("bwrap", "socat");
      capture();
      await rmAndGenerate(platform, exists);
      await updateCommand({ platform, exists });
      expect(toolLines()).toEqual([]);
      expect(exists).not.toHaveBeenCalled();
    }
  });
});

async function rmAndGenerate(platform: string, exists: (c: string) => Promise<boolean>): Promise<void> {
  rmSync(join(project, ".claude"), { recursive: true, force: true });
  await generateCommand({ platform, exists });
}

describe("sandbox1: update --dry-run and the tools line", () => {
  it("sandbox1 AC-26: --dry-run prints the line too", async () => {
    await generateCommand({ platform: "darwin", exists: finds() });
    capture();
    await updateCommand({ dryRun: true, platform: "linux", exists: finds("socat") });
    expect(toolLines()).toHaveLength(1);
    expect(toolLines()[0]).toContain(line("socat"));
  });

  it("sandbox1 AC-19: --dry-run prints every sandbox line of a real run and writes nothing", async () => {
    await generateCommand({ platform: "darwin", exists: finds() });
    const gates = JSON.parse(read("gates.json")) as Record<string, unknown>;
    delete gates.sandbox; // the add line prints
    writeFileSync(join(project, ".claude", "gates.json"), JSON.stringify(gates, null, 2) + "\n");
    const before = { s: read("settings.json"), g: read("gates.json"), m: read(".harness.json") };

    const sandboxLines = (): string[] =>
      printed.filter((l) => l.includes("sandbox.") || l.includes(" on PATH: ")).map((l) => l.trim());
    const options = { platform: "linux", exists: finds("socat") };

    capture();
    await updateCommand({ ...options, dryRun: true });
    const dry = sandboxLines();
    expect(dry.length).toBeGreaterThanOrEqual(2);
    expect({ s: read("settings.json"), g: read("gates.json"), m: read(".harness.json") }).toEqual(before);

    capture();
    await updateCommand(options);
    expect(sandboxLines()).toEqual(dry);
  });
});
