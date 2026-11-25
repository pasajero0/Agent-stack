/**
 * The scout step (scout1). This part holds the entry checks: the driver's pure checks on the scout's map
 * entries (Contract "Entry checks", AC-12, AC-21). They read no file content: at most 100 items are checked,
 * each with at most one `lstat` and one `realpath`. It also holds the scout map text (the writer, AC-22) and
 * the map reader (AC-17): the two sides of one entry-line form.
 */
import { lstatSync, readFileSync, realpathSync, type Stats } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** One item of the scout's output, after the schema check. */
export interface ScoutItem {
  path: string;
  lines?: string;
  why: string;
}

/** A map entry that passed the entry checks. `range` is `<a>` or `<a>-<b>`, or absent (whole file or folder). */
export interface KeptEntry {
  path: string;
  range?: string;
  why: string;
}

export interface CheckedEntries {
  /** The kept entries, in the order of the output (at most 30). */
  kept: KeptEntry[];
  /** Every other item: failed a check, a duplicate, after the 30th kept entry, or after the 100th item. */
  dropped: number;
}

/** Only the first 100 items are checked; later items are dropped entries without a check. */
export const MAX_CHECKED = 100;
/** Only the first 30 kept entries stay. */
export const MAX_KEPT = 30;
const MAX_PATH_CODE_POINTS = 300;

/** Unsafe characters (local term of scout1): control, line-separator and bidi characters, as code point ranges. */
const UNSAFE_RANGES: readonly (readonly [number, number])[] = [
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x200e, 0x200f],
  [0x2028, 0x2029],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
];
const hex = (n: number): string => `\\u{${n.toString(16)}}`;
/** Matches one unsafe character (built from UNSAFE_RANGES, so the source holds no raw control character). */
export const UNSAFE = new RegExp(`[${UNSAFE_RANGES.map(([a, b]) => `${hex(a)}-${hex(b)}`).join("")}]`, "u");
const RANGE = /^([1-9][0-9]{0,6})(?:-([1-9][0-9]{0,6}))?$/;

/** Step 3: absolute (`/` or `\` first) or a `..` segment. */
const escapes = (p: string): boolean => p.startsWith("/") || p.startsWith("\\") || p.split(/[/\\]/).includes("..");

/** Step 4: remove every leading `./` and every trailing `/`. */
function strip(p: string): string {
  let s = p;
  while (s.startsWith("./")) s = s.slice(2);
  while (s.endsWith("/")) s = s.slice(0, -1);
  return s;
}

/** Step 6: the real path is inside the real project folder, is not that folder, and is not `.git` or under it. */
function placeOk(real: string, realRoot: string): boolean {
  const rel = relative(realRoot, real);
  if (rel === "" || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) return false;
  return rel.split(sep)[0]?.toLowerCase() !== ".git";
}

/** Step 7: the range of a file entry, or undefined (a bad `lines` never drops the entry). */
function rangeOf(lines: string | undefined): string | undefined {
  const m = lines === undefined ? null : RANGE.exec(lines.trim());
  if (m === null) return undefined;
  const a = Number(m[1]);
  const b = m[2] === undefined ? a : Number(m[2]);
  if (a > b) return undefined;
  return a === b ? `${a}` : `${a}-${b}`;
}

/** Steps 1–6 for one item: its path after step 4, and whether it is a folder; null when a step drops it. */
function checkPath(raw: string, projectDir: string, realRoot: string | null): { path: string; folder: boolean } | null {
  const trimmed = raw.trim();
  if (trimmed === "") return null;
  if (UNSAFE.test(trimmed) || trimmed.includes("`") || [...trimmed].length > MAX_PATH_CODE_POINTS) return null;
  if (escapes(trimmed)) return null;
  const path = strip(trimmed);
  if (path === "" || path === "." || escapes(path)) return null;
  const abs = resolve(projectDir, path);
  let stats: Stats;
  try {
    stats = lstatSync(abs);
  } catch {
    return null;
  }
  if (realRoot === null) return null;
  let real: string;
  try {
    real = realpathSync.native(abs);
  } catch {
    return null;
  }
  if (!placeOk(real, realRoot)) return null;
  return { path, folder: stats.isDirectory() };
}

