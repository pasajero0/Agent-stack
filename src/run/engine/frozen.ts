/**
 * Frozen tests, check configs and package manifests: what a task may not weaken without the human. Spec:
 * docs/specs/v04/SPEC.md, Terms "Frozen tests", "Check config", "Package manifest"; AC-66. Deterministic
 * comparisons against the task's base, no model.
 */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, posix } from "node:path";
import { globMatch } from "../checks.js";
import { existsOnRef, git, taskDiffPaths } from "../git.js";
import type { RunTask } from "../types.js";
import { SKIPS_REGEX } from "./skip-marks.js";

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
  "pnpm-workspace.yaml",
];

// `(?<![.\w])` keeps `re.test(` and `submit(` out of the test count.
const TESTS = /(?<![.\w])(?:it|test)(?:\.\w+)*\s*\(|\bdef\s+test_|\bfunc\s+Test|#\[test\]/g;
const ASSERTIONS = /\bexpect\s*\(|\b(?:debug_)?assert(?:_\w+|\.\w+|[A-Z]\w*)?!?\s*[\s(]|\bt\.(?:Errorf?|Fatalf?)\s*\(/g;
// The skip marks are one list, shared with cheat-guard (skip-marks.ts).
export const SKIPS = SKIPS_REGEX;

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

/**
 * Test runner configs, the only check configs whose change can pass as "adds new test files only". Not CI
 * workflows: a new step can run any command, one that removes tests too, so code cannot judge it.
 */
const TEST_RUNNER_CONFIGS: readonly string[] = ["vitest.config.*", "vitest.workspace.*", "jest.config.*", "playwright.config.*"];

const isTestRunnerConfig = (path: string): boolean => TEST_RUNNER_CONFIGS.some((g) => globMatch(g, basename(path)));

/** One quoted string, no escapes; its text, or null. */
const QUOTED = /^(?:"([^"\\]*)"|'([^'\\]*)'|`([^`\\$]*)`)$/;
const GLOB_CHARS = /[*?[\]{}!]/;

/**
 * The new test files a test runner config at `path` lists, when its change since `base` only adds them: no
 * base line removed, and every added line, trimmed and without one trailing comma, is one quoted path with no
 * glob character, of a test file that did not exist at the base and is a regular file now. Null otherwise.
 * Paths in a config are relative to its folder.
 */
function listsNewTests(dir: string, base: string, path: string, testGlobs: string[]): string[] | null {
  if (!isTestRunnerConfig(path) || kindOf(join(dir, path)) !== "file") return null;
  const before = git(dir, ["show", `${base}:${path}`]).stdout.split("\n");
  const now = readFileSync(join(dir, path), "utf8").split("\n");
  // No base line removed: the base lines are a subsequence of the lines now; the others are added.
  const added: string[] = [];
  let i = 0;
  for (const line of now) {
    if (i < before.length && line === before[i]) i++;
    else added.push(line);
  }
  if (i < before.length || added.length === 0) return null;
  const files: string[] = [];
  for (const line of added) {
    let t = line.trim();
    if (t.endsWith(",")) t = t.slice(0, -1).trimEnd();
    const m = QUOTED.exec(t);
    const s = m === null ? undefined : (m[1] ?? m[2] ?? m[3]);
    if (s === undefined || s === "" || GLOB_CHARS.test(s) || isAbsolute(s)) return null;
    const p = posix.normalize(posix.join(posix.dirname(path), s));
    if (p === ".." || p.startsWith("../")) return null;
    if (!isTestFile(testGlobs, p) || existsOnRef(dir, base, p) || kindOf(join(dir, p)) !== "file") return null;
    files.push(p);
  }
  return files;
}

/** The check configs at the base the task changed, with the new test files the ones that only add them list. */
function changedConfigs(dir: string, base: string, testGlobs: string[], paths: string[]): { path: string; files: string[] | null }[] {
  return paths.filter(isCheckConfig).map((p) => ({ path: p, files: listsNewTests(dir, base, p, testGlobs) }));
}

/** The dependency entries of a package manifest, as key paths. */
const DEP_SECTIONS: readonly (readonly string[])[] = [
  ["dependencies"],
  ["devDependencies"],
  ["optionalDependencies"],
  ["peerDependencies"],
  ["overrides"],
  ["resolutions"],
  ["pnpm", "overrides"],
];

/** Check settings a package manifest can hold instead of a config file. */
const SETTINGS: readonly string[] = ["jest", "eslintConfig", "mocha", "ava"];

/** Longest manifest value shown in a change line; a longer one is cut and keyed by its hash. */
const SHOWN = 80;

const isManifest = (path: string): boolean => basename(path) === "package.json";

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function parseObject(text: string): Record<string, unknown> | null {
  try {
    const v: unknown = JSON.parse(text);
    return isRecord(v) ? v : null;
  } catch {
    return null;
  }
}

function section(o: Record<string, unknown>, path: readonly string[]): Record<string, unknown> {
  let cur: unknown = o;
  for (const k of path) cur = isRecord(cur) ? cur[k] : undefined;
  return isRecord(cur) ? cur : {};
}

const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

const hash7 = (s: string): string => createHash("sha1").update(s).digest("hex").slice(0, 7);

/**
 * Text for a change line that stays keyed by content (AC-66): a text that is cut, or that holds a control
 * character (a newline or an ANSI sequence could hide or fake a line), ends with its hash.
 */
function safe(s: string, max: number): string {
  // eslint-disable-next-line no-control-regex -- control characters are what is replaced.
  const clean = s.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
  if (clean === s && s.length <= max) return s;
  return `${clean.slice(0, max)}… ${hash7(s)}`;
}

/** A manifest value for a change line. */
const shown = (v: unknown): string => safe(typeof v === "string" ? v : JSON.stringify(v), SHOWN);

/** A name or a path in a change line: never cut, but cleaned. */
const named = (s: string): string => safe(s, Number.MAX_SAFE_INTEGER);

/**
 * What changed in one package manifest: base scripts changed or removed, dependency entries added or changed,
 * check settings added, changed or removed.
 */
function manifestChanges(dir: string, base: string, path: string): string[] {
  const where = named(path);
  const nowText = kindOf(join(dir, path)) === "file" ? readFileSync(join(dir, path), "utf8") : "{}";
  const now = parseObject(nowText);
  if (now === null) return [`${where} is not valid JSON (now ${git(dir, ["hash-object", "--", path]).stdout.trim().slice(0, 7)})`];
  // A manifest the task adds compares with an empty one, so its dependencies are new.
  const before = (existsOnRef(dir, base, path) ? parseObject(git(dir, ["show", `${base}:${path}`]).stdout) : null) ?? {};
  const out: string[] = [];
  const was = section(before, ["scripts"]);
  const is = section(now, ["scripts"]);
  for (const [name, value] of Object.entries(was)) {
    if (!Object.hasOwn(is, name)) out.push(`deleted script ${named(name)} in ${where}`);
    else if (!same(is[name], value)) out.push(`changed script ${named(name)} in ${where} (now: ${shown(is[name])})`);
  }
  for (const key of DEP_SECTIONS) {
    const b = section(before, key);
    const n = section(now, key);
    for (const [name, value] of Object.entries(n)) {
      if (!Object.hasOwn(b, name)) out.push(`new dependency ${named(name)} in ${where} (${key.join(".")}: ${shown(value)})`);
      else if (!same(b[name], value)) out.push(`changed dependency ${named(name)} in ${where} (${key.join(".")}: ${shown(b[name])} → ${shown(value)})`);
    }
  }
  for (const key of SETTINGS) {
    const had = Object.hasOwn(before, key);
    const has = Object.hasOwn(now, key);
    if (had && !has) out.push(`deleted setting ${key} in ${where}`);
    else if (has && !same(before[key], now[key])) out.push(`changed setting ${key} in ${where} (now ${hash7(JSON.stringify(now[key]))})`);
  }
  return out;
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
 * The changes since `base` to frozen tests (files matching `testGlobs` at the base), to check configs that
 * exist at the base and to package manifests, each as one line (AC-66). Only files in the task diff can have
 * changed.
 */
export function testChanges(dir: string, base: string, testGlobs: string[]): string[] {
  const diff = taskDiffPaths(dir, base);
  // Filtered before `existsOnRef`, which is one git process per path.
  const paths = diff.filter((p) => (isTestFile(testGlobs, p) || isCheckConfig(p)) && existsOnRef(dir, base, p));
  const out: string[] = [];
  for (const p of paths) {
    if (!isTestFile(testGlobs, p)) continue;
    const kind = kindOf(join(dir, p));
    if (kind !== "file") {
      out.push(`${kind === "gone" ? "deleted" : "replaced"} test file ${named(p)}`);
      continue;
    }
    const before = git(dir, ["show", `${base}:${p}`]).stdout;
    const now = readFileSync(join(dir, p), "utf8");
    // A binary fixture is not counted.
    if (!before.includes("\0") && !now.includes("\0")) out.push(...weakened(named(p), before, now));
  }
  for (const { path: p, files } of changedConfigs(dir, base, testGlobs, paths)) {
    // A test runner config that only lists new test files cannot weaken a check that existed (defect 58).
    if (files !== null) continue;
    // Keyed by content: a later edit of an allowed config is a new change (AC-66).
    if (kindOf(join(dir, p)) === "gone") out.push(`deleted check config ${named(p)}`);
    else out.push(`changed check config ${named(p)} (now ${git(dir, ["hash-object", "--", p]).stdout.trim().slice(0, 7)})`);
  }
  for (const p of diff) if (isManifest(p)) out.push(...manifestChanges(dir, base, p));
  return out;
}

/**
 * The test runner configs whose change since `base` only lists new test files, one line per config for the
 * human: testChanges reports them as nothing (defect 58).
 */
export function passedConfigChanges(dir: string, base: string, testGlobs: string[]): string[] {
  const paths = taskDiffPaths(dir, base).filter((p) => isTestRunnerConfig(p) && existsOnRef(dir, base, p));
  return changedConfigs(dir, base, testGlobs, paths).flatMap(({ path, files }) =>
    files === null ? [] : [`test config change passed: ${named(path)} lists new test file(s) ${files.map(named).join(", ")}`],
  );
}

/** The task's changes the human has not allowed (AC-66). */
export function newChanges(dir: string, task: RunTask, testGlobs: string[]): string[] {
  if (task.taskBase === null) return [];
  return testChanges(dir, task.taskBase, testGlobs).filter((c) => !task.allowedChanges.includes(c));
}

/** The task's test runner config changes that passed without a stop (defect 58). */
export function newPassedChanges(dir: string, task: RunTask, testGlobs: string[]): string[] {
  return task.taskBase === null ? [] : passedConfigChanges(dir, task.taskBase, testGlobs);
}

/** The feedback and gate text for the changes (AC-66). */
export function testChangesText(changes: string[]): string {
  return [
    "The task weakened tests it found, or changed a check config, a script or a dependency. Restore them, or return TEST_CONFLICT if a test is wrong:",
    ...changes.map((c) => `- ${c}`),
  ].join("\n");
}
