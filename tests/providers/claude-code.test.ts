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

  describe("generateAgentConfig", () => {
    it("generates CLAUDE.md from agent definitions", async () => {
      const agents = [
        {
          name: "Architect",
          role: "architect",
          providers: ["claude-code"],
          systemPrompt: "You are an architect.",
          rules: ["Read code first", "Plan before coding"],
        },
      ];

      const files = await adapter.generateAgentConfig(agents, "/tmp/test");
      expect(files).toHaveLength(1);
      expect(files[0].path).toBe("CLAUDE.md");
      expect(files[0].content).toContain("## Architect");
      expect(files[0].content).toContain("You are an architect.");
      expect(files[0].content).toContain("- Read code first");
    });

    it("skips agents not targeting claude-code", async () => {
      const agents = [
        {
          name: "OtherOnly",
          providers: ["other-provider"],
          systemPrompt: "Non-Claude agent",
        },
      ];

      const files = await adapter.generateAgentConfig(agents, "/tmp/test");
      expect(files).toHaveLength(0);
    });

    it("includes agents with no provider restriction", async () => {
      const agents = [
        {
          name: "Universal",
          systemPrompt: "Works everywhere",
        },
      ];

      const files = await adapter.generateAgentConfig(agents, "/tmp/test");
      expect(files).toHaveLength(1);
    });
  });
});
