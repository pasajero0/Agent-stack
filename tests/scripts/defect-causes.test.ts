import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script without types
import { parseLog } from "../../scripts/defect-causes.mjs";

interface Row {
  line: number;
  n: number | null;
  date: string;
  cause: string;
  test: string;
}
interface Parsed {
  rows: Row[];
  errors: string[];
  noTable: boolean;
}
const parse = (text: string): Parsed => parseLog(text) as Parsed;

const HEAD = "| # | Date | Cause | Test |\n|---|---|---|---|\n";

describe("defect-causes parseLog", () => {
  it("causes1 AC-3: finds columns by header name in any order", () => {
    const r = parse("intro\n| Test | Cause | Date | # |\n| --- | --- | --- | --- |\n| planned: 0.6.0 | some-cause | 2026-01-02 | 07 |\n");
    expect(r.noTable).toBe(false);
    expect(r.errors).toEqual([]);
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]).toMatchObject({ n: 7, date: "2026-01-02", cause: "some-cause", test: "planned: 0.6.0" });
  });

  it("causes1 AC-3: header needs a separator line", () => {
    const r = parse("| # | Date | Cause | Test |\n| 1 | d | c | t |\n");
    expect(r.noTable).toBe(true);
  });

  it("causes1 AC-15: no table gives noTable true", () => {
    expect(parse("just text\n").noTable).toBe(true);
    expect(parse("| # | Date | Cause |\n|---|---|---|\n").noTable).toBe(true);
  });

  it("causes1 AC-24: reads only the first table and stops at the first non-| line", () => {
    const r = parse(
      `${HEAD}| 1 | d | a-b | tests/x.test.ts |\n| 2 | d | c | tests/y.test.ts |\nsummary\n| 3 | d | c | t |\n\n| # | Date | Cause | Test |\n|---|---|---|---|\n| 1 | | | |\n`,
    );
    expect(r.rows.map((x) => x.n)).toEqual([1, 2]);
    expect(r.errors).toEqual([]);
  });

  it("causes1 AC-25: escaped pipe stays in the cell as |", () => {
    const r = parse(`${HEAD}| 1 | d | c | a \\| b |\n`);
    expect(r.errors).toEqual([]);
    expect(r.rows[0].test).toBe("a | b");
  });

  it("causes1 AC-16: cell count error only, and not used for duplicates", () => {
    const r = parse(`${HEAD}| 1 | d | c |\n| 1 | d | c | t |\n`);
    expect(r.errors).toEqual(["defect-causes: row 1: 3 cells, the header has 4"]);
  });

  it("causes1 AC-16: # not a number uses line, other cells still checked", () => {
    const r = parse(`${HEAD}| +3 | | Bad_Cause | - |\n`);
    expect(r.errors).toEqual([
      "defect-causes: line 3: # is not a number",
      "defect-causes: line 3: Date is empty",
      'defect-causes: line 3: Cause "Bad_Cause" is not kebab-case',
      'defect-causes: line 3: Test "-" is not a test; write — or a test',
    ]);
  });

  it("causes1 AC-16: empty Cause gets only the empty line", () => {
    const r = parse(`${HEAD}| 2 | d | | t.test.ts |\n`);
    expect(r.errors).toEqual(["defect-causes: row 2: Cause is empty"]);
  });

  it("causes1 AC-16: wrong 'no test' forms", () => {
    for (const t of ["", "-", "–", "no", "No", "N/A", "n/a"]) {
      const r = parse(`${HEAD}| 4 | d | c | ${t} |\n`);
      expect(r.errors).toEqual([`defect-causes: row 4: Test "${t}" is not a test; write — or a test`]);
    }
  });

  it("causes1 AC-16: malformed planned", () => {
    for (const t of ["planned", "Planned: 1.2", "planned:1.2.3", "PLANNED: 1.2.3.4"]) {
      const r = parse(`${HEAD}| 5 | d | c | ${t} |\n`);
      expect(r.errors).toEqual([`defect-causes: row 5: Test "${t.trim()}" is not "planned: <version>"`]);
    }
    expect(parse(`${HEAD}| 5 | d | c | planned: 1.2.3 |\n`).errors).toEqual([]);
  });

  it("causes1 AC-16: duplicate # compared as numbers, after other lines, ascending", () => {
    const r = parse(`${HEAD}| 9 | d | c | t |\n| 7 | d | c | t |\n| 07 | | c | t |\n| 9 | d | c | t |\n| 9 | d | c | t |\n`);
    expect(r.errors).toEqual([
      "defect-causes: row 7: Date is empty",
      "defect-causes: row 7: # is used by another row",
      "defect-causes: row 9: # is used by another row",
    ]);
  });
});
