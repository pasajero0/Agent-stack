import { describe, it, expect, vi, beforeEach } from "vitest";
import { ClaudeCodeAdapter } from "../../src/providers/claude-code.js";

vi.mock("../../src/utils/shell.js", () => ({
  commandExists: vi.fn(),
  run: vi.fn(),
  runSilent: vi.fn(),
}));

import { commandExists, runSilent } from "../../src/utils/shell.js";

describe("ClaudeCodeAdapter", () => {
  let adapter: ClaudeCodeAdapter;

  beforeEach(() => {
    adapter = new ClaudeCodeAdapter();
    vi.clearAllMocks();
  });

  describe("detect", () => {
    it("detects when claude CLI is installed", async () => {
      vi.mocked(commandExists).mockResolvedValue(true);
      vi.mocked(runSilent).mockResolvedValue({
        stdout: "1.0.30",
        exitCode: 0,
      });

      const info = await adapter.detect();
      expect(info.installed).toBe(true);
      expect(info.version).toBe("1.0.30");
      expect(info.displayName).toBe("Claude Code");
    });

    it("detects when claude CLI is not installed", async () => {
      vi.mocked(commandExists).mockResolvedValue(false);

      const info = await adapter.detect();
      expect(info.installed).toBe(false);
      expect(info.version).toBeUndefined();
    });
  });

});
