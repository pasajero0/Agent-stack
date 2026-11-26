import { describe, it, expect } from "vitest";
import { buildSandboxBlock, detectedWritePaths, mergeSandbox, withDomains } from "../../src/claude/sandbox.js";

const BEFORE = { denyRead: [], allowedDomains: [], allowWrite: [] };
const settings = (writes: string[]): string =>
  JSON.stringify({ sandbox: buildSandboxBlock(["a.com"], writes) }, null, 2) + "\n";

describe("Q1: sandbox filesystem.allowWrite", () => {
  it("Q1: npm → ~/.npm", () => {
    expect(detectedWritePaths("npm")).toEqual(["~/.npm"]);
  });
  it("Q1: pnpm, yarn, bun → their cache paths", () => {
    expect(detectedWritePaths("pnpm")).toEqual([
      "~/Library/pnpm/store", "~/Library/Caches/pnpm", "~/.local/share/pnpm/store", "~/.cache/pnpm",
    ]);
    expect(detectedWritePaths("yarn")).toEqual(["~/Library/Caches/Yarn", "~/.cache/yarn", "~/.yarn/berry/cache"]);
    expect(detectedWritePaths("bun")).toEqual(["~/.bun/install/cache"]);
  });
  it("Q1: another package manager gets no allowWrite key", () => {
    expect(detectedWritePaths("uv")).toEqual([]);
    expect(buildSandboxBlock([], detectedWritePaths("uv")).filesystem).not.toHaveProperty("allowWrite");
  });
  it("Q1: withDomains keeps the allowWrite of the built block", () => {
    const out = JSON.parse(withDomains(settings(["~/.npm"]), ["b.com"])) as ReturnType<typeof JSON.parse>;
    expect(out.sandbox.filesystem.allowWrite).toEqual(["~/.npm"]);
    expect(out.sandbox.network.allowedDomains).toEqual(["b.com"]);
  });
  it("Q1: update adds the missing paths and keeps the user's entries", () => {
    const existing = JSON.stringify({ sandbox: { filesystem: { denyRead: [], allowWrite: ["/tmp/x"] } } });
    const out = JSON.parse(mergeSandbox(existing, settings(["~/.npm"]), BEFORE).content);
    expect(out.sandbox.filesystem.allowWrite).toEqual(["~/.npm", "/tmp/x"]);
  });
  it("Q1: update adds allowWrite when the user has none", () => {
    const existing = JSON.stringify({ sandbox: { filesystem: { denyRead: [] } } });
    const out = JSON.parse(mergeSandbox(existing, settings(["~/.npm"]), BEFORE).content);
    expect(out.sandbox.filesystem.allowWrite).toEqual(["~/.npm"]);
  });
});
