import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/utils/shell.js", () => ({
  commandExists: vi.fn(),
  run: vi.fn(),
  runSilent: vi.fn(),
}));

import { commandExists, runSilent } from "../../src/utils/shell.js";
import { detect } from "../../src/claude/provider.js";

describe("claude provider detect", () => {
  beforeEach(() => vi.clearAllMocks());

  it("detects when the claude CLI is installed", async () => {
    vi.mocked(commandExists).mockResolvedValue(true);
    vi.mocked(runSilent).mockResolvedValue({ stdout: "1.0.30", exitCode: 0 });

    const info = await detect();
    expect(info.installed).toBe(true);
    expect(info.version).toBe("1.0.30");
    expect(info.displayName).toBe("Claude Code");
  });

  it("detects when the claude CLI is not installed", async () => {
    vi.mocked(commandExists).mockResolvedValue(false);

    const info = await detect();
    expect(info.installed).toBe(false);
    expect(info.version).toBeUndefined();
  });
});
