#!/usr/bin/env node
// Defect causes: reads the defect log's table (columns #, Date, Cause, Test). Plain Node ESM, built-ins only.
// parseLog(text) -> { rows, errors, noTable }. It reads the first table with those columns and stops at the
// first line after it that does not start with `|`. Each problem is one stderr-ready line.

const COLUMNS = ["#", "Date", "Cause", "Test"];

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
