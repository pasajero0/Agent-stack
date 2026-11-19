/**
 * Frozen tests and check configs: what a task may not weaken without the human. Spec: docs/specs/v04/SPEC.md,
 * Terms "Frozen tests", "Check config"; AC-66. Deterministic counts against the task's base, no model.
 */
import { lstatSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { globMatch } from "../checks.js";
import { existsOnRef, git, taskDiffPaths } from "../git.js";
import type { RunTask } from "../types.js";

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
const ASSERTIONS = /\bexpect\s*\(|\b(?:debug_)?assert(?:_\w+|\.\w+|[A-Z]\w*)?!?\s*[\s(]|\bt\.(?:Errorf?|Fatalf?)\s*\(/g;
// Only after a test call, so `iter().skip(1)` or `cursor.skip(n)` is not one.
const SKIPS =
  /(?<![.\w])(?:it|test|describe|suite|context|bench)\.(?:skip|only|todo)\w*|(?<![.\w])x(?:it|describe|test)\s*\(|\bthis\.skip\s*\(|\bpytest\.skip\s*\(|@pytest\.mark\.(?:skip|xfail)|@unittest\.skip|\bt\.Skip\w*\s*\(|#\[ignore\]/g;

const count = (text: string, re: RegExp): number => (text.match(re) ?? []).length;

const isTestFile = (globs: string[], p: string): boolean => globs.some((g) => globMatch(g, p));

/** The kind of what is at `path` now: gone, a regular file, or something else (a folder, a submodule). */
function kindOf(path: string): "gone" | "file" | "other" {
  try {
    return lstatSync(path).isFile() ? "file" : "other";
  } catch {
    return "gone";
  }
}

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
  // Filtered before `existsOnRef`, which is one git process per path.
  const paths = taskDiffPaths(dir, base).filter((p) => (isTestFile(testGlobs, p) || isCheckConfig(p)) && existsOnRef(dir, base, p));
  const out: string[] = [];
  for (const p of paths) {
    if (!isTestFile(testGlobs, p)) continue;
    const kind = kindOf(join(dir, p));
    if (kind !== "file") {
      out.push(`${kind === "gone" ? "deleted" : "replaced"} test file ${p}`);
      continue;
    }
    const before = git(dir, ["show", `${base}:${p}`]).stdout;
    const now = readFileSync(join(dir, p), "utf8");
    // A binary fixture is not counted.
    if (!before.includes("\0") && !now.includes("\0")) out.push(...weakened(p, before, now));
  }
  for (const p of paths) {
    if (!isCheckConfig(p)) continue;
    // Keyed by content: a later edit of an allowed config is a new change (AC-66).
    if (kindOf(join(dir, p)) === "gone") out.push(`deleted check config ${p}`);
    else out.push(`changed check config ${p} (now ${git(dir, ["hash-object", "--", p]).stdout.trim().slice(0, 7)})`);
  }
  return out;
}

/** The task's changes the human has not allowed (AC-66). */
export function newChanges(dir: string, task: RunTask, testGlobs: string[]): string[] {
  if (task.taskBase === null) return [];
  return testChanges(dir, task.taskBase, testGlobs).filter((c) => !task.allowedChanges.includes(c));
}

/** The feedback and gate text for the changes (AC-66). */
export function testChangesText(changes: string[]): string {
  return [
    "The task weakened tests it found, or changed a check config. Restore them, or return TEST_CONFLICT if a test is wrong:",
    ...changes.map((c) => `- ${c}`),
  ].join("\n");
}
