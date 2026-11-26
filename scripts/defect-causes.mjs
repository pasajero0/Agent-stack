#!/usr/bin/env node
// Defect causes: reads the defect log's table (columns #, Date, Cause, Test). Plain Node ESM, built-ins only.
// parseLog(text) -> { rows, errors, noTable }. It reads the first table with those columns and stops at the
// first line after it that does not start with `|`. Each problem is one stderr-ready line.

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The repo root, from this script's own path (scripts/ is one level below it).
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const COLUMNS =["#", "Date", "Cause", "Test"];

// Split one table line into trimmed cells; `\|` stays in the cell as `|`.
function splitRow(line) {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  const cells = [];
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && s[i + 1] === "|") {
      cur += "|";
      i++;
    } else if (c === "|") {
      cells.push(cur.trim());
      cur = "";
    } else {
      cur += c;
    }
  }
  // Text after the last unescaped `|` is a cell only when it is not empty (a line may lack the closing `|`).
  if (cur.trim() !== "") cells.push(cur.trim());
  return cells;
}

const isSeparator = (line) => {
  if (!line.trim().startsWith("|")) return false;
  const cells = splitRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-+:?$/.test(c));
};

export function parseLog(text) {
  const lines = text.split(/\r?\n/);
  let start = -1;
  let header = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    if (!lines[i].trim().startsWith("|") || !isSeparator(lines[i + 1])) continue;
    const cells = splitRow(lines[i]);
    if (COLUMNS.every((c) => cells.includes(c))) {
      start = i;
      header = cells;
      break;
    }
  }
  if (start < 0) return { rows: [], errors: [], noTable: true };

  const idx = Object.fromEntries(COLUMNS.map((c) => [c, header.indexOf(c)]));
  const rows = [];
  const errors = [];
  const seen = new Map();
  for (let i = start + 2; i < lines.length && lines[i].startsWith("|"); i++) {
    const line = i + 1;
    const cells = splitRow(lines[i]);
    const numCell = cells[idx["#"]] ?? "";
    const isNum = /^[0-9]+$/.test(numCell);
    const n = isNum ? Number(numCell) : null;
    const date = cells[idx.Date] ?? "";
    const cause = cells[idx.Cause] ?? "";
    const test = cells[idx.Test] ?? "";
    rows.push({ line, n, date, cause, test });
    const where = isNum ? `row ${n}` : `line ${line}`;
    const p = (msg) => errors.push(`defect-causes: ${msg}`);
    if (cells.length !== header.length) {
      p(`${where}: ${cells.length} cells, the header has ${header.length}`);
      continue;
    }
    if (!isNum) p(`line ${line}: # is not a number`);
    if (date === "") p(`${where}: Date is empty`);
    if (cause === "") p(`${where}: Cause is empty`);
    else if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(cause)) p(`${where}: Cause "${cause}" is not kebab-case`);
    if (test === "" || test === "-" || test === "–" || /^(no|n\/a)$/i.test(test)) {
      p(`${where}: Test "${test}" is not a test; write — or a test`);
    } else if (/^planned/i.test(test) && !/^planned: [0-9]+\.[0-9]+\.[0-9]+$/.test(test)) {
      p(`${where}: Test "${test}" is not "planned: <version>"`);
    }
    if (isNum) seen.set(n, (seen.get(n) ?? 0) + 1);
  }
  for (const n of [...seen.keys()].sort((a, b) => a - b)) {
    if (seen.get(n) > 1) errors.push(`defect-causes: row ${n}: # is used by another row`);
  }
  return { rows, errors, noTable: false };
}

const isPlanned = (test) => /^planned/i.test(test);
const isTested = (test) => test !== "—" && !isPlanned(test);

// Count rows by cause: [{ cause, count, last, tested, planned, rows }], most rows first, then cause by `<`.
export function countCauses(rows) {
  const by = new Map();
  for (const r of rows) {
    let e = by.get(r.cause);
    if (!e) {
      e = { cause: r.cause, count: 0, last: "", tested: 0, planned: 0, rows: [], lastN: -Infinity };
      by.set(r.cause, e);
    }
    e.count++;
    if (r.n > e.lastN) {
      e.lastN = r.n;
      e.last = r.date;
    }
    if (isTested(r.test)) e.tested++;
    else if (isPlanned(r.test)) e.planned++;
    e.rows.push(r.n);
  }
  return [...by.values()]
    .map(({ lastN, ...e }) => ({ ...e, rows: e.rows.sort((a, b) => a - b) }))
    .sort((a, b) => b.count - a.count || (a.cause < b.cause ? -1 : a.cause > b.cause ? 1 : 0));
}

// A failing cause: 3 or more rows, no tested row, no planned check.
export const failingCauses = (counts) => counts.filter((c) => c.count >= 3 && c.tested === 0 && c.planned === 0);

const USAGE = "usage: node scripts/defect-causes.mjs [--check] [--file <path>]";
const DEFAULT_PATH = "docs/defects.md";

function table(counts) {
  const head = ["cause", "count", "last", "tested", "planned", "rows"];
  const right = [false, true, false, true, true, false];
  const body = counts.map((c) => [c.cause, String(c.count), c.last, String(c.tested), String(c.planned), c.rows.join(",")]);
  const all = [head, ...body];
  const widths = head.map((_, i) => Math.max(...all.map((r) => r[i].length)));
  return all.map((r) => r.map((v, i) => (right[i] ? v.padStart(widths[i]) : v.padEnd(widths[i]))).join("  ").trimEnd());
}

// main(argv, readFile) -> { stdout, stderr, code }; argv excludes node and the script path.
export function main(argv, readFile) {
  let check = false;
  let file = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") check = true;
    else if (a === "--file") {
      if (i + 1 >= argv.length) return { stdout: "", stderr: "defect-causes: --file needs a path\n", code: 2 };
      file = argv[++i];
    } else {
      return { stdout: "", stderr: `defect-causes: unknown option ${a}\n${USAGE}\n`, code: 2 };
    }
  }
  const shown = file ?? DEFAULT_PATH;
  let text;
  try {
    text = readFile(file ?? join(ROOT, DEFAULT_PATH));
  } catch {
    return { stdout: "", stderr: `defect-causes: cannot read ${shown}\n`, code: 2 };
  }
  const parsed = parseLog(text);
  if (parsed.noTable) {
    return { stdout: "", stderr: `defect-causes: no table with the columns #, Date, Cause and Test in ${shown}\n`, code: 2 };
  }
  if (parsed.errors.length > 0) return { stdout: "", stderr: parsed.errors.map((e) => `${e}\n`).join(""), code: 2 };

  const counts = countCauses(parsed.rows);
  const out = table(counts);
  if (!check) return { stdout: out.join("\n") + "\n", stderr: "", code: 0 };
  const failing = failingCauses(counts);
  if (failing.length === 0) return { stdout: [...out, "defect-causes: check ok"].join("\n") + "\n", stderr: "", code: 0 };
  const err = failing.map((c) => `defect-causes: ${c.cause} has ${c.count} rows and no test or planned check (rows ${c.rows.join(",")})\n`);
  return { stdout: out.join("\n") + "\n", stderr: err.join(""), code: 1 };
}

// Run only as the entry script.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const r = main(process.argv.slice(2), (p) => readFileSync(p, "utf8"));
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  process.exitCode = r.code;
}
