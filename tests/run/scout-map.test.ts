/**
 * scout1: the driver's entry checks on the scout's map entries.
 * Spec: docs/specs/scout1/SPEC.md (Contract "Entry checks"; AC-12, AC-21).
 */
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkEntries, type ScoutItem } from "../../src/run/engine/steps-scout.js";
import { validateOutput } from "../../src/run/schemas.js";

const dirs: string[] = [];
const tempDir = (prefix: string): string => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
};

/** The AC-12 project: src/run/routing.ts, docs/specs/effort1/, .git/config, and `link` → .git/config. */
let project = "";
/** A second project for checks beyond the examples table (outside and dangling symlinks). */
let extra = "";
/** A project with 150 files f0.ts … f149.ts (AC-21). */
let many = "";
let outside = "";

beforeAll(() => {
  project = tempDir("scout-map-");
  mkdirSync(join(project, "src/run"), { recursive: true });
  writeFileSync(join(project, "src/run/routing.ts"), "export {};\n");
  mkdirSync(join(project, "docs/specs/effort1"), { recursive: true });
  mkdirSync(join(project, ".git"));
  writeFileSync(join(project, ".git/config"), "[core]\n");
  symlinkSync(".git/config", join(project, "link"));

  outside = tempDir("scout-outside-");
  writeFileSync(join(outside, "secret.txt"), "x\n");
  extra = tempDir("scout-extra-");
  writeFileSync(join(extra, "a.ts"), "a\n");
  mkdirSync(join(extra, ".git"));
  writeFileSync(join(extra, ".git/HEAD"), "ref\n");
  symlinkSync(join(outside, "secret.txt"), join(extra, "out"));
  symlinkSync(outside, join(extra, "outdir"));
  symlinkSync("no-such-target", join(extra, "dangling"));
  symlinkSync(".", join(extra, "self"));

  many = tempDir("scout-many-");
  for (let i = 0; i < 150; i++) writeFileSync(join(many, `f${i}.ts`), "x\n");
});

afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const item = (path: string, lines?: string, why = "why"): ScoutItem => (lines === undefined ? { path, why } : { path, lines, why });
/** The entry line text of a kept entry: `<path>` or `<path>:<range>`. */
const shown = (e: { path: string; range?: string }): string => (e.range === undefined ? e.path : `${e.path}:${e.range}`);

describe("entry checks: the Contract's examples table (scout1 AC-12)", () => {
  it("scout1 AC-12: the whole table in order gives the three kept entries and drops the rest", () => {
    const items = [
      item("src/run/routing.ts", "5-5"),
      item("./docs/specs/effort1/", "10-20"),
      item("src/run/routing.ts", " 5 "),
      item("src/run/routing.ts", "20-10"),
      item("/etc/passwd"),
      item("../x"),
      item("."),
      item("./"),
      item("/"),
      item("link"),
      item("src/no-such-file.ts"),
    ];
    const r = checkEntries(items, project);
    expect(r.kept.map(shown)).toEqual(["src/run/routing.ts:5", "docs/specs/effort1", "src/run/routing.ts"]);
    expect(r.dropped).toBe(8);
  });

  it("scout1 AC-12: `src/run/routing.ts`, \"5-5\" is kept as src/run/routing.ts:5", () => {
    const r = checkEntries([item("src/run/routing.ts", "5-5")], project);
    expect(r.kept.map(shown)).toEqual(["src/run/routing.ts:5"]);
    expect(r.dropped).toBe(0);
  });

  it("scout1 AC-12: `./docs/specs/effort1/`, \"10-20\" is kept as docs/specs/effort1 (a folder: no range)", () => {
    const r = checkEntries([item("./docs/specs/effort1/", "10-20")], project);
    expect(r.kept).toHaveLength(1);
    expect(r.kept[0]?.path).toBe("docs/specs/effort1");
    expect(r.kept[0]?.range).toBeUndefined();
  });

  it("scout1 AC-12: `src/run/routing.ts`, \" 5 \" after \"5-5\" is dropped as the same path and range", () => {
    const r = checkEntries([item("src/run/routing.ts", "5-5"), item("src/run/routing.ts", " 5 ")], project);
    expect(r.kept.map(shown)).toEqual(["src/run/routing.ts:5"]);
    expect(r.dropped).toBe(1);
  });

  it("scout1 AC-12: `src/run/routing.ts`, \"20-10\" is kept without a range (bad range)", () => {
    const r = checkEntries([item("src/run/routing.ts", "20-10")], project);
    expect(r.kept.map(shown)).toEqual(["src/run/routing.ts"]);
    expect(r.dropped).toBe(0);
  });

  it("scout1 AC-12: /etc/passwd, ../x, ., ./ and / are dropped", () => {
    for (const p of ["/etc/passwd", "../x", ".", "./", "/"]) {
      const r = checkEntries([item(p)], project);
      expect(r.kept, p).toEqual([]);
      expect(r.dropped, p).toBe(1);
    }
  });

  it("scout1 AC-12: `link` (a symlink to .git/config) is dropped: its real path is under .git/", () => {
    const r = checkEntries([item("link")], project);
    expect(r.kept).toEqual([]);
    expect(r.dropped).toBe(1);
  });

  it("scout1 AC-12: `src/no-such-file.ts` is dropped: it does not exist", () => {
    const r = checkEntries([item("src/no-such-file.ts")], project);
    expect(r.kept).toEqual([]);
    expect(r.dropped).toBe(1);
  });
});

