import { afterEach, describe, expect, it } from "vitest";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { cleanupProjects, git, write } from "../hooks/fixture.js";
import { testChanges } from "../../src/run/engine/frozen.js";
import { repo, sh } from "./engine-fixture.js";

afterEach(() => cleanupProjects());

const GLOBS = ["*.test.*", "tests/*"];
const JS = 'it("a", () => {\n  expect(1).toBe(1);\n  expect(2).toBe(2);\n});\ntest("b", () => {\n  expect(3).toBe(3);\n});\n';

/** A repo whose base commit holds `files`; returns the dir and the base sha. */
function based(files: Record<string, string>): { dir: string; base: string } {
  const { dir } = repo();
  for (const [p, c] of Object.entries(files)) write(dir, p, c);
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "test: base");
  return { dir, base: sh(dir, "rev-parse", "HEAD") };
}

describe("frozen tests and check configs (AC-66)", () => {
  it("v04 AC-66: a deleted test file is a change", () => {
    const { dir, base } = based({ "src/a.test.ts": JS });
    rmSync(join(dir, "src/a.test.ts"));
    expect(testChanges(dir, base, GLOBS)).toEqual(["deleted test file src/a.test.ts"]);
  });

  it("v04 AC-66: fewer tests, fewer assertions and more skip marks are changes", () => {
    const { dir, base } = based({ "src/a.test.ts": JS });
    write(dir, "src/a.test.ts", 'it.skip("a", () => {\n  expect(1).toBe(1);\n});\n');
    expect(testChanges(dir, base, GLOBS)).toEqual([
      "src/a.test.ts: tests 2 → 1",
      "src/a.test.ts: assertions 3 → 1",
      "src/a.test.ts: skip marks 0 → 1",
    ]);
  });

  it("v04 AC-66: Python tests and asserts are counted too", () => {
    const { dir, base } = based({ "tests/test_a.py": "def test_a():\n    assert 1 == 1\n    assert 2 == 2\n" });
    write(dir, "tests/test_a.py", "def test_a():\n    assert 1 == 1\n");
    expect(testChanges(dir, base, GLOBS)).toEqual(["tests/test_a.py: assertions 2 → 1"]);
  });

  it("v04 AC-66: added tests, a new test file, a code change and `re.test(` are no change", () => {
    const { dir, base } = based({ "src/a.test.ts": JS, "src/a.ts": "export const a = /x/.test('x');\n" });
    write(dir, "src/a.test.ts", `${JS}it("c", () => {\n  expect(4).toBe(4);\n});\n`);
    write(dir, "src/b.test.ts", JS);
    write(dir, "src/a.ts", "export const a = 2;\n");
    expect(testChanges(dir, base, GLOBS)).toEqual([]);
  });

  it("v04 AC-66: a check config that exists at the base and changed is a change; a new one is not", () => {
    const { dir, base } = based({ "vitest.config.ts": "export default {};\n", ".github/workflows/ci.yml": "on: push\n", "pkg/x/.eslintrc.json": "{}\n" });
    write(dir, "vitest.config.ts", "export default { test: { exclude: ['**'] } };\n");
    write(dir, ".github/workflows/ci.yml", "on: workflow_dispatch\n");
    write(dir, "pkg/x/.eslintrc.json", '{"rules":{}}\n');
    write(dir, "jest.config.js", "module.exports = {};\n");
    expect(testChanges(dir, base, GLOBS)).toEqual([
      "changed check config .github/workflows/ci.yml",
      "changed check config pkg/x/.eslintrc.json",
      "changed check config vitest.config.ts",
    ]);
  });

  it("v04 AC-66: with testGlobs empty only the check configs are compared", () => {
    const { dir, base } = based({ "src/a.test.ts": JS, "vitest.config.ts": "export default {};\n" });
    rmSync(join(dir, "src/a.test.ts"));
    rmSync(join(dir, "vitest.config.ts"));
    expect(testChanges(dir, base, [])).toEqual(["changed check config vitest.config.ts"]);
  });
});
