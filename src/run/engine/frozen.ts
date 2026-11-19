/**
 * Frozen tests and check configs: what a task may not weaken without the human. Spec: docs/specs/v04/SPEC.md,
 * Terms "Frozen tests", "Check config"; AC-66. Deterministic counts against the task's base, no model.
 */
import { existsSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { globMatch } from "../checks.js";
import { existsOnRef, git, taskDiffPaths } from "../git.js";

/** Check configs; a pattern with `/` matches the whole path, any other the file name in any folder. */
const CHECK_CONFIGS: readonly string[] = [
  ".github/workflows/*",
  ".gitlab-ci.yml",
  "vitest.config.*",
  "vitest.workspace.*",
  "jest.config.*",
  "playwright.config.*",
  "eslint.config.*",
  ".eslintrc*",
  "biome.json",
  "biome.jsonc",
  "pytest.ini",
  "tox.ini",
  "ruff.toml",
  ".ruff.toml",
  ".golangci.*",
  "clippy.toml",
];

// `(?<![.\w])` keeps `re.test(` and `submit(` out of the test count.
const TESTS = /(?<![.\w])(?:it|test)(?:\.\w+)*\s*\(|\bdef\s+test_|\bfunc\s+Test|#\[test\]/g;
const ASSERTIONS = /\bexpect\s*\(|\bassert(?:_\w+!?|\.\w+)?[\s(]|\bt\.(?:Errorf?|Fatalf?)\s*\(/g;
const SKIPS = /\.(?:skip|only|todo)\b|(?<![.\w])x(?:it|describe|test)\s*\(|@pytest\.mark\.(?:skip|xfail)|\bt\.Skip\w*\s*\(|#\[ignore\]/g;

const count = (text: string, re: RegExp): number => (text.match(re) ?? []).length;

function isCheckConfig(path: string): boolean {
  return CHECK_CONFIGS.some((g) => globMatch(g, g.includes("/") ? path : basename(path)));
}

/** What weakened one frozen test file: fewer tests or assertions, more skip marks. */
function weakened(path: string, before: string, now: string): string[] {
  const out: string[] = [];
  for (const [name, re] of [["tests", TESTS], ["assertions", ASSERTIONS]] as const) {
    const b = count(before, re);
    const n = count(now, re);
    if (n < b) out.push(`${path}: ${name} ${b} → ${n}`);
  }
  const b = count(before, SKIPS);
  const n = count(now, SKIPS);
  if (n > b) out.push(`${path}: skip marks ${b} → ${n}`);
  return out;
}

/**
 * The changes since `base` to frozen tests (files matching `testGlobs` at the base) and to check configs that
 * exist at the base, each as one line (AC-66). Only files in the task diff can have changed.
 */
export function testChanges(dir: string, base: string, testGlobs: string[]): string[] {
  const paths = taskDiffPaths(dir, base).filter((p) => existsOnRef(dir, base, p));
  const out: string[] = [];
  for (const p of paths) {
    if (!testGlobs.some((g) => globMatch(g, p))) continue;
    if (!existsSync(join(dir, p))) {
      out.push(`deleted test file ${p}`);
      continue;
    }
    out.push(...weakened(p, git(dir, ["show", `${base}:${p}`]).stdout, readFileSync(join(dir, p), "utf8")));
  }
  for (const p of paths) if (isCheckConfig(p)) out.push(`changed check config ${p}`);
  return out;
}

/** The feedback and gate text for the changes (AC-66). */
export function testChangesText(changes: string[]): string {
  return [
    "The task weakened tests it found, or changed a check config. Restore them, or return TEST_CONFLICT if a test is wrong:",
    ...changes.map((c) => `- ${c}`),
  ].join("\n");
}
