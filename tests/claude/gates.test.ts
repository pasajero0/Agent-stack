import { describe, it, expect } from "vitest";
import { buildGatesConfig, monorepoDocsLayout } from "../../src/claude/gates.js";
import { PY_PARAMS, TS_PARAMS } from "../hooks/fixture.js";

describe("monorepoDocsLayout", () => {
  it("allows the docs dir, app and package READMEs, and the harness and forge folders", () => {
    expect(monorepoDocsLayout("docs/")).toEqual([
      "docs/*",
      "apps/*/README.md",
      "packages/*/README.md",
      "packages/*/CHANGELOG.md",
      ".claude/*",
      ".github/*",
    ]);
  });

  it("follows a custom docs dir", () => {
    expect(monorepoDocsLayout("documentation/")[0]).toBe("documentation/*");
  });
});

describe("buildGatesConfig docsLayout", () => {
  it("is the monorepo layout when the project is a monorepo", () => {
    expect(buildGatesConfig({ ...TS_PARAMS, monorepo: true }).docsLayout).toEqual(
      monorepoDocsLayout(TS_PARAMS.docsDir)
    );
  });

  it("is empty for a single-package project, whatever the stack", () => {
    expect(buildGatesConfig(TS_PARAMS).docsLayout).toEqual([]);
    expect(buildGatesConfig(PY_PARAMS).docsLayout).toEqual([]);
  });
});