describe("entry checks: a bad `lines` never drops an entry (scout1 AC-12)", () => {
  it("scout1 AC-12: each bad lines keeps the entry without a range", () => {
    const bad = ["", "  ", "abc", "0", "0-3", "5-", "-5", "3-0", "1-2-3", "12345678", "1-12345678", "5 - 9", "05", "1,3", "20-10"];
    for (const lines of bad) {
      const r = checkEntries([item("src/run/routing.ts", lines)], project);
      expect(r.kept.map(shown), JSON.stringify(lines)).toEqual(["src/run/routing.ts"]);
      expect(r.dropped, JSON.stringify(lines)).toBe(0);
    }
  });

  it("scout1 AC-12: good ranges are kept as <a> or <a>-<b>, trimmed", () => {
    const cases: [string, string][] = [
      ["7", "7"],
      [" 3-9 ", "3-9"],
      ["9-9", "9"],
      ["1-9999999", "1-9999999"],
    ];
    for (const [lines, range] of cases) {
      const r = checkEntries([item("src/run/routing.ts", lines)], project);
      expect(r.kept.map(shown), lines).toEqual([`src/run/routing.ts:${range}`]);
    }
  });

  it("scout1 AC-12: step 8 still applies to an entry whose bad lines gave no range", () => {
    const r = checkEntries([item("src/run/routing.ts"), item("src/run/routing.ts", "x"), item("./src/run/routing.ts", "9-1")], project);
    expect(r.kept.map(shown)).toEqual(["src/run/routing.ts"]);
    expect(r.dropped).toBe(2);
  });

  it("scout1 AC-12: the same path with another range is kept", () => {
    const r = checkEntries([item("src/run/routing.ts", "1-2"), item("src/run/routing.ts", "3"), item("src/run/routing.ts")], project);
    expect(r.kept.map(shown)).toEqual(["src/run/routing.ts:1-2", "src/run/routing.ts:3", "src/run/routing.ts"]);
    expect(r.dropped).toBe(0);
  });
});

