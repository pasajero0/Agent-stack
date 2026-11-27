import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

describe("gitignore: local state and secrets (0.5.4)", () => {
  it("Q1: .gitignore has each of the five lines as a whole line", () => {
    const lines = readFileSync(new URL("../../.gitignore", import.meta.url), "utf8").split("\n");
    for (const line of [".env", ".env.*", "*.log", "coverage/", "/.claude/"]) {
      expect(lines).toContain(line);
    }
  });
});
