import { describe, it, expect, vi, beforeEach } from "vitest";
import { KiroAdapter } from "../../src/providers/kiro.js";

vi.mock("../../src/utils/shell.js", () => ({
  commandExists: vi.fn(),
  runSilent: vi.fn(),
}));

import { commandExists } from "../../src/utils/shell.js";

describe("KiroAdapter", () => {
  let adapter: KiroAdapter;

  beforeEach(() => {
    adapter = new KiroAdapter();
    vi.clearAllMocks();
  });

  describe("detect", () => {
    it("detects when kiro is not installed", async () => {
      vi.mocked(commandExists).mockResolvedValue(false);

      const info = await adapter.detect();
      // Will be true/false depending on whether /Applications/Kiro.app exists
      expect(info.displayName).toBe("Kiro");
      expect(info.name).toBe("kiro");
    });
  });

  describe("generateAgentConfig", () => {
    it("generates .kiro/rules/ files", async () => {
      const agents = [
        {
          name: "Architect",
          role: "architect",
          providers: ["kiro"],
          systemPrompt: "You are an architect.",
          rules: ["Plan first"],
        },
      ];

      const files = await adapter.generateAgentConfig(agents, "/tmp/test");
      expect(files).toHaveLength(1);
      expect(files[0].path).toBe(".kiro/rules/architect.md");
      expect(files[0].content).toContain("# Architect");
      expect(files[0].content).toContain("You are an architect.");
    });

    it("skips agents not targeting kiro", async () => {
      const agents = [
        {
          name: "ClaudeOnly",
          providers: ["claude-code"],
          systemPrompt: "Claude agent",
        },
      ];

      const files = await adapter.generateAgentConfig(agents, "/tmp/test");
      expect(files).toHaveLength(0);
    });
  });
});