describe("entry checks: each step drops and keeps the other entries (scout1 AC-12)", () => {
  it("scout1 AC-12: an empty path after trim is dropped; a padded path is trimmed", () => {
    const r = checkEntries([item(""), item("   "), item("  a.ts  ")], extra);
    expect(r.kept.map(shown)).toEqual(["a.ts"]);
    expect(r.dropped).toBe(2);
  });

  it("scout1 AC-12: an unsafe character or a backtick drops the entry", () => {
    // Code points, so the test source holds no raw control or bidi character.
    const points = [0x00, 0x1f, 0x7f, 0x9f, 0x200e, 0x200f, 0x2028, 0x2029, 0x202a, 0x202e, 0x2066, 0x2069, 0x0a, 0x09, 0x60];
    for (const p of points) {
      const c = String.fromCodePoint(p);
      const r = checkEntries([item(`a${c}.ts`), item("a.ts")], extra);
      expect(r.kept.map(shown), p.toString(16)).toEqual(["a.ts"]);
      expect(r.dropped, p.toString(16)).toBe(1);
    }
  });

  it("scout1 AC-12: a path longer than 300 code points is dropped; 300 is checked further", () => {
    const long = `${"d/".repeat(149)}xy`; // 300 code points
    expect([...long]).toHaveLength(300);
    expect(checkEntries([item(`${long}z`)], extra).dropped).toBe(1);
    // 300 code points passes step 2 and is dropped only because it does not exist (step 5).
    expect(checkEntries([item(long)], extra).dropped).toBe(1);
    // code points, not UTF-16 units: this path is 189 code points but 369 UTF-16 units.
    const part = String.fromCodePoint(0x1f600).repeat(60);
    const astral = `astral/${part}/${part}/${part}`;
    expect([...astral]).toHaveLength(189);
    expect(astral.length).toBeGreaterThan(300);
    mkdirSync(join(extra, "astral", part, part), { recursive: true });
    writeFileSync(join(extra, astral), "x\n");
    expect(checkEntries([item(astral)], extra).kept).toHaveLength(1);
  });

  it("scout1 AC-12: a leading \\, a `..` segment (/ or \\), and `.//x` after the strip are dropped", () => {
    for (const p of ["\\a.ts", "a/../a.ts", "a\\..\\a.ts", "..", "x/..", ".//a.ts", "././/a.ts"]) {
      const r = checkEntries([item(p), item("a.ts")], extra);
      expect(r.kept.map(shown), p).toEqual(["a.ts"]);
    }
  });

  it("scout1 AC-12: every leading ./ and every trailing / are removed", () => {
    mkdirSync(join(extra, "folder"), { recursive: true });
    const r = checkEntries([item("././a.ts"), item("folder///", "1-2"), item("./././")], extra);
    expect(r.kept.map(shown)).toEqual(["a.ts", "folder"]);
    expect(r.dropped).toBe(1);
  });

  it("scout1 AC-12: a symlink out of the project, a dangling symlink, and a symlink to the root are dropped", () => {
    const r = checkEntries([item("out"), item("outdir"), item("dangling"), item("self"), item("a.ts")], extra);
    expect(r.kept.map(shown)).toEqual(["a.ts"]);
    expect(r.dropped).toBe(4);
  });

  it("scout1 AC-12: .git and paths under .git/ are dropped, compared without case", () => {
    const r = checkEntries([item(".git"), item(".git/HEAD"), item(".GIT/HEAD"), item(".Git"), item("a.ts")], extra);
    expect(r.kept.map(shown)).toEqual(["a.ts"]);
    expect(r.dropped).toBe(4);
  });
});

describe("entry checks: the limits of 100 checked items and 30 kept entries (scout1 AC-21)", () => {
  const files = (from: number, to: number): ScoutItem[] => Array.from({ length: to - from }, (_, i) => item(`f${from + i}.ts`));

  it("scout1 AC-21: more than 30 entries that pass give the first 30 kept and the rest dropped", () => {
    const r = checkEntries(files(0, 35), many);
    expect(r.kept.map(shown)).toEqual(files(0, 30).map((e) => e.path));
    expect(r.dropped).toBe(5);
  });

  it("scout1 AC-21: more than 100 items: only the first 100 are checked, every other item is dropped", () => {
    const items = [...Array.from({ length: 99 }, () => item("src/no-such.ts")), item("f0.ts"), item("f1.ts"), ...files(2, 20)];
    const r = checkEntries(items, many);
    expect(r.kept.map(shown)).toEqual(["f0.ts"]);
    expect(r.dropped).toBe(items.length - 1);
  });

  it("scout1 AC-21: 150 good items give 30 kept and 120 dropped; such a list is no schema failure", () => {
    const items = files(0, 150);
    expect(validateOutput("scout", { entries: items })).toBeNull();
    const r = checkEntries(items, many);
    expect(r.kept).toHaveLength(30);
    expect(r.kept[29]?.path).toBe("f29.ts");
    expect(r.dropped).toBe(120);
  });

  it("scout1 AC-21: dropped entries in the first 100 do not count toward the 30", () => {
    const items = [...Array.from({ length: 50 }, () => item("../x")), ...files(0, 40)];
    const r = checkEntries(items, many);
    expect(r.kept.map(shown)).toEqual(files(0, 30).map((e) => e.path));
    expect(r.dropped).toBe(60);
  });
});
