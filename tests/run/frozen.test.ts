import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, rmSync } from "node:fs";
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

  it("v04 AC-66: a check config that exists at the base and changed is a change, keyed by its content; a new one is not", () => {
    const { dir, base } = based({ "vitest.config.ts": "export default {};\n", ".github/workflows/ci.yml": "on: push\n", "pkg/x/.eslintrc.json": "{}\n" });
    write(dir, "vitest.config.ts", "export default { test: { exclude: ['**'] } };\n");
    write(dir, ".github/workflows/ci.yml", "on: workflow_dispatch\n");
    write(dir, "pkg/x/.eslintrc.json", '{"rules":{}}\n');
    write(dir, "jest.config.js", "module.exports = {};\n");
    const now = (p: string): string => sh(dir, "hash-object", "--", p).slice(0, 7);
    const first = testChanges(dir, base, GLOBS);
    expect(first).toEqual([
      `changed check config .github/workflows/ci.yml (now ${now(".github/workflows/ci.yml")})`,
      `changed check config pkg/x/.eslintrc.json (now ${now("pkg/x/.eslintrc.json")})`,
      `changed check config vitest.config.ts (now ${now("vitest.config.ts")})`,
    ]);
    // A later edit of the same config is a new change, so an allowed one cannot be rewritten for free.
    write(dir, "vitest.config.ts", "export default { test: { exclude: ['src/**'] } };\n");
    expect(testChanges(dir, base, GLOBS)[2]).not.toBe(first[2]);
  });

  it("v04 AC-66: with testGlobs empty only the check configs are compared; a deleted config says so", () => {
    const { dir, base } = based({ "src/a.test.ts": JS, "vitest.config.ts": "export default {};\n" });
    rmSync(join(dir, "src/a.test.ts"));
    rmSync(join(dir, "vitest.config.ts"));
    expect(testChanges(dir, base, [])).toEqual(["deleted check config vitest.config.ts"]);
  });

  it("v04 AC-66: .skip in code that is not a test call is no skip mark; describe.skipIf, this.skip and @unittest.skip are", () => {
    const { dir, base } = based({ "src/a.test.ts": JS, "tests/lib.rs": "fn f() { v.iter().skip(1); }\n", "tests/test_b.py": "def test_b():\n    assert 1\n" });
    write(dir, "src/a.test.ts", `${JS.replace('it("a"', 'it.skipIf(ci)("a"')}// cursor.skip(1); state.todo\n`);
    write(dir, "tests/lib.rs", "fn f() { v.iter().skip(1).skip(2); }\n");
    write(dir, "tests/test_b.py", "@unittest.skip\ndef test_b():\n    assert 1\n");
    expect(testChanges(dir, base, GLOBS)).toEqual(["src/a.test.ts: skip marks 0 → 1", "tests/test_b.py: skip marks 0 → 1"]);
  });

  it("v04 AC-66: Rust assert!, debug_assert! and unittest assertEqual are assertions", () => {
    const rs = "#[test]\nfn a() {\n    assert!(x);\n    debug_assert!(y);\n    assert_eq!(1, 1);\n}\n";
    const py = "def test_a(self):\n    self.assertEqual(1, 1)\n    self.assertTrue(x)\n";
    const { dir, base } = based({ "tests/a.rs": rs, "tests/test_a.py": py });
    write(dir, "tests/a.rs", "#[test]\nfn a() {\n    assert_eq!(1, 1);\n}\n");
    write(dir, "tests/test_a.py", "def test_a(self):\n    pass\n");
    expect(testChanges(dir, base, GLOBS)).toEqual(["tests/a.rs: assertions 3 → 1", "tests/test_a.py: assertions 2 → 0"]);
  });

  it("v04 AC-66: a test file that became a folder is replaced, not a crash; a file with a NUL byte is not counted", () => {
    const { dir, base } = based({ "tests/a.test.ts": JS, "tests/blob.bin": "a\0expect(1)\n" });
    rmSync(join(dir, "tests/a.test.ts"));
    mkdirSync(join(dir, "tests/a.test.ts"));
    write(dir, "tests/a.test.ts/x.txt", "x\n");
    write(dir, "tests/blob.bin", "b\0\n");
    expect(testChanges(dir, base, GLOBS)).toEqual(["replaced test file tests/a.test.ts"]);
  });
});
