import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectHarnessParams,
  detectMonorepo,
  detectPackageManager,
  detectStack,
  detectStackFacts,
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

function project(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-stack-"));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return dir;
}

describe("detectStack", () => {
  it("recognises each supported stack by its manifest", () => {
    expect(detectStack(project({ "package.json": "{}" }))).toBe("node");
    expect(detectStack(project({ "pyproject.toml": "" }))).toBe("python");
    expect(detectStack(project({ "go.mod": "" }))).toBe("go");
    expect(detectStack(project({ "Cargo.toml": "" }))).toBe("rust");
    expect(detectStack(project({}))).toBe("unknown");
  });
});

describe("detectStackFacts", () => {
  it("node: scripts become commands, eslint becomes the per-file lint", () => {
    const dir = project({
      "package.json": JSON.stringify({
        scripts: { test: "vitest run", typecheck: "tsc" },
        devDependencies: { eslint: "9" },
      }),
      "pnpm-lock.yaml": "",
    });
    const f = detectStackFacts(dir, "node");
    expect(f.commands).toEqual(["pnpm typecheck", "pnpm test"]);
    expect(f.testCommand).toBe("pnpm test");
    expect(f.lintCommand).toBe("pnpm exec eslint --no-warn-ignored {file}");
    expect(f.lintMatch).toContain("*.ts");
    expect(f.complexityCommand).toContain('"complexity": ["error", 10]');
    expect(f.complexityCommand).toContain("{files}");
  });

  it("python: uv + pytest + ruff, no JS package-manager policing", () => {
    const dir = project({
      "pyproject.toml": '[tool.ruff]\n[project.optional-dependencies]\ndev = ["pytest"]\n',
      "uv.lock": "",
    });
    const f = detectStackFacts(dir, "python");
    expect(f.packageManager).toBe("uv");
    expect(f.forbiddenPms).toBe("");
    expect(f.testCommand).toBe("uv run pytest");
    expect(f.lintCommand).toBe("uv run ruff check {file}");
    expect(f.complexityCommand).toBe("uv run ruff check --select C901 --output-format json {files} | jq length");
  });

  it("unknown: falls back to make test, otherwise nothing", () => {
    expect(detectStackFacts(project({ Makefile: "test:\n\tgo test\n" }), "unknown").testCommand).toBe(
      "make test"
    );
    const empty = detectStackFacts(project({}), "unknown");
    expect(empty).toMatchObject({ packageManager: "", lockfile: "", commands: [], lintCommand: "" });
  });
});

describe("detectMonorepo", () => {
  it.each([
    ["pnpm-workspace.yaml", "packages:\n  - 'apps/*'\n"],
    ["go.work", "go 1.22\n"],
  ])("is true with a %s file", (name, content) => {
    expect(detectMonorepo(project({ [name]: content }))).toBe(true);
  });

  it.each(["apps", "packages"])("is true with a %s folder", (name) => {
    const dir = project({});
    mkdirSync(join(dir, name));
    expect(detectMonorepo(dir)).toBe(true);
  });

  it("is true for a Cargo workspace, false for a plain crate", () => {
    expect(detectMonorepo(project({ "Cargo.toml": '[package]\nname = "x"\n\n[workspace]\nmembers = ["a"]\n' }))).toBe(true);
    expect(detectMonorepo(project({ "Cargo.toml": '[package]\nname = "x"\n' }))).toBe(false);
  });

  it("is true when package.json has a workspaces key", () => {
    expect(detectMonorepo(project({ "package.json": JSON.stringify({ workspaces: ["apps/*"] }) }))).toBe(true);
  });

  it("is false for a single package, an empty dir, and an unparseable package.json", () => {
    expect(detectMonorepo(project({ "package.json": "{}" }))).toBe(false);
    expect(detectMonorepo(project({}))).toBe(false);
    expect(detectMonorepo(project({ "package.json": "{ not json" }))).toBe(false);
  });

  it("detectHarnessParams sets the monorepo flag", async () => {
    expect((await detectHarnessParams(project({ "package.json": "{}" }))).monorepo).toBe(false);
    expect((await detectHarnessParams(project({ "pnpm-workspace.yaml": "" }))).monorepo).toBe(true);
  });
});
