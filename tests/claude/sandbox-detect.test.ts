import { stripVTControlCharacters as plain } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../src/utils/shell.js", () => ({ commandExists: vi.fn() }));
vi.mock("../../src/claude/provider.js", () => ({
  detect: vi.fn(async () => ({ installed: true, version: "1.0.30", displayName: "Claude Code" })),
}));
vi.mock("../../src/detect/project.js", () => ({
  detectProject: vi.fn(async () => ({ scenario: "empty" })),
}));

import { missingSandboxTools, sandboxReadiness } from "../../src/claude/sandbox.js";
import { detectCommand } from "../../src/commands/detect.js";
import { commandExists } from "../../src/utils/shell.js";

const has = (...found: string[]) => vi.fn(async (cmd: string) => found.includes(cmd));

describe("agent-stack detect prints the OS sandbox line", () => {
  const realPlatform = Object.getOwnPropertyDescriptor(process, "platform");
  let lines: string[];

  beforeEach(() => {
    lines = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      lines.push(plain(args.map(String).join(" ")));
    });
    process.exitCode = undefined;
  });

  afterEach(() => {
    if (realPlatform) Object.defineProperty(process, "platform", realPlatform);
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  async function runDetect(platform: string, found: string[]): Promise<string[]> {
    Object.defineProperty(process, "platform", { value: platform, configurable: true });
    vi.mocked(commandExists).mockImplementation(async (cmd: string) => found.includes(cmd));
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    await detectCommand();
    expect(exit).not.toHaveBeenCalled();
    expect(process.exitCode ?? 0).toBe(0);
    const at = lines.indexOf("  Claude Code          ✔ installed (1.0.30)");
    expect(at).toBeGreaterThanOrEqual(0);
    expect(lines[at + 2]).toBe("");
    return [lines[at + 1] ?? ""];
  }

  it("sandbox1 AC-9: darwin line right after the Claude Code line, exit 0", async () => {
    expect(await runDetect("darwin", [])).toEqual(["  OS sandbox           ✔ built in (macOS Seatbelt)"]);
  });

  it("sandbox1 AC-9: linux with bwrap and socat found, exit 0", async () => {
    expect(await runDetect("linux", ["bwrap", "socat"])).toEqual([
      "  OS sandbox           ✔ found bwrap, socat",
    ]);
  });

  it("sandbox1 AC-16: linux missing socat prints the missing line, exit 0", async () => {
    expect(await runDetect("linux", ["bwrap"])).toEqual([
      "  OS sandbox           ✖ missing socat — Bash commands will fail; install bubblewrap and socat",
    ]);
  });

  it("sandbox1 AC-16: linux missing both prints the missing line, exit 0", async () => {
    expect(await runDetect("linux", [])).toEqual([
      "  OS sandbox           ✖ missing bwrap, socat — Bash commands will fail; install bubblewrap and socat",
    ]);
  });

  it("sandbox1 AC-16: other platform prints the not checked line, exit 0", async () => {
    expect(await runDetect("win32", [])).toEqual([
      "  OS sandbox           ? not checked on win32 — see Claude Code's sandbox docs",
    ]);
  });
});

describe("sandbox readiness", () => {
  it("sandbox1 AC-9: darwin is built in and exists is not called", async () => {
    const exists = has();
    expect(plain(await sandboxReadiness("darwin", exists))).toBe("✔ built in (macOS Seatbelt)");
    expect(exists).not.toHaveBeenCalled();
  });

  it("sandbox1 AC-9: linux with both tools found", async () => {
    expect(plain(await sandboxReadiness("linux", has("bwrap", "socat")))).toBe("✔ found bwrap, socat");
  });

  it("sandbox1 AC-16: linux missing one tool", async () => {
    expect(await missingSandboxTools("linux", has("bwrap"))).toEqual(["socat"]);
    expect(plain(await sandboxReadiness("linux", has("bwrap")))).toBe(
      "✖ missing socat — Bash commands will fail; install bubblewrap and socat",
    );
  });

  it("sandbox1 AC-16: linux missing both tools, bwrap first", async () => {
    const exists = has();
    expect(await missingSandboxTools("linux", exists)).toEqual(["bwrap", "socat"]);
    expect(exists.mock.calls[0]?.[0]).toBe("bwrap");
    expect(plain(await sandboxReadiness("linux", exists))).toBe(
      "✖ missing bwrap, socat — Bash commands will fail; install bubblewrap and socat",
    );
  });

  it("sandbox1 AC-16: other platform is not checked", async () => {
    const exists = has();
    expect(await missingSandboxTools("win32", exists)).toEqual([]);
    expect(plain(await sandboxReadiness("win32", exists))).toBe(
      "? not checked on win32 — see Claude Code's sandbox docs",
    );
    expect(exists).not.toHaveBeenCalled();
  });
});
