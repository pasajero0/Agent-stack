import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectPackageManager,
  forbiddenPmsFor,
  forgeFromRemote,
} from "../../src/detect/harness-params.js";

describe("forbiddenPmsFor", () => {
  it("excludes the active package manager", () => {
    expect(forbiddenPmsFor("pnpm")).toBe("npm|yarn|bun");
    expect(forbiddenPmsFor("npm")).toBe("yarn|pnpm|bun");
  });
});

describe("forgeFromRemote", () => {
  it("maps gitlab to glab, everything else to gh", () => {
    expect(forgeFromRemote("git@gitlab.com:acme/x.git")).toBe("glab");
    expect(forgeFromRemote("https://github.com/acme/x.git")).toBe("gh");
    expect(forgeFromRemote("")).toBe("gh");
  });
});

describe("detectPackageManager", () => {
  it("detects pnpm from its lockfile", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-stack-"));
    writeFileSync(join(dir, "pnpm-lock.yaml"), "");
    expect(detectPackageManager(dir)).toEqual({
      packageManager: "pnpm",
      lockfile: "pnpm-lock.yaml",
    });
  });

  it("defaults to npm when no lockfile is present", () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-stack-"));
    expect(detectPackageManager(dir).packageManager).toBe("npm");
  });
});
