import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-expect-error plain .mjs script without types
import { countCauses, failingCauses, main, parseLog } from "../../scripts/defect-causes.mjs";

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

interface Count {
  cause: string;
  count: number;
  last: string;
  tested: number;
  planned: number;
  rows: number[];
}
interface Out {
  stdout: string;
  stderr: string;
  code: number;
}
const counts = (rows: Omit<Row, "line">[]): Count[] => countCauses(rows.map((r, i) => ({ line: i + 3, ...r }))) as Count[];
const run = (argv: string[], text: string): Out => main(argv, () => text) as Out;
const lines = (s: string): string[] => s.split("\n").filter((l) => l !== "");
const fields = (l: string): string[] => l.split(/\s{2,}/);
const log = (...rows: string[]): string => `${HEAD}${rows.map((r) => `${r}\n`).join("")}`;

describe("defect-causes countCauses and main", () => {
  it("causes1 AC-4: counts, last by highest n, tested, planned, rows ascending", () => {
    const c = counts([
      { n: 5, date: "05/11", cause: "a", test: "—" },
      { n: 2, date: "02/11", cause: "a", test: "t.test.ts" },
      { n: 9, date: "09/11", cause: "a", test: "planned: 0.5.3" },
      { n: 1, date: "01/11", cause: "b", test: "yes" },
    ]);
    expect(c).toEqual([
      { cause: "a", count: 3, last: "09/11", tested: 1, planned: 1, rows: [2, 5, 9] },
      { cause: "b", count: 1, last: "01/11", tested: 1, planned: 0, rows: [1] },
    ]);
  });

  it("causes1 AC-5: sorts by count desc, then cause by UTF-16 <", () => {
    const r = (n: number, cause: string) => ({ n, date: "d", cause, test: "—" });
    const c = counts([r(1, "b"), r(2, "a"), r(3, "a"), r(4, "Z"), r(5, "z"), r(6, "c")]);
    expect(c.map((x) => x.cause)).toEqual(["a", "Z", "b", "c", "z"]);
  });

  it("causes1 AC-7: yes, yes (text) and a path are tested; — and planned are not", () => {
    const c = counts(["yes", "yes (x)", "tests/a.test.ts", "—", "planned: 1.2.3"].map((test, i) => ({ n: i + 1, date: "d", cause: "c", test })));
    expect(c[0]).toMatchObject({ count: 5, tested: 3, planned: 1 });
  });

  it("causes1 AC-6: prints header and one line per cause, aligned, no trailing spaces", () => {
    const r = run(
      [],
      log("| 1 | 01/11 | bb | — |", "| 2 | 02/11 | aaaa | yes |", "| 3 | 03/11 | aaaa | planned: 0.5.3 |", "| 10 | 10/11 | aaaa | — |"),
    );
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    const ls = lines(r.stdout);
    expect(ls.map(fields)).toEqual([
      ["cause", "count", "last", "tested", "planned", "rows"],
      ["aaaa", "3", "10/11", "1", "1", "2,3,10"],
      ["bb", "1", "01/11", "0", "0", "1"],
    ]);
    for (const l of ls) expect(l).toBe(l.trimEnd());
    // padded to the widest value, joined by two spaces; count right-aligned, cause left-aligned
    expect(ls[0]).toBe("cause  count  last   tested  planned  rows");
    expect(ls[1]).toBe("aaaa       3  10/11       1        1  2,3,10");
    expect(ls[2]).toBe("bb         1  01/11       0        0  1");
  });

  it("causes1 AC-7: a — row is untested, a planned row is not tested in the table", () => {
    const r = run([], log("| 1 | d | c | — |", "| 2 | d | c | planned: 0.5.3 |", "| 3 | d | c | yes |"));
    expect(fields(lines(r.stdout)[1])).toEqual(["c", "3", "d", "1", "1", "1,2,3"]);
  });

  it("causes1 AC-8: --check with no failing cause prints the table, then check ok", () => {
    const r = run(["--check"], log("| 1 | d | c | yes |"));
    expect(r.code).toBe(0);
    expect(lines(r.stdout)).toHaveLength(3);
    expect(lines(r.stdout)[2]).toBe("defect-causes: check ok");
  });

  it("causes1 AC-10: planned or tested closes a 3-row cause; planned counts in planned", () => {
    for (const t of ["yes", "planned: 0.5.3"]) {
      const text = log("| 1 | d | c | — |", "| 2 | d | c | — |", `| 3 | d | c | ${t} |`);
      const r = run(["--check"], text);
      expect(r.code).toBe(0);
      expect(r.stderr).toBe("");
    }
    const c = counts([1, 2, 3].map((n) => ({ n, date: "d", cause: "c", test: n === 3 ? "planned: 0.5.3" : "—" })));
    expect(c[0]).toMatchObject({ tested: 0, planned: 1 });
    expect(failingCauses(c)).toEqual([]);
  });

  it("causes1 AC-10: failingCauses names a 3-row cause with no tested and no planned row", () => {
    const c = counts([1, 2, 3].map((n) => ({ n, date: "d", cause: "c", test: "—" })));
    expect(failingCauses(c)).toEqual(c);
  });

  it("causes1 AC-23: 2 untested rows are not failing", () => {
    const r = run(["--check"], log("| 1 | d | c | — |", "| 2 | d | c | — |"));
    expect(r.code).toBe(0);
    expect(r.stderr).toBe("");
    expect(failingCauses(counts([1, 2].map((n) => ({ n, date: "d", cause: "c", test: "—" }))))).toEqual([]);
  });

  it("causes1 AC-9: --check with failing causes prints the table, one stderr line per cause, code 1", () => {
    const text = log(
      "| 1 | d | big | — |", "| 2 | d | big | — |", "| 3 | d | big | — |", "| 4 | d | big | — |",
      "| 5 | d | aaa | — |", "| 6 | d | aaa | — |", "| 7 | d | aaa | — |",
      "| 8 | d | ok | — |",
    );
    const r = run(["--check"], text);
    expect(r.code).toBe(1);
    expect(lines(r.stdout).map(fields)[1][0]).toBe("big");
    expect(r.stderr).toBe(
      "defect-causes: big has 4 rows and no test or planned check (rows 1,2,3,4)\n" +
        "defect-causes: aaa has 3 rows and no test or planned check (rows 5,6,7)\n",
    );
  });

  it("causes1 AC-22: header only prints only the header; --check adds check ok", () => {
    const a = run([], HEAD);
    expect(a.code).toBe(0);
    expect(lines(a.stdout).map(fields)).toEqual([["cause", "count", "last", "tested", "planned", "rows"]]);
    const b = run(["--check"], HEAD);
    expect(b.code).toBe(0);
    expect(lines(b.stdout)[1]).toBe("defect-causes: check ok");
    expect(lines(b.stdout)).toHaveLength(2);
  });

  it("causes1 AC-11: --file reads that path; last --file wins; --file --check reads a file named --check; --check twice", () => {
    const seen: string[] = [];
    const rf = (p: string): string => {
      seen.push(p);
      return log("| 1 | d | c | yes |");
    };
    main(["--file", "a.md"], rf);
    main(["--file", "a.md", "--file", "b.md"], rf);
    const r = main(["--file", "--check"], rf) as Out;
    expect(seen).toEqual(["a.md", "b.md", "--check"]);
    expect(lines(r.stdout)).toHaveLength(2); // no check ok line: --check was a path
    const one = run(["--check"], log("| 1 | d | c | yes |"));
    const two = run(["--check", "--check"], log("| 1 | d | c | yes |"));
    expect(two).toEqual(one);
  });

  it("causes1 AC-11: the default path is docs/defects.md under the repo root", () => {
    const seen: string[] = [];
    main([], (p: string) => (seen.push(p), HEAD));
    expect(seen).toHaveLength(1);
    expect(seen[0].replace(/\\/g, "/")).toMatch(/\/docs\/defects\.md$/);
  });

  it("causes1 AC-14: cannot read <path> on stderr, exit 2", () => {
    const boom = (): string => {
      throw new Error("ENOENT");
    };
    expect(main(["--file", "x/y.md"], boom)).toEqual({ stdout: "", stderr: "defect-causes: cannot read x/y.md\n", code: 2 });
    expect((main([], boom) as Out).stderr).toBe("defect-causes: cannot read docs/defects.md\n");
  });

  it("causes1 AC-14: --file without a path", () => {
    let called = 0;
    const rf = (): string => (called++, HEAD);
    expect(main(["--check", "--file"], rf)).toEqual({ stdout: "", stderr: "defect-causes: --file needs a path\n", code: 2 });
    expect(called).toBe(0);
  });

  it("causes1 AC-14: args are read left to right, the first wrong one only, file not read", () => {
    let called = 0;
    const rf = (): string => (called++, HEAD);
    const a = main(["--bogus", "--file"], rf) as Out;
    expect(a.stderr).toBe("defect-causes: unknown option --bogus\nusage: node scripts/defect-causes.mjs [--check] [--file <path>]\n");
    const b = main(["--file"], rf) as Out;
    expect(b.stderr).toBe("defect-causes: --file needs a path\n");
    const c = main(["--file", "x", "--bogus"], rf) as Out;
    expect(c.stderr).toContain("unknown option --bogus");
    expect(called).toBe(0);
  });

  it("causes1 AC-18: unknown option and usage line, exit 2", () => {
    const r = run(["-x"], HEAD);
    expect(r).toEqual({
      stdout: "",
      stderr: "defect-causes: unknown option -x\nusage: node scripts/defect-causes.mjs [--check] [--file <path>]\n",
      code: 2,
    });
  });

  it("causes1 AC-12: package.json has the defects script", () => {
    const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { scripts: Record<string, string> };
    expect(pkg.scripts.defects).toBe("node scripts/defect-causes.mjs");
  });
});
