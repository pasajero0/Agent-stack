import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectProject } from "../../src/detect/project.js";

const TEST_DIR = join(tmpdir(), "agent-stack-test-" + Date.now());

function setup(files: Record<string, string> = {}, dirs: string[] = []) {
  mkdirSync(TEST_DIR, { recursive: true });
  for (const dir of dirs) {
    mkdirSync(join(TEST_DIR, dir), { recursive: true });
  }
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(TEST_DIR, name), content);
  }
}

function cleanup() {
  rmSync(TEST_DIR, { recursive: true, force: true });
}

describe("detectProject", () => {
  afterEach(cleanup);

  it("returns empty scenario for bare directory", async () => {
    setup();
    const ctx = await detectProject(TEST_DIR);
    expect(ctx.scenario).toBe("empty");
    expect(ctx.isExistingProject).toBe(false);
    expect(ctx.hasPackageJson).toBe(false);
    expect(ctx.hasSrcDir).toBe(false);
    expect(ctx.hasGitRepo).toBe(false);
    expect(ctx.projectName).toBeUndefined();
  });

  it("detects existing project with package.json", async () => {
    setup({ "package.json": '{"name": "my-app"}' });
    const ctx = await detectProject(TEST_DIR);
    expect(ctx.scenario).toBe("existing");
    expect(ctx.isExistingProject).toBe(true);
    expect(ctx.hasPackageJson).toBe(true);
    expect(ctx.projectName).toBe("my-app");
  });

  it("detects existing project with src/ directory", async () => {
    setup({}, ["src"]);
    const ctx = await detectProject(TEST_DIR);
    expect(ctx.scenario).toBe("existing");
    expect(ctx.hasSrcDir).toBe(true);
  });

  it("detects existing project with .git", async () => {
    setup({}, [".git"]);
    const ctx = await detectProject(TEST_DIR);
    expect(ctx.scenario).toBe("existing");
    expect(ctx.hasGitRepo).toBe(true);
  });

  it("detects multiple signals", async () => {
    setup({ "package.json": '{"name": "full-project"}' }, ["src", ".git"]);
    const ctx = await detectProject(TEST_DIR);
    expect(ctx.scenario).toBe("existing");
    expect(ctx.hasPackageJson).toBe(true);
    expect(ctx.hasSrcDir).toBe(true);
    expect(ctx.hasGitRepo).toBe(true);
    expect(ctx.projectName).toBe("full-project");
  });

  it("handles malformed package.json gracefully", async () => {
    setup({ "package.json": "not json" });
    const ctx = await detectProject(TEST_DIR);
    expect(ctx.scenario).toBe("existing");
    expect(ctx.hasPackageJson).toBe(true);
    expect(ctx.projectName).toBeUndefined();
  });
});