/**
 * Runs the entry checks (steps 1–9 of the Contract, in order) on the scout's items. The first step that fails
 * drops the item. Returns the kept entries and the count of every other item.
 */
export function checkEntries(items: readonly ScoutItem[], projectDir: string): CheckedEntries {
  let realRoot: string | null;
  try {
    realRoot = realpathSync.native(projectDir);
  } catch {
    realRoot = null;
  }
  const kept: KeptEntry[] = [];
  const seen = new Set<string>();
  for (const item of items.slice(0, MAX_CHECKED)) {
    const place = checkPath(item.path, projectDir, realRoot);
    if (place === null) continue;
    const range = place.folder ? undefined : rangeOf(item.lines);
    // Step 8: path and range; a NUL cannot be in a kept path (step 2), so the key is unique.
    const key = `${place.path}\0${range ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    if (kept.length >= MAX_KEPT) continue;
    kept.push(range === undefined ? { path: place.path, why: item.why } : { path: place.path, range, why: item.why });
  }
  return { kept, dropped: items.length - kept.length };
}

const MAX_WHY_CODE_POINTS = 200;
const NO_REASON = "(no reason given)";
const UNSAFE_ALL = new RegExp(UNSAFE.source, "gu");

/**
 * The `why` of a kept entry as the scout map holds it (AC-22): every whitespace run becomes one space (this covers
 * a newline, U+2028 and U+2029), each other unsafe character becomes `?`, then trim; above 200 code points it is
 * its first 199 code points and `…`; empty becomes `(no reason given)`.
 */
export function cleanWhy(why: string): string {
  const text = why.replace(/\s+/gu, " ").replace(UNSAFE_ALL, "?").trim();
  const points = [...text];
  if (points.length > MAX_WHY_CODE_POINTS) return `${points.slice(0, MAX_WHY_CODE_POINTS - 1).join("")}…`;
  return text === "" ? NO_REASON : text;
}

/** The entry line of a kept entry: ``- `<path>` — <why>`` or ``- `<path>:<range>` — <why>``. */
function entryLine(e: KeptEntry): string {
  const place = e.range === undefined ? e.path : `${e.path}:${e.range}`;
  return `- \`${place}\` — ${cleanWhy(e.why)}`;
}

/**
 * The scout map text (Contract "The scout map's layout"): `# Scout map`, an empty line, the header, an empty line,
 * one entry line per kept entry in order. Every line ends with `\n`.
 */
export function mapText(runId: string, model: string, effort: string, kept: readonly KeptEntry[]): string {
  const places = kept.length === 1 ? "1 place" : `${kept.length} places`;
  const lines = ["# Scout map", "", `Run ${runId} · ${model} · ${effort} · ${places}`, "", ...kept.map(entryLine)];
  return `${lines.join("\n")}\n`;
}

const ENTRY_LINE = /^- `[^`]+` — .+$/u;
const MAX_LINE_CODE_POINTS = 600;

/**
 * The map reader (Contract "The map section", AC-17): the entry lines of the scout map, in order, at most the
 * first 30. An entry line matches ``^- `[^`]+` — .+$``, holds no unsafe character and has at most 600 code points;
 * every other line is ignored. A missing or unreadable file gives no lines. The paths are not checked again.
 */
export function readMapLines(file: string): string[] {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const line of text.split("\n")) {
    if (out.length >= MAX_KEPT) break;
    if (!ENTRY_LINE.test(line) || UNSAFE.test(line) || [...line].length > MAX_LINE_CODE_POINTS) continue;
    out.push(line);
  }
  return out;
}
